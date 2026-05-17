// Structural exclusion registry for the per-file coverage floor.
//
// Source of truth for the spec §"Structural Exclusions" table. Kept in sync
// with sonar-project.properties' sonar.coverage.exclusions via the parity
// check in check-exclusion-parity.ts.
//
// Patterns are matched against forward-slash repo-relative paths
// (e.g. "packages/gateway/src/vault/win32.ts"). Each entry is one of:
//   - exact path (string)
//   - directory prefix (string ending "/")  → all files under that dir
//   - basename regex (`/^pat$/`)              → matched against path.basename(p)
//   - path regex     (`/^pat$/`)              → matched against the full relPath
//
// Test files (*.test.ts, *.test.tsx) are filtered upstream by the source
// walker; they need not appear here.

export type ExclusionPattern =
  | { kind: "exact"; path: string }
  | { kind: "dirPrefix"; prefix: string }
  | { kind: "basenameRegex"; re: RegExp }
  | { kind: "pathRegex"; re: RegExp };

export const EXCLUSIONS: readonly ExclusionPattern[] = Object.freeze([
  // Platform-specific PAL implementations — only one runs per OS.
  { kind: "exact", path: "packages/gateway/src/vault/win32.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/darwin.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/linux.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/win32.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/darwin.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/linux.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/browser.ts" },

  // Extension sandbox PAL (T2 PR 1) — same per-OS shape as the vault/platform
  // PAL above. Exported helpers (decideNetworkMode, buildBwrapArgv,
  // generateSbplProfile, profileNameFor, capabilitiesForManifest) are pure
  // and tested via the colocated `*.test.ts` files; the per-OS impls
  // themselves cannot all run on Ubuntu CI.
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/linux.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/darwin.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/win32.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/orphan-reap.ts" },
  // Sandbox dispatcher — same per-OS shape; only one of the three switch
  // arms executes per CI run, so a single Ubuntu lcov tops out near
  // 50–55%. Matches the platform/index.ts pattern (also a per-OS
  // dispatcher) — but unlike platform/index.ts which mocks os.platform()
  // in its test, this dispatcher uses async `await import(...)` and
  // mocking module imports across async boundaries is fragile in bun.
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/sandbox-runner.ts" },
  // Pure re-export module — `export type { ... }` + `export { fn } from "./..."`
  // produces no executable code in TypeScript erasure. Bun's V8 coverage
  // emits no lcov entries for this file.
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/index.ts" },

  // Subprocess entry-point scripts — top-level `await main()` makes them
  // structurally untestable in-process (same shape as github-actions main.ts).
  // Invoked via `process.execPath <script>` from production code only.
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/sandbox-wrapper.ts" },
  { kind: "exact", path: "packages/sdk/src/testing/sandbox-probe.ts" },
  // Gateway entry point — top-level `await main()` makes in-process testing
  // impossible (same exemption rationale as github-actions/*/src/main.ts).
  // Helpers like `emitSandboxPostureBannerIfDegraded` would need to be
  // extracted to a sibling to test, which is out of scope for this batch.
  { kind: "exact", path: "packages/gateway/src/index.ts" },

  // Type-only files whose runtime emit is empty after TypeScript erasure.
  // These don't match the `**/*types*.ts` basename regex below but follow
  // the same exemption rationale — zero executable statements.
  { kind: "exact", path: "packages/gateway/src/connectors/lazy-mesh/slot.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/server/options.ts" },

  // Reference benches — run via `nimbus bench` interactive protocol, not bun test.
  { kind: "dirPrefix", prefix: "packages/gateway/src/perf/" },

  // C-language helper binary (T2 PR 1 sandbox). Not in the TS source
  // walker by extension, so this dirPrefix entry is purely to satisfy
  // the directional parity check against the Sonar coverage exclusion
  // for the same path. Real C coverage measurement happens via cppcheck
  // in the linux-sandbox-helper-setup CI step, not lcov.
  { kind: "dirPrefix", prefix: "packages/gateway/src-native/" },

  // SQL migration constants — one big template string per file, no executable JS.
  { kind: "pathRegex", re: /^packages\/gateway\/src\/index\/[^/]+-v\d+-sql\.ts$/ },

  // Type-only declaration files.
  { kind: "basenameRegex", re: /^types\.ts$/ },
  { kind: "basenameRegex", re: /-types\.ts$/ },

  // GitHub Actions entry points — top-level `await main()` makes in-process
  // testing impossible; helpers extracted to siblings (precedent: PR #326).
  { kind: "pathRegex", re: /^packages\/github-actions\/[^/]+\/src\/main\.ts$/ },
]);

export function isExempt(relPath: string): boolean {
  const normalized = relPath.replaceAll("\\", "/");
  const basename = normalized.split("/").pop() ?? "";
  for (const pattern of EXCLUSIONS) {
    switch (pattern.kind) {
      case "exact":
        if (normalized === pattern.path) return true;
        break;
      case "dirPrefix":
        if (normalized.startsWith(pattern.prefix)) return true;
        break;
      case "basenameRegex":
        if (pattern.re.test(basename)) return true;
        break;
      case "pathRegex":
        if (pattern.re.test(normalized)) return true;
        break;
    }
  }
  return false;
}
