/**
 * Every source file that branches on the host platform, and which coverage
 * gate covers it.
 *
 * WHY THIS EXISTS: `_test-suite.yml` runs most coverage-threshold gates on
 * Linux only. That is safe exactly while the code those gates cover does not
 * branch on platform. Without this list, the day someone adds
 * `process.platform` to a Linux-only gate's code, coverage on Windows and
 * macOS quietly stops watching it and NOTHING fails.
 *
 * LIMITATION, stated so it is not rediscovered: `gate: "none"` means no
 * coverage-threshold gate covers this file today. Those entries record that the
 * file was classified, not that it is protected. Coverage is measured over
 * files loaded at runtime including transitive imports, which cannot be derived
 * statically from the gate's test paths — so this audit guarantees that new
 * platform-branching code is CLASSIFIED, and that the nine PAL gates stay
 * `pal: true`. It does not prove a `gate: "none"` file never becomes covered by
 * a `pal: false` gate.
 *
 * That limitation is not theoretical: `index/sqlite-vec-load.ts` was originally
 * filed `gate: "none"` and the whole-branch review found it reachable from BOTH
 * the Embedding and DB layer gates via static imports. Both were promoted to
 * `pal: true`. When adding an entry, follow the static imports before writing
 * "none".
 *
 * A file reachable from more than one gate lists the others in `coGates`. Rule 3
 * checks every declared gate identically, so demoting ANY of them is caught —
 * naming only one used to leave the rest resting on a comment.
 */

export interface PlatformFileEntry {
  /** Repo-relative path, forward slashes. */
  readonly file: string;
  /** Coverage-gate `name` from the _test-suite.yml matrix, or "none". */
  readonly gate: string;
  /**
   * Additional gates whose coverage ALSO loads this file.
   *
   * A file reachable from two gates used to name only one, so demoting the
   * unnamed gate to `pal: false` slipped past rule 3 — the audit stayed green
   * while a gate whose denominator still contained platform-branching code went
   * Linux-only. Every gate listed here is checked exactly like `gate`.
   */
  readonly coGates?: readonly string[];
  readonly why: string;
}

export const PLATFORM_BRANCHING_ALLOWLIST: readonly PlatformFileEntry[] = [
  // ── Covered by a PAL gate (must be pal: true in the matrix) ────────────────
  {
    file: "packages/gateway/src/vault/win32.ts",
    gate: "Vault",
    why: "DPAPI backend; branches on platform and is win32-named",
  },
  { file: "packages/gateway/src/vault/darwin.ts", gate: "Vault", why: "Keychain backend" },
  { file: "packages/gateway/src/vault/linux.ts", gate: "Vault", why: "libsecret backend" },
  {
    file: "packages/gateway/src/exec/exec-runtimes.ts",
    gate: "Sandbox",
    why: "ExecRuntime.requiredReadPaths: macOS alone needs the runtime HOME granted; Windows must NOT get it (~/.bun carries thousands of cache entries and the AppContainer helper writes one ACE per path, so granting it hangs every spawn)",
  },
  {
    file: "packages/gateway/src/platform/sandbox/win32.ts",
    gate: "Sandbox",
    why: "Windows job-object sandbox",
  },
  {
    file: "packages/gateway/src/platform/sandbox/win32-reap.ts",
    gate: "Sandbox",
    why: "boot-time AppContainer orphan reap, Windows-only (process.platform !== 'win32' short-circuit)",
  },
  {
    file: "packages/gateway/src/platform/sandbox/darwin.ts",
    gate: "Sandbox",
    why: "sandbox-exec profile",
  },
  {
    file: "packages/gateway/src/platform/sandbox/linux.ts",
    gate: "Sandbox",
    why: "bwrap + seccomp",
  },
  {
    file: "packages/gateway/src/updater/factory.ts",
    gate: "Updater",
    why: "selects the per-OS updater implementation",
  },
  {
    file: "packages/gateway/src/updater/platform-target.ts",
    gate: "Updater",
    why: "maps platform to a release asset target",
  },
  {
    file: "packages/gateway/src/extensions/install-from-local.ts",
    gate: "Extensions",
    why: "per-OS install paths and permissions",
  },
  {
    file: "packages/gateway/src/perf/bench-runner.ts",
    gate: "Perf",
    why: "per-OS timing and process handling",
  },
  { file: "packages/gateway/src/perf/bench-cli.ts", gate: "Perf", why: "per-OS bench invocation" },
  { file: "packages/cli/src/commands/bench.ts", gate: "Perf", why: "per-OS bench invocation" },
  {
    file: "packages/gateway/src/telemetry/collector.ts",
    gate: "Telemetry",
    why: "reports host platform",
  },
  {
    file: "packages/cli/src/commands/doctor-core.ts",
    gate: "Doctor",
    why: "`if (platform() === 'linux')` gates the secret-tool probe",
  },
  {
    file: "packages/gateway/src/vault/factory.ts",
    gate: "Vault",
    why: "selects the per-OS vault backend",
  },
  {
    file: "packages/gateway/src/platform/sandbox/sandbox-runner.ts",
    gate: "Sandbox",
    why: "selects the per-OS sandbox implementation",
  },
  {
    file: "packages/gateway/src/index/sqlite-vec-load.ts",
    gate: "Embedding",
    coGates: ["DB layer"],
    why: "per-OS native extension filename; reaches BOTH the Embedding and the DB layer gates through static imports — embedding/lazy-scheduler.ts (plus create-routing-runtime.ts and embedding-worker.ts) and index/migrations/runner.ts each import it, so it lands in both gates' coverage denominators. Both are now ENFORCED: rule 3 checks `gate` and every `coGates` entry identically, so demoting EITHER is caught (this previously rested on a comment alone)",
  },

  // ── Not covered by any coverage-threshold gate ────────────────────────────
  {
    file: "packages/gateway/src/platform/index.ts",
    gate: "none",
    why: "PAL dispatch; no coverage-threshold gate targets src/platform",
  },
  {
    file: "packages/gateway/src/platform/gateway-log-file.ts",
    gate: "none",
    why: "per-OS log path",
  },
  {
    file: "packages/gateway/src/ipc/server/server.ts",
    gate: "none",
    why: "named pipe vs unix socket; the LAN gate's tests import lan-server.ts only, never this file",
  },
  {
    file: "packages/gateway/src/platform/win32.ts",
    gate: "none",
    why: "PAL implementation; no coverage-threshold gate targets src/platform",
  },
  { file: "packages/gateway/src/platform/darwin.ts", gate: "none", why: "PAL implementation" },
  { file: "packages/gateway/src/platform/linux.ts", gate: "none", why: "PAL implementation" },
  {
    file: "packages/gateway/src/platform/browser.ts",
    gate: "none",
    why: "per-OS browser-open command",
  },
  {
    file: "packages/gateway/src/index/registered-roots-store.ts",
    gate: "none",
    why: "per-OS path normalisation",
  },
  {
    file: "packages/gateway/src/ipc/server/dispatchers.ts",
    gate: "none",
    why: "named pipe vs unix socket",
  },
  { file: "packages/gateway/src/voice/tts.ts", gate: "none", why: "per-OS TTS backend" },
  {
    file: "packages/gateway/src/voice/wake-word.ts",
    gate: "none",
    why: "per-OS audio capture",
  },
  { file: "packages/cli/src/commands/config.ts", gate: "none", why: "per-OS config path display" },
  {
    file: "packages/cli/src/commands/extension.ts",
    gate: "none",
    why: "per-OS extension paths",
  },
  { file: "packages/cli/src/commands/start.ts", gate: "none", why: "per-OS gateway launch" },
  {
    file: "packages/cli/src/lib/resolve-gateway-launch.ts",
    gate: "none",
    why: "per-OS executable resolution",
  },
  { file: "packages/cli/src/lib/spawn-gateway.ts", gate: "none", why: "per-OS spawn flags" },
  {
    file: "packages/cli/src/paths.ts",
    gate: "none",
    why: "per-OS socket path + config/data/extensions dir resolution; no coverage-threshold gate targets packages/cli/src directly",
  },
];
