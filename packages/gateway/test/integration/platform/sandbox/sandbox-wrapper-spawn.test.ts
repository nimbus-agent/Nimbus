import { afterAll, describe, expect, it } from "bun:test";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { manifestForFirstParty } from "../../../../src/connectors/lazy-mesh/first-party-manifests.ts";
import { canonicalPath } from "../../../../src/platform/sandbox/canonical-path.ts";
import { generateSbplProfile } from "../../../../src/platform/sandbox/darwin.ts";
import {
  policyFromManifest,
  SANDBOX_CWD_ENV,
  SANDBOX_POLICY_ENV,
  type SandboxPolicy,
} from "../../../../src/platform/sandbox/sandbox-policy.ts";

/**
 * Real, end-to-end spawns through the `__nimbus-sandbox` role, on every platform Nimbus ships on.
 *
 * Nothing else in the suite does this. `linux-helper-launcher.test.ts` (Linux-only) runs the raw
 * native helper binary directly — it never goes through `sandbox-wrapper.ts`, and it says nothing
 * about Windows or macOS at all. That gap is exactly what let a broken Windows spawn path
 * (Task 5's fix) survive a green three-OS CI matrix: nothing in CI ever spawned through this role
 * for real on any OS but Linux. This file closes that hole.
 */

const GATEWAY_ENTRY = resolve(import.meta.dir, "../../../../src/index.ts");
const REPO_ROOT = realpathSync(resolve(import.meta.dir, "../../../../../.."));

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
 * Which paths does the REAL profile still need? Root grant MINUS one path at a time.
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
  // Round 5: WITHIN /private/var.
  //
  // The subtractive form named `/private/var` as the single required read outside the system
  // tree, and granting four of its children -- db, select, run, and the per-user cache dir `C` --
  // did not close it. So the needed piece is one of the rest. These deny each candidate from the
  // total grant; whichever BREAKS it is the one.
  //
  // `T` is on the list even though granting it is the outcome to avoid: it is the per-user temp
  // directory, and this suite puts the file the denial test expects to be REFUSED inside it. If T
  // turns out to be required, the fix is not to grant it here but to move that file somewhere the
  // policy genuinely does not reach, so the test keeps meaning something.
  const tmpContainer = dirname(canonicalPath(tmpdir()));
  const CANDIDATES: ReadonlyArray<readonly [string, string]> = [
    [`(deny file-read* (subpath "${canonicalPath(tmpdir())}"))`, "the per-user TEMP dir (T)"],
    [`(deny file-read* (subpath "${tmpContainer}"))`, "the container holding T and C"],
    ['(deny file-read* (subpath "/private/var/folders"))', "all of /private/var/folders"],
    ['(deny file-read* (subpath "/private/var/db"))', "/private/var/db"],
    ['(deny file-read* (subpath "/private/var/tmp"))', "/private/var/tmp"],
    ['(deny file-read* (subpath "/private/var/run"))', "/private/var/run"],
    ['(deny file-read* (subpath "/private/var/select"))', "/private/var/select"],
    ['(deny file-read* (subpath "/private/var/log"))', "/private/var/log"],
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
    /** What the child does when it is actually allowed to run. Every candidate is judged by this. */
    const runOnce = (extra: string) => {
      const profilePath = join(dir, "candidate.sb");
      // Root grant FIRST, then the extra rule. The ORDER is the mechanism: SBPL takes the last
      // matching rule, so `(allow ... "/")` followed by `(deny ... X)` composes to
      // "everything except X".
      writeFileSync(profilePath, `${base}\n(allow file-read* (subpath "/"))\n${extra}\n`);
      return spawnSync("/usr/bin/sandbox-exec", ["-f", profilePath, ...run.argv], {
        encoding: "utf8",
        cwd: run.cwd,
        env: process.env,
        timeout: 15_000,
      });
    };

    const baselineRun = runOnce("");
    const baseline = baselineRun.status;
    const out: string[] = [
      "bisect-probe — root read grant MINUS one path (REQUIRED = the child needs it):",
      `  baseline with the root grant and no deny: status ${String(baseline)}`,
    ];
    if (baselineRun.error !== undefined || baseline === run.status) {
      // Without a working baseline every candidate would compare against a broken reference and
      // the whole table would be noise. Say so instead of printing ten meaningless rows.
      return `${out[0] ?? ""}\n  ABORTED — the root grant does not repair this run either, so there is nothing to subtract from.`;
    }

    // One budget for the whole probe. 15s is PER candidate, so ten of them is a 150s worst case
    // against a 60s suite timeout — and this runs once per failing wrapper run, not once overall.
    const DEADLINE = Date.now() + 40_000;
    for (const [rule, label] of CANDIDATES) {
      if (Date.now() > DEADLINE) {
        out.push("  (budget exhausted — remaining candidates not run)");
        break;
      }
      const r = runOnce(rule);
      // Compared against the ROOT-GRANT BASELINE measured just above, not against 0 and not
      // against `run.status`.
      //
      // Against 0 was the original bug: on a run whose expected exit is non-zero (`exit 7`), it
      // reports EVERY candidate as unchanged, including ones that repair the profile. Three rounds
      // of this investigation were spent reading exactly that kind of output.
      //
      // Against `run.status` would be wrong too, and differently: in this SUBTRACTIVE form
      // `run.status` is the FAILING status under the real profile, so matching it would mean the
      // candidate broke things. "Still working" means matching what the child does when it is
      // allowed to run, which is what `baseline` holds.
      const stillWorks = r.error === undefined && r.status === baseline;
      // Inverted for the subtractive form: BREAKS IT means the denied path is required.
      out.push(`  ${stillWorks ? "not needed" : "REQUIRED  "} ${rule}   (${label})`);
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

/**
 * The macOS network rule under a real `sandbox-exec`, through the real wrapper. Until this ran, only
 * the generated text had been tested, and that text was a profile `sandbox-exec` rejects: exit 65,
 * `unbound variable: host`, for every child with a declared network since 2026-05-16.
 *
 * Through the wrapper role and `spawnSync`, bounded, as the rest of this file does: the runner's own
 * `node:child_process` spawn inside a test worker can lose its child's exit on macOS
 * (oven-sh/bun#41024) and hang past `--timeout`.
 *
 * Every run logs in full, because this leg runs on a machine nobody can log into. The denials
 * themselves cannot be read: see `bisectMissingRule` for the three ways of asking the kernel that
 * failed. So `reportNetworkCandidates` asks the profile instead, and names what a failing fetch needs.
 *
 * Public addresses are resolved by this process and dialled as literals, so the port filter is
 * measured whether or not a child can do DNS. An unsandboxed dial to the same address is the control:
 * without it, a port the network itself drops would pass as a port the sandbox refused.
 */
describe.skipIf(process.platform !== "darwin")("sandbox-exec: ports only, for real", () => {
  const TAG = "[sandbox-exec ports]";
  const BOUND_MS = 40_000;
  const TEST_MS = 90_000;
  const DIAL_MS = 8_000;
  const CANDIDATE_BOUND_MS = 25_000;
  const CANDIDATES_BUDGET_MS = 150_000;
  const CANDIDATES_TEST_MS = 240_000;
  const CONNECTOR_DRIVER_MS = 70_000;
  const CONNECTOR_BOUND_MS = 85_000;
  const STDERR_TAIL_CHARS = 2000;
  const SCRIPT_FAILED_CODE = 78;
  const MDNS_SOCKET = "/private/var/run/mDNSResponder";
  const MDNS_UNIX_SOCKET_RULE = `(allow network-outbound (remote unix-socket (path-literal "${MDNS_SOCKET}")))`;
  const MDNS_LITERAL_RULE = `(allow network-outbound (literal "${MDNS_SOCKET}"))`;
  const CONNECTED = "connected";

  type SpawnResult = SpawnSyncReturns<string>;
  type Outcomes = Record<string, string | number>;

  function policyWith(network: readonly string[]): SandboxPolicy {
    return { ...policy(), permissions: { ...policy().permissions, network: [...network] } };
  }

  function log(label: string, r: SpawnResult): void {
    console.log(
      `${TAG} ${label}: status=${String(r.status)} signal=${String(r.signal)} error=${String(r.error?.message)} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
    );
  }

  function run(label: string, network: readonly string[], argv: readonly string[]): SpawnResult {
    const r = spawnSync(process.execPath, [GATEWAY_ENTRY, "__nimbus-sandbox", ...argv], {
      encoding: "utf8",
      timeout: BOUND_MS,
      env: {
        ...process.env,
        [SANDBOX_POLICY_ENV]: JSON.stringify(policyWith(network)),
        [SANDBOX_CWD_ENV]: work,
      },
    });
    log(label, r);
    return r;
  }

  function outcomes(r: SpawnResult): Outcomes {
    try {
      return JSON.parse(r.stdout) as Outcomes;
    } catch {
      return {};
    }
  }

  /** A child that dials each `name: [host, port]` and prints what happened to each. */
  function dialChild(name: string, targets: Record<string, readonly [string, number]>): string[] {
    const body = [
      `const targets = ${JSON.stringify(targets)};`,
      'const net = require("net");',
      "const dial = ([host, port]) => new Promise((done) => {",
      `  const s = net.connect({ host, port }, () => { s.destroy(); done("${CONNECTED}"); });`,
      "  s.on('error', (e) => done(String(e.code ?? e.message)));",
      `  setTimeout(() => { s.destroy(); done("timeout"); }, ${String(DIAL_MS)});`,
      "});",
      "(async () => {",
      "  const out = {};",
      "  for (const [n, t] of Object.entries(targets)) out[n] = await dial(t);",
      "  process.stdout.write(JSON.stringify(out));",
      "  process.exit(0);",
      "})();",
    ].join("\n");
    return childProcess(work, name, body).argv;
  }

  /** The same dial, outside the sandbox: whether the network itself lets this through. */
  function hostDial(host: string, port: number): Promise<string> {
    return new Promise((done) => {
      const s = connect({ host, port }, () => {
        s.destroy();
        done(CONNECTED);
      });
      s.on("error", (e: NodeJS.ErrnoException) => done(String(e.code ?? e.message)));
      setTimeout(() => {
        s.destroy();
        done("timeout");
      }, DIAL_MS);
    });
  }

  /**
   * The address for a public name, once this machine can reach it on `port` with no sandbox. Null
   * means offline: a skip with a loud line on a contributor's machine, and a failure on CI, where a
   * skip would read as a pass.
   */
  async function reachableAddress(name: string, port: number): Promise<string | null> {
    let address: string;
    try {
      ({ address } = await lookup(name, { family: 4 }));
    } catch (error) {
      if (IS_CI) expect.unreachable(`this runner cannot resolve ${name}: ${String(error)}`);
      console.log(`${TAG} SKIPPED, NOT PROVED: cannot resolve ${name}`);
      return null;
    }
    const control = await hostDial(address, port);
    console.log(`${TAG} control, no sandbox: ${name} ${address}:${String(port)} ${control}`);
    if (control === CONNECTED) return address;
    if (IS_CI) expect.unreachable(`this runner cannot reach ${name}:${String(port)} at all`);
    console.log(`${TAG} SKIPPED, NOT PROVED: no route to ${name}:${String(port)}`);
    return null;
  }

  /**
   * Why a fetch failed, when it did: the real profile plus one candidate rule at a time, with each
   * whole result printed. Which row first turns `fetch` into a status is what the profile needs, and
   * the two spellings of the mDNSResponder rule show which one this macOS accepts. Nothing here
   * reaches production: each profile lives in a temp dir for one spawn.
   *
   * `mach-lookup` and `sysctl-read` are not candidates because the profile already grants them
   * unscoped, and neither are `/private/etc` (`ssl`, `hosts`) or `/private/var/run` (`resolv.conf`),
   * for the same reason.
   */
  function reportNetworkCandidates(argv: readonly string[], network: readonly string[]): void {
    const candidates: ReadonlyArray<readonly [string, string]> = [
      ["the profile as generated", ""],
      ["mDNSResponder, as a unix socket", MDNS_UNIX_SOCKET_RULE],
      ["mDNSResponder, as a literal", MDNS_LITERAL_RULE],
      ["system sockets", "(allow system-socket)"],
      ["mDNSResponder and system sockets", `${MDNS_UNIX_SOCKET_RULE}\n(allow system-socket)`],
      ["every outbound connection", "(allow network-outbound)"],
      ["every network operation, bind and inbound too", "(allow network*)"],
      ["every read", '(allow file-read* (subpath "/"))'],
      [
        "all network, system sockets, every read and write",
        '(allow network*)\n(allow system-socket)\n(allow file-read* (subpath "/"))\n(allow file-write* (subpath "/"))',
      ],
      ["no sandbox at all: the control", "(allow default)"],
    ];
    const dir = canonicalPath(mkdtempSync(join(tmpdir(), "nimbus-sandbox-candidates-")));
    try {
      const base = generateSbplProfile({ cwd: work, tmpdir: dir, policy: policyWith(network) });
      const deadline = Date.now() + CANDIDATES_BUDGET_MS;
      console.log(`${TAG} candidates for a failing fetch, generated profile:\n${base}`);
      for (const [label, rule] of candidates) {
        if (Date.now() > deadline) {
          console.log(`${TAG} candidate budget spent, the rest did not run`);
          break;
        }
        const profilePath = join(dir, "candidate.sb");
        writeFileSync(profilePath, `${base}\n${rule}\n`);
        const r = spawnSync("/usr/bin/sandbox-exec", ["-f", profilePath, ...argv], {
          encoding: "utf8",
          cwd: work,
          timeout: CANDIDATE_BOUND_MS,
          env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir },
        });
        log(`candidate: ${label}`, r);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it(
    "records which network forms sandbox-exec accepts, and rejects the old one",
    () => {
      const forms: ReadonlyArray<readonly [string, string]> = [
        ["tcp, any host", '(allow network-outbound (remote tcp "*:443"))'],
        ["udp, any host", '(allow network-outbound (remote udp "*:53"))'],
        ["tcp, localhost", '(allow network-outbound (remote tcp "localhost:443"))'],
        ["ip, any host", '(allow network-outbound (remote ip "*:443"))'],
        ["tcp, a hostname", '(allow network-outbound (remote tcp "api.github.com:443"))'],
        ["tcp, a loopback literal", '(allow network-outbound (remote tcp "127.0.0.1:443"))'],
        ["mDNSResponder, as a unix socket", MDNS_UNIX_SOCKET_RULE],
        ["mDNSResponder, as a literal", MDNS_LITERAL_RULE],
        ["system sockets", "(allow system-socket)"],
        ["the old host filter", '(allow network* (remote tcp "*:443" (host "api.github.com")))'],
      ];
      const dir = mkdtempSync(join(tmpdir(), "nimbus-sandbox-forms-"));
      try {
        const statuses = new Map<string, number | null>();
        for (const [label, form] of forms) {
          const profilePath = join(dir, "form.sb");
          writeFileSync(profilePath, `(version 1)\n(allow default)\n${form}\n`);
          const r = spawnSync("/usr/bin/sandbox-exec", ["-f", profilePath, "/usr/bin/true"], {
            encoding: "utf8",
            timeout: BOUND_MS,
          });
          log(`form: ${label}: ${form}`, r);
          statuses.set(label, r.status);
        }
        expect(statuses.get("tcp, any host")).toBe(0);
        expect(statuses.get("udp, any host")).toBe(0);
        expect(statuses.get("the old host filter")).not.toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_MS,
  );

  it(
    "parses the profile of a declared host and starts a child",
    () => {
      const r = run("parse and start", ["api.github.com"], ["/usr/bin/true"]);
      expect(r.stderr).not.toContain("sandbox-exec:");
      expect(r.status).toBe(0);
    },
    TEST_MS,
  );

  it(
    "gets an HTTP status from a declared host, with real DNS and TLS",
    async () => {
      const body = [
        'const dns = require("dns");',
        "const step = async (fn) => {",
        "  const timer = new Promise((done) => setTimeout(() => done('timeout'), 12000));",
        "  try { return await Promise.race([fn(), timer]); }",
        "  catch (e) { return String(e.code ?? e.name) + ': ' + String(e.message); }",
        "};",
        "(async () => {",
        "  const lookup = await step(() => dns.promises.lookup('api.github.com').then((a) => a.address));",
        "  const status = await step(() => fetch('https://api.github.com/').then((r) => r.status));",
        "  process.stdout.write(JSON.stringify({ lookup, status }));",
        "  process.exit(0);",
        "})();",
      ].join("\n");
      const { argv } = childProcess(work, "ports-fetch", body);
      const network = ["api.github.com"];
      if ((await reachableAddress("api.github.com", 443)) === null) return;
      const r = run("fetch a declared host", network, argv);
      const { status } = outcomes(r);
      if (typeof status !== "number") reportNetworkCandidates(argv, network);
      expect(r.stderr).not.toContain("sandbox-exec:");
      expect(r.status).toBe(0);
      expect(status).toBeNumber();
      expect(status).toBeGreaterThanOrEqual(100);
      expect(status).toBeLessThan(600);
    },
    CANDIDATES_TEST_MS,
  );

  it(
    "refuses an undeclared port on a public host, and allows any host on a declared one",
    async () => {
      const github = await reachableAddress("api.github.com", 80);
      const other = await reachableAddress("example.com", 443);
      if (github === null || other === null) return;
      const argv = dialChild("ports-filter", {
        declaredPort: [github, 443],
        undeclaredPort: [github, 80],
        // The stated bound: the list names api.github.com, and this other host is reachable anyway.
        undeclaredHostOnDeclaredPort: [other, 443],
      });
      const r = run("port filter", ["api.github.com"], argv);
      const seen = outcomes(r);
      expect(r.status).toBe(0);
      expect(seen["declaredPort"]).toBe(CONNECTED);
      expect(seen["undeclaredPort"]).toBeDefined();
      expect(seen["undeclaredPort"]).not.toBe(CONNECTED);
      expect(seen["undeclaredHostOnDeclaredPort"]).toBe(CONNECTED);
    },
    TEST_MS,
  );

  it(
    "reaches a declared loopback port under *:port, and refuses an undeclared one",
    () => {
      // `spawnSync` blocks this event loop, so no listener accepts, and none has to: a connect completes
      // against the kernel's backlog. Only the sandbox can tell the ports apart.
      const handlers = { socket: { data() {} } };
      const literal = Bun.listen({ hostname: "127.0.0.1", port: 0, ...handlers });
      const named = Bun.listen({ hostname: "127.0.0.1", port: 0, ...handlers });
      const undeclared = Bun.listen({ hostname: "127.0.0.1", port: 0, ...handlers });
      try {
        const argv = dialChild("ports-loopback", {
          loopbackLiteralEntry: ["127.0.0.1", literal.port],
          localhostEntry: ["127.0.0.1", named.port],
          undeclaredPort: ["127.0.0.1", undeclared.port],
        });
        const network = [`127.0.0.1:${String(literal.port)}`, `localhost:${String(named.port)}`];
        const r = run("loopback", network, argv);
        const seen = outcomes(r);
        expect(r.status).toBe(0);
        expect(seen["loopbackLiteralEntry"]).toBe(CONNECTED);
        expect(seen["localhostEntry"]).toBe(CONNECTED);
        expect(seen["undeclaredPort"]).toBeDefined();
        expect(seen["undeclaredPort"]).not.toBe(CONNECTED);
      } finally {
        literal.stop(true);
        named.stop(true);
        undeclared.stop(true);
      }
    },
    TEST_MS,
  );

  it(
    "still gives a no-network policy no network, loopback included",
    async () => {
      const github = await reachableAddress("api.github.com", 443);
      const handlers = { socket: { data() {} } };
      const local = Bun.listen({ hostname: "127.0.0.1", port: 0, ...handlers });
      try {
        const argv = dialChild("ports-no-network", {
          loopback: ["127.0.0.1", local.port],
          ...(github === null ? {} : { publicHost: [github, 443] as const }),
        });
        const r = run("no network", [], argv);
        const seen = outcomes(r);
        expect(r.status).toBe(0);
        expect(seen["loopback"]).toBeDefined();
        expect(seen["loopback"]).not.toBe(CONNECTED);
        if (github !== null) {
          expect(seen["publicHost"]).toBeDefined();
          expect(seen["publicHost"]).not.toBe(CONNECTED);
        }
      } finally {
        local.stop(true);
      }
    },
    TEST_MS,
  );

  it(
    "still refuses a read outside the grants, with a network declared",
    () => {
      const body = [
        "try {",
        `  require("fs").readFileSync(${JSON.stringify(join(outside, "secret.txt"))});`,
        `  process.exit(${String(UNEXPECTED_SUCCESS_CODE)});`,
        "} catch (e) {",
        "  process.stdout.write(String(e.code));",
        `  process.exit(e.code === "EPERM" || e.code === "EACCES" ? ${String(DENIED_CODE)} : ${String(SCRIPT_FAILED_CODE)});`,
        "}",
      ].join("\n");
      const { argv } = childProcess(work, "ports-peek", body);
      const r = run("read outside the grants", ["api.github.com"], argv);
      expect(r.status).toBe(DENIED_CODE);
    },
    TEST_MS,
  );

  it(
    "starts a subprocess and waits for it, with a network declared",
    () => {
      const body = [
        'const { spawn, spawnSync } = require("child_process");',
        'const sync = spawnSync("/usr/bin/true");',
        "const out = { sync: sync.status, syncError: String(sync.error) };",
        "const finish = (async_) => {",
        "  process.stdout.write(JSON.stringify({ ...out, async: async_ }));",
        `  process.exit(sync.status === 0 ? 0 : ${String(SCRIPT_FAILED_CODE)});`,
        "};",
        'const child = spawn("/usr/bin/true");',
        'child.on("exit", (code) => finish(code));',
        'child.on("error", (e) => finish(String(e.message)));',
        'setTimeout(() => finish("timeout"), 10000);',
      ].join("\n");
      const { argv } = childProcess(work, "ports-subprocess", body);
      const r = run("subprocess", ["api.github.com"], argv);
      expect(r.status).toBe(0);
      expect(outcomes(r)["sync"]).toBe(0);
    },
    TEST_MS,
  );

  it(
    "runs a real connector: its own tool call gets GitHub's answer to a bad token",
    async () => {
      if ((await reachableAddress("api.github.com", 443)) === null) return;
      const secret = "not-a-real-token";
      const manifest = manifestForFirstParty("github");
      const fromManifest = policyFromManifest(manifest);
      const connectorPolicy: SandboxPolicy = {
        ...fromManifest,
        permissions: {
          network: fromManifest.permissions.network,
          filesystem: {
            // A source checkout has to read itself; a compiled gateway carries all this in its binary.
            read: [
              ...fromManifest.permissions.filesystem.read,
              ...policy().permissions.filesystem.read,
              REPO_ROOT,
            ],
            write: fromManifest.permissions.filesystem.write,
          },
        },
      };
      // The driver holds stdin open for the whole exchange, which `spawnSync`'s `input` cannot, and it
      // is its own process, so this test's worker never owns an async child.
      const driver = [
        'const { spawn } = require("child_process");',
        `const entry = ${JSON.stringify(GATEWAY_ENTRY)};`,
        "const child = spawn(process.execPath, [entry, '__nimbus-sandbox', process.execPath, entry, '__nimbus-connector', 'github'], { stdio: ['pipe', 'pipe', 'pipe'] });",
        "let stderr = '';",
        "let tools = -1;",
        "const finish = (code, text) => {",
        `  process.stdout.write(JSON.stringify({ text, tools, stderr: stderr.slice(-${String(STDERR_TAIL_CHARS)}) }));`,
        "  child.kill();",
        "  process.exit(code);",
        "};",
        `setTimeout(() => finish(3, 'timed out'), ${String(CONNECTOR_DRIVER_MS)});`,
        "child.on('exit', (code) => finish(4, 'exited early, code ' + String(code)));",
        "child.stderr.on('data', (d) => { stderr += d.toString(); });",
        "const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');",
        "let buffered = '';",
        "child.stdout.on('data', (d) => {",
        "  buffered += d.toString();",
        "  const lines = buffered.split('\\n');",
        "  buffered = lines.pop() ?? '';",
        "  for (const line of lines) {",
        "    let m;",
        "    try { m = JSON.parse(line); } catch { continue; }",
        "    if (m.id === 1) {",
        "      send({ method: 'notifications/initialized' });",
        "      send({ id: 2, method: 'tools/list' });",
        "    } else if (m.id === 2) {",
        "      tools = m.result?.tools?.length ?? 0;",
        "      send({ id: 3, method: 'tools/call', params: { name: 'github_repo_list', arguments: {} } });",
        "    } else if (m.id === 3) {",
        "      finish(0, m.result?.content?.[0]?.text ?? line);",
        "    }",
        "  }",
        "});",
        "send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sandbox-ports-test', version: '1' } } });",
      ].join("\n");
      const { argv } = childProcess(work, "ports-connector-driver", driver);
      const [command = process.execPath, ...args] = argv;
      const r = spawnSync(command, args, {
        encoding: "utf8",
        timeout: CONNECTOR_BOUND_MS,
        env: {
          ...process.env,
          GITHUB_PAT: secret,
          [SANDBOX_POLICY_ENV]: JSON.stringify(connectorPolicy),
          [SANDBOX_CWD_ENV]: join(work, "connector"),
        },
      });
      log("real connector", r);
      const answer = JSON.parse(r.stdout) as { text: string; tools: number; stderr: string };
      expect(answer.tools).toBeGreaterThan(0);
      expect(answer.text).toMatch(/GitHub \d{3}/);
      expect(answer.stderr).not.toContain(secret);
      expect(r.status).toBe(0);
    },
    CONNECTOR_BOUND_MS + TEST_MS,
  );
});

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
    // `expect.unreachable` rather than a bare `throw`: the two fail this test identically, but an
    // assertion-free body is what S2699 flags — and it is right to, because that shape is
    // indistinguishable from a test that simply forgot to assert. Reaching this line IS the
    // failure, which is exactly what `unreachable` says.
    it("fails loudly instead of silently skipping when its CI prerequisite is missing", () => {
      expect.unreachable(
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
