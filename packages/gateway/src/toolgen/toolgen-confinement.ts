import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionManifest } from "../extensions/manifest.ts";
import { extensionProcessEnv } from "../extensions/spawn-env.ts";
import { policyFromManifest } from "../platform/sandbox/sandbox-policy.ts";
import type { SandboxRunner } from "../platform/sandbox/sandbox-runner.ts";
import { ERR_TOOLGEN_SANDBOX_DEGRADED, ToolgenError } from "./toolgen-types.ts";

/** The probe's exit code for "the read was denied", i.e. confinement worked. */
const PROBE_EXIT_FS_DENIED = 10;

/**
 * How the probe is told WHICH path to try, and why it is not a `--flag`.
 *
 * Measured, not stylistic: `bun -e <code> --nimbus-probe-target <path>` hands the child a
 * `process.argv` of `[bun, <path>]` — bun's own argument parser consumes the `--`-prefixed token
 * before the script ever sees it, so a flag-shaped separator silently disappears and only its value
 * survives, at an index that looks exactly like an ordinary positional. A single bare
 * `nimbus-probe-target=<path>` argument has no leading dash, travels through untouched, and carries
 * its own name, so the probe can tell "the target I was given" from "some other argument" and
 * refuse rather than guess.
 */
const PROBE_TARGET_PREFIX = "nimbus-probe-target=";

/**
 * The confinement probe, inline.
 *
 * It was an `@nimbus-dev/sdk/testing` SCRIPT until 2026-09-10, and that was a documented,
 * cross-platform dead end for two independent reasons — neither of which was fixable by choosing a
 * different question to ask:
 *
 *   1. It had to be spawned as a bare file argument (`bun <probe.js> --probe=fs-denied`), which is
 *      the "file entry point" shape the Windows AppContainer refuses with
 *      `CouldntReadCurrentDirectory` (`toolgen-client.ts`'s own docstring; measured against a real
 *      `nimbus-sandbox-helper.exe`). Switching to the `-e` form gets past that, and then
 *   2. the script itself lives under `node_modules/.bun/...`, a path no generated-tool manifest
 *      ever grants read to — so the interpreter could start and still not open the program.
 *
 * A zero-import, zero-`node_modules` `-e` script has neither problem: it is the SAME invocation
 * shape `buildToolSpawnSpec` uses for the generated tool itself, which
 * `toolgen-network-denied.test.ts` proves works under the AppContainer.
 *
 * WHAT it reads changed at the same time, and for a reason measured on real Linux with real
 * `bwrap` (0.11.1): the old probe read a "known-protected system path" (`/etc/passwd`, or
 * `C:\Windows\System32\config\SAM`). That is not a measurement of THIS sandbox on POSIX.
 * `buildBwrapArgv` `--ro-bind`s `/etc` unconditionally, and the macOS profile grants
 * `(subpath "/private/etc")`, so on both platforms the confined child reads `/etc/passwd` happily
 * and the probe reported exit 2 — "unconfined" — for a sandbox that was working perfectly. Every
 * `nimbus tool create` on Linux and macOS therefore refused with `ERR_TOOLGEN_CONFINEMENT_FAILED`
 * before the owner was ever prompted. It was invisible because nothing ever ran the default probe:
 * `toolgen-confinement.test.ts` injects `spawnProbe`, and the e2e injected its own inline copy.
 *
 * The probe now reads a SENTINEL the caller just wrote outside every grant (see
 * `assertToolConfinement`). That is a real measurement on all three platforms because the caller
 * PROVES it can read that file itself first: parent can, child cannot, therefore the sandbox
 * confined it. Any failure counts as denial — the mechanisms differ per platform and all three are
 * correct answers (`ENOENT` on Linux, where `--tmpfs /tmp` masks the file out of existence;
 * `EPERM` on macOS under `(deny default)`; an ACL denial on Windows, where the AppContainer holds
 * no ACE for that path) — which is exactly why the probe must not enumerate error codes the way the
 * SDK one did.
 *
 * FULLY STATIC on purpose — every line is a literal and nothing is interpolated in.
 *
 * An earlier revision built this with `${JSON.stringify(PROBE_TARGET_PREFIX)}` and
 * `${PROBE_TARGET_PREFIX.length}`. Both were safe in fact — the value is a module constant and
 * `JSON.stringify` is the correct escape for embedding a string in JS source — but CodeQL's
 * `js/bad-code-sanitization` flagged the SHAPE, and it is right to: this is the one file whose job
 * is proving a security property, and "we construct executable code by concatenation, but the
 * inputs happen to be constants today" is a guarantee that survives only until someone makes one
 * of them dynamic. A static string cannot regress that way.
 *
 * The cost is that the prefix now appears twice — here and in `PROBE_TARGET_PREFIX`. That
 * duplication is PINNED by a test asserting this string contains that constant, so the two cannot
 * drift silently; a comment asking the next reader to keep them in step would not.
 */
const INLINE_FS_DENIED_PROBE = [
  'const PREFIX = "nimbus-probe-target=";',
  "const arg = process.argv.find((a) => a.startsWith(PREFIX));",
  // Not exit 10: being handed no target at all proves nothing about confinement, and reporting
  // "denied" here would turn every future argv change into a silently passing probe.
  "if (arg === undefined) process.exit(2);",
  "const target = arg.slice(PREFIX.length);",
  'if (target === "") process.exit(2);',
  "try {",
  '  const fs = await import("node:fs/promises");',
  '  await fs.readFile(target, "utf8");',
  // The parent proved this file readable moments ago, so reading it here means the child was NOT
  // confined.
  "  process.exit(2);",
  "} catch {",
  "  process.exit(10);",
  "}",
].join("\n");

/**
 * Exposed ONLY so a test can pin the three literals the probe now duplicates — the argv prefix, the
 * denial exit code, and the fact that nothing is interpolated into it. Production never reads this.
 */
export const INLINE_FS_DENIED_PROBE_FOR_TEST = INLINE_FS_DENIED_PROBE;
export const PROBE_TARGET_PREFIX_FOR_TEST = PROBE_TARGET_PREFIX;
export const PROBE_EXIT_FS_DENIED_FOR_TEST = PROBE_EXIT_FS_DENIED;

export interface ToolConfinementDeps {
  readonly runner: SandboxRunner;
  readonly manifest: ExtensionManifest;
  readonly cwd: string;
  /**
   * Injected for tests. Production spawns the probe through the real runner.
   *
   * `target` is the sentinel path `assertToolConfinement` created and verified readable — an
   * injected probe is free to ignore it, but the real one must attempt exactly that path.
   */
  readonly spawnProbe?: (
    runner: SandboxRunner,
    policy: ReturnType<typeof policyFromManifest>,
    cwd: string,
    target: string,
  ) => Promise<number>;
}

/**
 * How long the confinement probe may take before it is killed and treated as a failure.
 *
 * `assertToolConfinement` runs BEFORE the owner is prompted, so a probe that never exits does not
 * merely slow the gate down — it hangs `createGeneratedTool` outright, with no prompt and no
 * refusal. Two reachable ways that happens: the sandbox helper itself stalls (a Windows
 * AppContainer ACL grant over a large tree is a recorded case), or the probe outgrows the pipe
 * buffer and blocks on a write nothing is reading.
 */
const PROBE_TIMEOUT_MS = 30_000;

/** Not `PROBE_EXIT_FS_DENIED`, so a timed-out probe lands on the refusal side by construction. */
const PROBE_EXIT_TIMEOUT = -2;

/**
 * Exported, and taking `timeoutMs`, purely so the timeout and drain paths are testable without a
 * 30-second test — the same seam `wireToolProtocol` already uses for its own request timeout.
 * Production always calls it through the `deps.spawnProbe ?? defaultSpawnProbe` default below,
 * with the real bound.
 */
export function defaultSpawnProbe(
  runner: SandboxRunner,
  policy: ReturnType<typeof policyFromManifest>,
  cwd: string,
  target: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = runner.spawn(
      process.execPath,
      ["-e", INLINE_FS_DENIED_PROBE, `${PROBE_TARGET_PREFIX}${target}`],
      {
        policy,
        env: extensionProcessEnv({}),
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    // DRAIN both pipes. `stdio: ["ignore", "pipe", "pipe"]` creates pipes with no reader, so a
    // probe that prints more than one buffer's worth blocks on write and never reaches `close` —
    // the hang this timeout exists to bound, arriving by the most ordinary route there is. The
    // output itself is discarded: the probe's verdict is its EXIT CODE, and nothing here should
    // start parsing what an unconfined process chose to print.
    child.stdout?.resume();
    child.stderr?.resume();

    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        resolve(PROBE_EXIT_TIMEOUT);
      });
    }, timeoutMs);

    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) => finish(() => resolve(code ?? -1)));
  });
}

/**
 * Write a file the confined child must NOT be able to read, and prove the PARENT can read it.
 *
 * The positive control is the whole point. The probe treats any read failure as a denial, because
 * the three platforms deny by three different mechanisms and enumerating their error codes is what
 * made the previous probe wrong. That interpretation is only sound if the file is known to exist
 * and be readable at the moment of the spawn — otherwise "denied" and "I gave the probe a path to
 * nothing" are the same observation, and the gate would pass vacuously forever.
 *
 * Placed in its OWN `mkdtemp` under the system temp directory, never under `cwd` and never under a
 * manifest grant: `cwd` is `--bind`ed on Linux and the grants are ACE'd on Windows, so a sentinel
 * in either would be legitimately readable and the probe would (correctly) report exit 2.
 */
async function createSentinel(): Promise<{ path: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "nimbus-toolgen-probe-"));
  const path = join(dir, "sentinel.txt");
  await writeFile(path, "nimbus-confinement-sentinel", { mode: 0o600 });
  // The control: if THIS throws, the sandbox is not what failed and the probe below would report a
  // denial that means nothing.
  await readFile(path, "utf8");
  return { path, dir };
}

/**
 * Prove THIS machine's sandbox confines THIS manifest, before the owner is prompted.
 *
 * Two checks, in order. `canConfine(policy)` asks the PAL about the policy that will actually
 * spawn — never `degradedReason()` (non-null on Windows even when the runner is fully active) and
 * never `isFullyActive()` (reports the Linux per-host helper an empty-network policy never touches,
 * and CI does not install it). Then the probe actually runs under that policy, because a runner
 * saying it *can* confine is a claim and the probe is a measurement.
 *
 * Called BEFORE `writeScript` (`toolgen-gate.ts` step 6, ahead of step 9), so the manifest's own
 * `scriptDir` grant NEVER exists on disk yet at this point — by design, since nothing may be
 * written before the owner approves. A grant target that does not exist is fine for `bwrap`'s and
 * `sandbox-exec`'s bind mechanisms, but the Windows helper's ACL grant
 * (`GetNamedSecurityInfoW`/`SetNamedSecurityInfoW`) requires the target to exist first and fails
 * closed with exit 66 (`ERROR_PATH_NOT_FOUND`) otherwise — turning EVERY confinement check on
 * Windows into a false `ERR_TOOLGEN_CONFINEMENT_FAILED`, regardless of what program the probe
 * spawns. Creating the empty directory here (never its contents — the body is written only after
 * approval, unchanged) is what lets the grant call target a real path on every platform.
 *
 * `mode: 0o700` matches `writeToolScript`'s own OWNER-ONLY mode (`toolgen-script-store.ts`)
 * exactly, and is load-bearing, not decorative: `mkdir(dir, { recursive: true })` on a directory
 * that ALREADY EXISTS is a no-op — it does not retroactively chmod — so creating this directory
 * without a mode here would have `writeToolScript`'s later `mode: 0o700` silently do nothing,
 * leaving the directory that will hold the owner-approved tool body at the process umask default
 * (world-listable on a typical shared Linux/macOS box) instead of owner-only.
 */
export async function assertToolConfinement(deps: ToolConfinementDeps): Promise<void> {
  const policy = policyFromManifest(deps.manifest);
  const cannot = deps.runner.canConfine(policy);
  if (cannot !== null) {
    throw new ToolgenError(
      ERR_TOOLGEN_SANDBOX_DEGRADED,
      `refusing to generate a tool that could not be confined: ${cannot}`,
    );
  }
  for (const dir of [
    ...deps.manifest.permissions.filesystem.read,
    ...deps.manifest.permissions.filesystem.write,
  ]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  let sentinel: { path: string; dir: string };
  try {
    sentinel = await createSentinel();
  } catch (err) {
    // Fail CLOSED, and say which half failed: nothing about the sandbox has been measured, so the
    // one thing this must not do is let the gate continue to the owner's prompt.
    //
    // `String(err)` rather than an `instanceof Error` ternary: the non-Error arm of that ternary is
    // unreachable from `node:fs/promises` and so could never be exercised, and an untestable branch
    // in a pre-consent refusal path is worse than a message that reads `ToolgenError: …` on the one
    // occasion it fires.
    throw new ToolgenError(
      "ERR_TOOLGEN_CONFINEMENT_FAILED",
      `could not prepare the confinement probe's sentinel file: ${String(err)}`,
    );
  }
  let exit: number;
  try {
    exit = await (deps.spawnProbe ?? defaultSpawnProbe)(
      deps.runner,
      policy,
      deps.cwd,
      sentinel.path,
    );
  } finally {
    // Best effort: a leftover sentinel is temp-dir litter, never a correctness problem, and it must
    // not mask the probe's own result (or its throw).
    await rm(sentinel.dir, { recursive: true, force: true }).catch(() => {});
  }
  if (exit !== PROBE_EXIT_FS_DENIED) {
    throw new ToolgenError(
      "ERR_TOOLGEN_CONFINEMENT_FAILED",
      `sandbox confinement probe returned exit ${exit}, expected ${PROBE_EXIT_FS_DENIED}`,
    );
  }
}
