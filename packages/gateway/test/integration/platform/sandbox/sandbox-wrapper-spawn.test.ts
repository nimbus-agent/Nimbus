import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { canonicalPath } from "../../../../src/platform/sandbox/canonical-path.ts";
import { generateSbplProfile } from "../../../../src/platform/sandbox/darwin.ts";
import {
  SANDBOX_CWD_ENV,
  SANDBOX_POLICY_ENV,
  type SandboxPolicy,
} from "../../../../src/platform/sandbox/sandbox-policy.ts";

/**
 * Real, end-to-end spawns through the `__nimbus-sandbox` role, on every platform Nimbus ships on.
 *
 * Nothing else in the suite does this. `sandbox-helper-strace.test.ts` (Linux-only) straces the
 * raw native helper binary directly — it never goes through `sandbox-wrapper.ts`, and it says
 * nothing about Windows or macOS at all. That gap is exactly what let a broken Windows spawn path
 * (Task 5's fix) survive a green three-OS CI matrix: nothing in CI ever spawned through this role
 * for real on any OS but Linux. This file closes that hole.
 */

const GATEWAY_ENTRY = resolve(import.meta.dir, "../../../../src/index.ts");

/**
 * On Windows the helper must exist for the spawn to be permitted at all (I15 fail-closed).
 * Same override precedence `helperPath()` (win32.ts) uses in production, so this test's own
 * readiness check and the child gateway process it spawns always agree on which binary is meant.
 */
const WIN_HELPER =
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] ??
  resolve(import.meta.dir, "../../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe");
/**
 * Resolve `bwrap` the way the Linux runner does — through `PATH` — rather than at a fixed
 * `/usr/bin/bwrap`. The guard must answer the same question production asks ("can this spawn
 * find bwrap?"); a path check answers a narrower one, and on any distro that installs it
 * elsewhere (`/usr/local/bin` on a source build, Nix, a container image with a different prefix)
 * the two disagree — the guard would hard-fail CI on a machine where every case would have passed.
 */
function findBwrap(): string | null {
  const r = spawnSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" });
  const p = (r.stdout ?? "").trim();
  return r.status === 0 && p !== "" ? p : null;
}
const IS_WIN = process.platform === "win32";

/**
 * True in every CI job (GitHub Actions sets `CI=true` on every hosted runner; the repo's own
 * convention — see `reindex-vector-erasure.test.ts`, `item-list-query-latency.test.ts` — reads it
 * the same way). Never true in a plain local `bun test` invocation.
 */
const IS_CI = process.env["CI"] === "true";

/**
 * `null` when this platform can actually run a real sandboxed spawn; otherwise the exact reason,
 * named precisely enough to act on (never a bare "precondition unmet").
 *
 * This distinction is the whole point of Fix 2 below: a missing dependency must never be
 * indistinguishable from "everything passed" in a CI summary — that indistinguishability is
 * exactly what let the original Windows defect survive a green three-OS matrix.
 */
function missingPrerequisite(): string | null {
  if (IS_WIN) {
    return existsSync(WIN_HELPER) ? null : `Windows sandbox helper not found at ${WIN_HELPER}`;
  }
  if (process.platform === "linux") {
    return findBwrap() === null ? "bwrap not found on PATH" : null;
  }
  return null; // macOS: sandbox-exec ships by default, nothing to install.
}

const MISSING = missingPrerequisite();
const READY = MISSING === null;

/**
 * Sandbox-denied exit code used by every out-of-policy child script below.
 *
 * A bare uncaught exception is not good enough here: measured on Bun 1.3.14, a synchronous
 * uncaught exception does not reliably produce a non-zero exit code, so asserting merely
 * `status !== 0` after one can pass while testing nothing — in the one assertion that
 * distinguishes a sandbox test from a mere spawn test. Every "refused" child below instead uses
 * an explicit try/catch that exits with one of these two distinctive codes, and the test asserts
 * the exact denied code, not just non-zero — so "correctly denied" is distinguishable from "the
 * process died for some other reason".
 */
const DENIED_CODE = 77;
const UNEXPECTED_SUCCESS_CODE = 0;

// Real, unique temp root — never a subdirectory of the live Gateway data dir
// (%LOCALAPPDATA%\Nimbus / %APPDATA%\Nimbus), which is read-only test-data territory. Removed in
// afterAll by its own full path only (see the temp-dir leak audit, #972/#973).
//
// realpathSync'd immediately: on macOS, mkdtempSync(tmpdir()) returns a `/var/folders/...` path,
// but the SBPL profile's `subpath` matching (darwin.ts) sees the kernel-resolved
// `/private/var/folders/...` — `/var` is itself a symlink to `/private/var`. Granting the
// unresolved path and then using it as both the SBPL subpath AND the child's actual cwd leaves
// the two disagreeing, so the sandbox denies a spawn this policy is supposed to allow. Resolving
// once here keeps every derived path (`work`, `outside`) consistent with what the kernel sees.
const root = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-wrapper-spawn-")));
const work = join(root, "work");
const outside = join(root, "outside");
mkdirSync(work, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, "secret.txt"), "do-not-read-me");

/**
 * Directory containing the Linux/macOS sandboxed child binary (`process.execPath`, i.e. the Bun
 * binary itself — see `childProcess()` below). Not bound by any of `buildBwrapArgv`'s fixed
 * binds (`/usr`, `/etc`, `/lib`[64], `/dev`, tmpfs `/tmp`, cwd) on a GitHub-hosted runner, where
 * `oven-sh/setup-bun` installs Bun under `~/.bun` — outside all of them. Reachability has to come
 * from the policy itself, which is the mechanism this suite exists to exercise, so the policy
 * below grants read access to this directory explicitly rather than the test being made to pass
 * only inside a container image that happens to place Bun under `/usr/local/bin`.
 */
const childBinaryDir = dirname(process.execPath);

/**
 * The runtime's own home tree — `~/.bun`, one level above `~/.bun/bin`.
 *
 * Bun reads its global config and cache at startup (`bunfig.toml`, `install/cache`), not only the
 * binary out of `bin/`. Granting the binary's directory alone leaves those denied, and on macOS
 * the result is an abort with no stderr rather than a diagnosable error.
 *
 * Declared in the POLICY rather than baked into the SBPL profile on purpose: this is a statement
 * about what this particular child needs, which is exactly what a policy is for. The production
 * macOS child is a compiled binary with no such tree, so putting it in the profile would grant
 * every extension a path only this test's child uses.
 */
const childRuntimeHome = dirname(childBinaryDir);

/**
 * darwin ONLY. On Windows the helper writes an ACE per granted path, and `~/.bun` carries
 * `install/cache` — thousands of entries. Granting it there made every spawn hang until the test
 * timeout killed it (`status: null`, no output), turning a macOS fix into a Windows regression.
 * The Windows child is `powershell.exe` and needs nothing from the Bun tree anyway.
 */
const RUNTIME_HOME_GRANT = process.platform === "darwin" ? [childRuntimeHome] : [];

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function policy(): SandboxPolicy {
  return {
    id: "com.nimbus.wrapper-test",
    permissions: {
      network: [],
      filesystem: { read: [work, childBinaryDir, ...RUNTIME_HOME_GRANT], write: [work] },
    },
  };
}

interface WrapperRun {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly policy: SandboxPolicy;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Should this invocation be dumped? Answered from the SHAPE of the run, never from a list of
 * known error strings.
 *
 * The first version of this matched `["bwrap:", "nimbus-sandbox-wrapper:"]` against stderr — the
 * Linux launcher and the cross-platform wrapper. It was blind on exactly the two platforms that
 * then failed on the push matrix: macOS launches through `sandbox-exec` and Windows through
 * `nimbus-sandbox-helper.exe`, and neither prefix was listed. Both runs reported a bare
 * `Expected: "hello-from-sandbox" / Received: ""` with the reason nowhere in the log. An
 * allow-list of failure signatures is the wrong shape for a diagnostic: it can only recognise
 * failures someone already thought of, and it fails silent on the rest.
 *
 * So: dump on anything ANOMALOUS, and let the green path define normal.
 *  - any stderr at all — no launcher on any platform prints on a clean launch;
 *  - `status === null` — killed by a signal, which no case here expects;
 *  - exit 0 with empty stdout — the shape of "the child never really ran". The two cases that
 *    legitimately produce empty stdout exit 7 and 77, so neither trips this.
 *
 * Verified quiet: the five passing cases on this machine produce no dump.
 */
function isAnomalous(run: WrapperRun): boolean {
  // ON CI, DUMP EVERY RUN. Not a placeholder — a decision made after this predicate went blind
  // TWICE on the same suite:
  //   1. matching stderr against ["bwrap:", "nimbus-sandbox-wrapper:"] missed macOS's
  //      `sandbox-exec` and Windows's `nimbus-sandbox-helper.exe` entirely;
  //   2. the shape-based rewrite below still missed the real macOS failure, which is exit 134
  //      (SIGABRT, translated by the wrapper's signal handler) with EMPTY stdout AND EMPTY
  //      stderr — non-zero, non-null, and not exit-0, so it satisfied no clause.
  // Every attempt to predict which runs are worth reporting has failed against a runner nobody
  // can log into, and each failure cost a full merge-and-revert cycle. Five runs of ~12 lines is
  // a trivial price for never paying that again. Local runs keep the quiet heuristic.
  if (IS_CI) return true;
  if (run.stderr.trim() !== "") return true;
  if (run.status === null) return true;
  return run.status === 0 && run.stdout === "";
}

/**
 * Dump everything about an invocation whose sandbox launcher errored.
 *
 * The launcher writes its diagnosis to STDERR, but every assertion below is about `status` or
 * `stdout`, so without this the stderr is captured and then discarded: the first CI run of this
 * suite reported only `Expected: 7 / Received: 1` and `JSON Parse error: Unexpected EOF`, and the
 * one line that said WHY (`bwrap: No permissions to create new namespace`) never reached the log.
 * A spawn test that cannot tell you why the spawn failed is close to undebuggable on a runner you
 * cannot log into.
 *
 * Deliberately NOT implemented by wrapping each `it` in a try/catch that re-throws: Bun's reporter
 * prints the code frame of the site that threw LAST, so any re-throw — even of the untouched
 * error — replaces the failing assertion's line with the wrapper's (measured, not assumed).
 * Printing from here keeps every frame pointing at the assertion that failed.
 */
/**
 * On darwin, re-run the identical spawn with the sandbox effectively OFF and report whether it
 * then succeeds.
 *
 * This is the one question the existing diagnostics could not answer. A `status: 134` with EMPTY
 * stderr says the child aborted before it could say anything, and that has two very different
 * causes: the SBPL profile denied something the runtime needs at startup, or the runtime cannot
 * run on this machine at all. The kernel-denial step in `ci.yml` was supposed to distinguish them
 * and does not — on the failing run it printed only boot-time `(Sandbox)` kext lines, no denial.
 *
 * The comment in `darwin.ts` is explicit that the previous attempt at this failed by GUESSING at
 * grants (`sysctl-read`, `/dev/urandom`, `/dev/null`), and that the fix must add exactly what a
 * denial names and nothing else. This narrows the search without widening the real profile: the
 * permissive profile is written to a throwaway file, used once for a diagnostic, and never
 * reaches production code.
 */
function darwinPermissiveProbe(run: WrapperRun): string {
  if (process.platform !== "darwin") return "";
  const dir = mkdtempSync(join(tmpdir(), "nimbus-sandbox-probe-"));
  try {
    const profilePath = join(dir, "permissive.sb");
    writeFileSync(profilePath, "(version 1)\n(allow default)\n");
    // BOUNDED. This is a diagnostic that runs inside an already-failing test, so a child that
    // hangs would turn one assertion failure into a suite-wide stall and bury the very thing the
    // probe was added to explain. 15s is far above a startup abort and far below the 60s suite
    // timeout.
    const r = spawnSync("/usr/bin/sandbox-exec", ["-f", profilePath, ...run.argv], {
      encoding: "utf8",
      cwd: run.cwd,
      env: process.env,
      timeout: 15_000,
    });
    if (r.error !== undefined) {
      // A timeout is NOT "it fails unsandboxed too" — the child was still running when we killed
      // it, which says nothing about the profile. Reporting it as a failure would point the next
      // reader away from the profile, the opposite of what this probe is for.
      const code = (r.error as NodeJS.ErrnoException).code ?? "";
      const why =
        code === "ETIMEDOUT"
          ? "TIMED OUT after 15s — the child was still running, so this is INCONCLUSIVE, not an unsandboxed failure"
          : r.error.message;
      return `permissive-probe did not complete: ${why}`;
    }
    return [
      "permissive-probe (same argv, `(allow default)` profile):",
      `  status : ${String(r.status)}`,
      `  stdout : ${JSON.stringify(r.stdout ?? "")}`,
      `  stderr : ${JSON.stringify((r.stderr ?? "").slice(0, 400))}`,
      // Compared against the SANDBOXED status, not against 0. The first version asked
      // `r.status === 0`, which mislabelled every case whose expected exit is non-zero: the
      // `exit 7` test came back "it fails unsandboxed too" when 7 was exactly right. What
      // actually distinguishes the two causes is whether removing the sandbox CHANGES the
      // outcome.
      r.status !== run.status
        ? `  => the runtime is FINE here (unsandboxed status ${String(r.status)} vs sandboxed ${String(run.status)}); the profile is denying something it needs.`
        : "  => identical outcome without the sandbox; this is NOT an SBPL grant problem.",
      // When the permissive run SUCCEEDS, the profile is the problem and the only useful next
      // question is "which rule". SBPL answers it directly: `(trace "<file>")` runs the process
      // unconfined and writes out the rules it actually exercised. That is the mechanism this
      // whole investigation needed and did not have — the kernel denial log in `ci.yml` reports
      // nothing for a `(deny default)` profile, because denials are only logged under
      // `(deny default (with report))`, which is not something to add to a production profile
      // just to read it.
      //
      // Printed rather than acted on automatically: `trace` output is a superset (it records what
      // was touched, not what was required), so it is a candidate list for a human to narrow, in
      // the same spirit as `darwin.ts`'s "add exactly what it names, and nothing else".
      r.status !== run.status ? bisectMissingRule(run) : "",
    ]
      .filter((l) => l !== "")
      .join("\n");
  } catch (e) {
    return `permissive-probe failed to run: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run the same argv under `(trace)` and return the rules SBPL says it needed.
 *
 * Separate from the permissive probe because it answers a different question: that one asks
 * whether the profile is at fault, this one asks what to put in it. Only worth running when the
 * first says yes.
 */
/**
 * Which single extra rule makes the REAL profile work?
 *
 * Three mechanisms for naming a Seatbelt denial have now failed on `macos-15`, each for its own
 * reason, and all three are recorded here so nobody spends a cycle re-trying them:
 *
 *  - `ci.yml`'s kernel-log step: a plain `(deny default)` logs nothing at all.
 *  - `(trace "<file>")`: produced no output file. Trace mode is gone on modern macOS.
 *  - `(deny default (with report))`: rejected at compile time —
 *    "report modifier does not apply to deny action".
 *
 * So instead of asking the kernel what it denied, ask the profile what it is missing: run the real
 * profile once per candidate rule and report which candidates flip the outcome. The candidates are
 * deliberately BROAD (a whole operation class, `(subpath "/")`), because the goal here is to
 * identify the CLASS in one CI round-trip, not to propose the grant — a broad candidate that
 * works tells you where to look, and the narrow rule is then written by hand.
 *
 * Nothing here reaches production: every profile is built in a temp dir, used for one spawn, and
 * deleted. `generateSbplProfile` is called with the same inputs the wrapper used, so what is
 * probed is the profile that actually ran.
 */
function bisectMissingRule(run: WrapperRun): string {
  // Round 2. Round 1 established the CLASS: `(allow file-read* (subpath "/"))` fixed it and all
  // seven other operation classes -- write, ioctl, mach, shm, sysctl, process, system -- changed
  // nothing. So the child is being denied a file READ, and these narrow that to a path.
  const cwdParent = dirname(run.cwd);
  const cwdGrandparent = dirname(cwdParent);
  const CANDIDATES: ReadonlyArray<readonly [string, string]> = [
    [`(allow file-read* (subpath "${cwdParent}"))`, "the cwd's own parent"],
    [`(allow file-read* (subpath "${cwdGrandparent}"))`, "the temp root above the cwd"],
    [`(allow file-read* (subpath "${homedir()}"))`, "HOME"],
    ['(allow file-read* (subpath "/dev"))', "all of /dev"],
    ['(allow file-read* (subpath "/private/var"))', "all of /private/var"],
    ['(allow file-read* (subpath "/usr"))', "all of /usr"],
    ['(allow file-read* (subpath "/Library"))', "/Library"],
    ['(allow file-read* (subpath "/opt"))', "/opt"],
  ];
  const dir = mkdtempSync(join(tmpdir(), "nimbus-sandbox-bisect-"));
  try {
    // canonicalPath, exactly as the runner does. The previous probe passed the raw mkdtemp path
    // and printed a profile granting `/var/folders/...` while the kernel sees
    // `/private/var/folders/...` — a misleading diagnostic, and the very bug canonical-path.ts
    // exists to prevent.
    const base = generateSbplProfile({
      cwd: run.cwd,
      tmpdir: canonicalPath(dir),
      policy: run.policy,
    });
    const out: string[] = ["bisect-probe — real profile PLUS one candidate rule:"];
    for (const [rule, label] of CANDIDATES) {
      const profilePath = join(dir, "candidate.sb");
      writeFileSync(profilePath, `${base}\n${rule}\n`);
      const r = spawnSync("/usr/bin/sandbox-exec", ["-f", profilePath, ...run.argv], {
        encoding: "utf8",
        cwd: run.cwd,
        env: process.env,
        timeout: 15_000,
      });
      const fixed = r.error === undefined && r.status === 0;
      out.push(`  ${fixed ? "FIXES IT  " : "no change "} ${rule}   (${label})`);
    }
    return out.join("\n");
  } catch (e) {
    return `bisect-probe failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function reportLauncherError(run: WrapperRun): void {
  if (!isAnomalous(run)) return;
  console.error(
    [
      "",
      "--- sandbox launcher anomaly (diagnostics, not asserted) ---",
      `platform : ${process.platform}`,
      `execPath : ${process.execPath}`,
      `tmpdir   : ${tmpdir()}`,
      `cwd      : ${run.cwd}`,
      `policy   : ${JSON.stringify(run.policy.permissions)}`,
      `argv     : ${JSON.stringify(run.argv)}`,
      `status   : ${String(run.status)}`,
      // 134 is SIGABRT, 139 SIGSEGV, 137 SIGKILL. Naming it saves the next reader the arithmetic
      // and makes "the child aborted" legible as something other than an ordinary exit code.
      `signal   : ${run.status !== null && run.status > 128 ? `SIG(${String(run.status - 128)})` : "none"}`,
      `stdout   : ${JSON.stringify(run.stdout)}`,
      "stderr   :",
      run.stderr.replace(/^/gm, "  ").trimEnd(),
      darwinPermissiveProbe(run),
      "----------------------------------------------------------",
    ].join("\n"),
  );
}

function runThroughWrapper(
  p: SandboxPolicy,
  cwd: string,
  argv: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [GATEWAY_ENTRY, "__nimbus-sandbox", ...argv], {
    encoding: "utf8",
    env: {
      ...process.env,
      [SANDBOX_POLICY_ENV]: JSON.stringify(p),
      [SANDBOX_CWD_ENV]: cwd,
      ...(IS_WIN ? { NIMBUS_SANDBOX_HELPER_PATH: WIN_HELPER } : {}),
    },
  });
  const run: WrapperRun = {
    argv,
    cwd,
    policy: p,
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
  reportLauncherError(run);
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/**
 * Windows child bodies use only PowerShell LANGUAGE features and .NET statics — never a cmdlet.
 *
 * Measured, not stylistic. Inside the AppContainer on the `windows-2025` runner, PowerShell
 * starts and exits 0 but its command table is EMPTY: `Write-Output 'x'` fails with
 * `CommandNotFoundException`, so the child produced no stdout and the round-trip assertion saw
 * `""`. Command discovery has to read `$PSHOME`, which the container does not grant; type
 * resolution and operators do not, because they are served by already-loaded assemblies.
 *
 * The third case matters most. `refuses a path the policy does not grant` used
 * `Get-Content ... -ErrorAction Stop` inside a `try`, so a MISSING CMDLET threw and was caught by
 * the same `catch` a denied read would hit — the test exited `DENIED_CODE` and passed without the
 * sandbox denying anything. That is the one test which, by its own comment, makes this a sandbox
 * suite rather than a spawn suite, and on CI it was passing vacuously.
 * `[IO.File]::ReadAllBytes` throws on a real ACL denial and cannot be confused with a resolution
 * failure.
 *
 * Keep it that way: a cmdlet added here re-opens both holes at once.
 */
/**
 * A PowerShell single-quoted literal, with embedded apostrophes doubled.
 *
 * Reachable, not hypothetical: every path interpolated below is derived from `os.tmpdir()`, which
 * on Windows is `C:\Users\<user>\AppData\Local\Temp`. A user named `O'Connor` ends the literal
 * early and the script fails to parse — the child would then exit non-zero for a parse error while
 * the denial test asserts the DENIED code, so it would fail with a misleading reason on exactly
 * one developer's machine and nowhere else.
 *
 * Doubling is the escape PowerShell defines for a single-quoted string; there are no others to
 * handle, because a single-quoted literal interpolates nothing.
 */
function psQuote(s: string): string {
  return s.replace(/'/g, "''");
}

const PS_WRITE = (s: string): string => `[Console]::Out.Write('${s}')`;

/**
 * Separator for the argv round-trip: U+0001, which no argument under test contains.
 *
 * Both platforms emit the same joined form so ONE assertion covers both. It replaces
 * `$args | ConvertTo-Json -Compress` on Windows — another cmdlet, and one whose failure showed up
 * as a JSON parse error in the assertion rather than as anything about argv. A join preserves
 * quotes, spaces and trailing backslashes byte-for-byte, which is the property this pins.
 */
const ARGV_SEP = String.fromCharCode(1);
const PS_WRITE_ARGV = "[Console]::Out.Write(($args -join [char]1))";
const JS_WRITE_ARGV = "process.stdout.write(process.argv.slice(2).join(String.fromCharCode(1)))";

/**
 * The child process the sandbox spawns, chosen per platform — this is the one place this file
 * deliberately departs from a uniform "spawn the same script everywhere" shape.
 *
 * On Linux/macOS the child is Bun running a small `.js` file. Faithful: a real extension's entry
 * point is `bun <script>`.
 *
 * On Windows the child is a plain Win32 binary (`powershell.exe -File <script>.ps1`) — NOT Bun.
 * Measured (see `src-native/sandbox-helper-win32/README.md`, "Consequence, measured rather than
 * assumed"): a `bun <script>` child cannot start under a cwd nested inside the user profile — it
 * fails at startup with `CouldntReadCurrentDirectory`. What exactly Bun does at startup to
 * trigger this is NOT fully pinned down — a `package.json` placed at the leaf does not stop the
 * failure, which is what the README's measurement disproves about the naive "walks upward to
 * `C:\Users`, whose DACL can't be rewritten" explanation. A plain Win32 console app has no such
 * startup requirement and runs fine through the identical helper invocation at the identical
 * path with identical grants — which is what attributes the failure to Bun's own startup, not to
 * the sandbox. Using `powershell.exe` here is also the faithful choice for what this test is
 * meant to stand in for: the production Windows child is the compiled
 * `nimbus-gateway.exe __nimbus-connector <id>`, which likewise has no script path and behaves
 * like this Win32 case — Bun-running-a-script is the unfaithful shape on Windows, not the other
 * way around.
 */
function childProcess(dir: string, name: string, body: string): { argv: string[] } {
  if (IS_WIN) {
    const scriptPath = join(dir, `${name}.ps1`);
    writeFileSync(scriptPath, body);
    return {
      argv: [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ],
    };
  }
  const scriptPath = join(dir, `${name}.js`);
  writeFileSync(scriptPath, body);
  return { argv: [process.execPath, scriptPath] };
}

// A missing prerequisite is a local-dev convenience skip (a contributor without `bwrap` should
// not be blocked) but a CI failure: `!READY && !IS_CI` only suppresses the whole suite off-CI.
// On CI with a missing prerequisite, the describe block still runs — see the CI-fail-fast branch
// immediately inside it, which registers one loud, named failure instead of the five real tests.
describe.skipIf(!READY && !IS_CI)("sandbox wrapper: real spawn on every platform", () => {
  if (IS_CI && !READY) {
    // Fix 2 (fix round 1): a skip and a pass are indistinguishable in a CI summary — that
    // indistinguishability is precisely how the original Windows defect survived a green
    // three-OS matrix. So on CI, an unmet precondition must go RED with a named reason instead
    // of silently skipping. This is the only test bun-test-registers on CI when the precondition
    // is unmet; the five real spawn tests below are deliberately not registered in that case —
    // running them anyway would only produce confusing secondary failures on top of this one.
    it("fails loudly instead of silently skipping when its CI prerequisite is missing", () => {
      throw new Error(
        `sandbox-wrapper-spawn: CI precondition unmet — ${MISSING}. ` +
          "This suite must never silently skip on CI: that is the exact hole it exists to " +
          "close. Install the missing sandbox dependency for this platform's CI job and re-run.",
      );
    });
    return;
  }

  it("round-trips stdout through the sandbox — the property MCP stdio depends on", () => {
    const { argv } = childProcess(
      work,
      "hello",
      IS_WIN ? PS_WRITE("hello-from-sandbox") : 'process.stdout.write("hello-from-sandbox")',
    );
    const r = runThroughWrapper(policy(), work, argv);
    expect(r.stdout).toContain("hello-from-sandbox");
    expect(r.status).toBe(0);
  });

  it("propagates the child's exit code", () => {
    const { argv } = childProcess(work, "exit7", IS_WIN ? "exit 7" : "process.exit(7)");
    expect(runThroughWrapper(policy(), work, argv).status).toBe(7);
  });

  it("refuses a path the policy does not grant", () => {
    // This is what makes it a SANDBOX test rather than a spawn test: without it the whole suite
    // would pass against an unsandboxed spawn. See the DENIED_CODE comment above for why this
    // asserts an exact distinctive code rather than merely `status !== 0`.
    const secretPath = join(outside, "secret.txt");
    const body = IS_WIN
      ? [
          "try {",
          `  $null = [IO.File]::ReadAllBytes('${psQuote(secretPath)}')`,
          `  exit ${UNEXPECTED_SUCCESS_CODE}`,
          "} catch {",
          `  exit ${DENIED_CODE}`,
          "}",
        ].join("\n")
      : [
          "try {",
          `  require("fs").readFileSync(${JSON.stringify(secretPath)});`,
          `  process.exit(${UNEXPECTED_SUCCESS_CODE});`,
          "} catch (e) {",
          `  process.exit(${DENIED_CODE});`,
          "}",
        ].join("\n");
    const { argv } = childProcess(work, "peek", body);
    const r = runThroughWrapper(policy(), work, argv);
    expect(r.status).toBe(DENIED_CODE);
  });

  it("passes child argv through verbatim, quotes and trailing backslashes included", () => {
    // The Windows helper rebuilds a command line from argv, and naive quoting corrupts both of
    // these. Reachable, not hypothetical: connector.addMcp stores a user-supplied args_json that
    // becomes the child argv. On Linux/macOS this passes trivially — that is the point, it pins
    // the property on every platform rather than only where it is easy to break.
    const passthroughArgs = ['{"k":"v"}', "C:\\dir\\", "a b", "plain"];
    const { argv } = childProcess(work, "argv", IS_WIN ? PS_WRITE_ARGV : JS_WRITE_ARGV);
    const r = runThroughWrapper(policy(), work, [...argv, ...passthroughArgs]);
    expect(r.stdout.split(ARGV_SEP)).toEqual(passthroughArgs);
  });

  it("rejects a spawn with no policy at all", () => {
    const r = spawnSync(process.execPath, [GATEWAY_ENTRY, "__nimbus-sandbox", "cmd"], {
      encoding: "utf8",
      env: { ...process.env, [SANDBOX_CWD_ENV]: work },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(SANDBOX_POLICY_ENV);
  });
});
