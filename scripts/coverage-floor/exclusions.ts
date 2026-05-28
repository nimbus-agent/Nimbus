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
  // Windows-only FFI pointer helper — imported only by vault/win32.ts, which is
  // itself excluded above. On Linux/macOS CI the file is never loaded, so its
  // lcov entry is always 0/0. Parallel to the vault/win32.ts exclusion rationale.
  { kind: "exact", path: "packages/gateway/src/vault/ffi-ptr.ts" },
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
  // Async per-OS dispatchers — same shape as platform/sandbox/sandbox-runner.ts
  // above. Each calls `await import("./<os>.ts").<factory>(...)`. The tests
  // mock `node:os` to hit the freebsd default branch (PlatformInitError), so
  // that arm IS covered — but the three OS-specific arms each require a
  // native runtime to load (DPAPI / Keychain / libsecret / onnxruntime-node),
  // so any single CI OS runner reaches at most one of the three. Coverage
  // tops out near 33% regardless of mocking quality. Structurally excluded
  // for the same reason as sandbox-runner.ts.
  { kind: "exact", path: "packages/gateway/src/platform/index.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/factory.ts" },
  // Pure re-export module — `export type { ... }` + `export { fn } from "./..."`
  // produces no executable code in TypeScript erasure. Bun's V8 coverage
  // emits no lcov entries for this file.
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/index.ts" },
  // Pure re-export barrel — only `export { ... } from "./..."` statements;
  // zero runtime emit after TypeScript erasure. Same rationale as
  // platform/sandbox/index.ts above.
  { kind: "exact", path: "packages/gateway/src/connectors/index.ts" },
  // Client package re-export barrel + the askStream type union — pure
  // `export … from` / `export type` with zero runtime emit after TS erasure.
  // Same rationale as connectors/index.ts. `stream-events.ts` does not match
  // the types.ts/-types.ts basename regexes, so it needs an exact entry.
  { kind: "exact", path: "packages/client/src/index.ts" },
  { kind: "exact", path: "packages/client/src/stream-events.ts" },
  // SDK ipc barrel — re-exports ndjson-line-reader.js only; zero runtime emit.
  { kind: "exact", path: "packages/sdk/src/ipc/index.ts" },

  // Subprocess entry-point scripts — top-level `await main()` makes them
  // structurally untestable in-process (same shape as github-actions main.ts).
  // Invoked via `process.execPath <script>` from production code only.
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/sandbox-wrapper.ts" },
  { kind: "exact", path: "packages/sdk/src/testing/sandbox-probe.ts" },
  // Bun Worker entry points — top-level `onmessage = ...` handler; the module
  // is loaded inside a `new Worker(...)` subprocess, not via `import`. Running
  // it in-process during tests would bypass the Worker message boundary and
  // produce no coverage anyway. Same shape as sandbox-wrapper.ts / sandbox-probe.ts.
  { kind: "exact", path: "packages/gateway/src/db/query-guard-worker.ts" },
  { kind: "exact", path: "packages/gateway/src/embedding/embedding-worker.ts" },
  // The @xenova/transformers dynamic-import boundary — onnxruntime-node cannot
  // load under `bun test`. model.ts is unit-tested by mocking this shim's path.
  {
    kind: "exact",
    path: "packages/gateway/src/embedding/load-feature-extraction-pipeline.ts",
  },
  // Gateway entry point — top-level `await main()` makes in-process testing
  // impossible (same exemption rationale as github-actions/*/src/main.ts).
  // Helpers like `emitSandboxPostureBannerIfDegraded` would need to be
  // extracted to a sibling to test, which is out of scope for this batch.
  { kind: "exact", path: "packages/gateway/src/index.ts" },
  // CLI entry point — top-level `await main()` makes in-process testing
  // impossible (same exemption rationale as gateway/src/index.ts above and
  // github-actions/*/src/main.ts below). The CLI's argv-dispatch flow is
  // covered indirectly by every command's per-sub-handler tests in
  // packages/cli/src/commands/*.test.ts.
  { kind: "exact", path: "packages/cli/src/index.ts" },
  // CLI lifecycle/render entry shims (Phase 8 — coverage-floor closeout).
  // gateway-process.ts: intentional byte-for-byte duplicate of
  // gw-state-helpers.ts. The shared CLI harness `mock.module`s this exact
  // path, shadowing its body in nearly every command test; the identical
  // logic is fully branch-covered by gateway-process.test.ts against the
  // un-mocked twin. The two files must stay separate module records (ESM
  // re-export live-binding propagation defeats the mock isolation on
  // Linux/macOS).
  { kind: "exact", path: "packages/cli/src/lib/gateway-process.ts" },
  // start.ts: dominant uncovered region (spawnGateway detached subprocess +
  // waitForGatewayReady real-socket poll + 30-iteration onboarding IPCClient
  // loop) is structurally unrunnable in a single Ubuntu CI run. The pure
  // decision layer (decideStartAction, wantsNoWizard) is tested in
  // start.test.ts. Same rationale as the gateway/src/index.ts top-level
  // `await main()` exclusion.
  { kind: "exact", path: "packages/cli/src/commands/start.ts" },
  // tui.tsx: Ink render shim — inkRender(<App/>) + ink.waitUntilExit() +
  // signal handlers need a real TTY + raw-mode stdin. The dispatch branches
  // (--help, gateway-missing, fallback-to-REPL) are covered by tui.test.tsx;
  // the Ink surface is covered by the e2e suite. `.tsx` matches no existing
  // regex, so an exact entry is required.
  { kind: "exact", path: "packages/cli/src/commands/tui.tsx" },
  // repl.ts: thin production-wiring shim over repl-core.ts (same split as
  // gateway-process.ts ↔ gw-state-helpers.ts above). repl.ts statically
  // imports the cli-mocks-mocked modules (ipc-client, gateway-process, and
  // @clack/prompts via interactive-ipc-handlers) to build the production
  // ReplCoreDeps, which places it in Bun's mock-resolution blast radius — a
  // colocated test against it failed intermittently on CI (macOS link error
  // "Export named 'loadReplPreconditions' not found"; Linux coverage drop
  // below the floor). All logic lives in repl-core.ts and is fully covered by
  // repl-core.test.ts against the un-mocked, DI'd twin; this shim is pure
  // wiring with no testable branches.
  { kind: "exact", path: "packages/cli/src/commands/repl.ts" },
  // doctor.ts: thin production-wiring shim over doctor-core.ts (identical
  // pattern to repl.ts above). doctor.ts statically imports paths.ts,
  // gateway-process.ts, and ipc-client/index.ts to build the production
  // DoctorCoreDeps. paths.ts in particular has three platform branches
  // (win32/darwin/linux) and naturally line-covers ~45 % on any single OS;
  // when pulled into the per-gate `test:coverage:doctor` scope it dragged
  // `All files` below the 80 % bun-threshold on Linux CI even though the real
  // target (doctor.ts) was at ~83 %. All logic lives in doctor-core.ts and is
  // fully covered by doctor-core.test.ts against an un-mocked, DI'd twin;
  // this shim is pure wiring with no testable branches.
  { kind: "exact", path: "packages/cli/src/commands/doctor.ts" },

  // Type-only files whose runtime emit is empty after TypeScript erasure.
  // These don't match the `**/*types*.ts` basename regex below but follow
  // the same exemption rationale — zero executable statements.
  { kind: "exact", path: "packages/gateway/src/connectors/lazy-mesh/slot.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/server/options.ts" },
  // Interface-only / type-only files — no runtime-executable statements after
  // TypeScript erasure. Bun's V8 coverage reports 0/0 lines for these.
  // Parallel to lazy-mesh/slot.ts and ipc/server/options.ts above.
  { kind: "exact", path: "packages/gateway/src/embedding/embedding-runtime.ts" },
  { kind: "exact", path: "packages/gateway/src/index/ranked-item.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/nimbus-vault.ts" },
  // IPC invocation-context type aliases — `export type` declarations only.
  // The dispatchers (agents-rpc, automation-rpc, connector-rpc) consume
  // these contexts; the type files themselves emit nothing at runtime so
  // their lcov entry is always 0/0. Coverage floor was treating them as
  // baseline 0% entries before this exemption.
  { kind: "exact", path: "packages/gateway/src/ipc/agent-invoke.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/workflow-invoke.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/connector-rpc-handlers/context.ts" },

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

  // MCP connector entry-point scripts — each ends with top-level
  // `await mcp.connect(new StdioServerTransport())`, which can only run
  // under the sandbox harness (`NIMBUS_TEST_HARNESS=1`). The pure
  // helpers the file imports (`search-filter.ts` et al.) are
  // unit-tested separately, but the connect() site itself is
  // structurally unreachable from the in-process test layer. Same
  // shape as `github-actions/*/src/main.ts` (already excluded).
  { kind: "pathRegex", re: /^packages\/mcp-connectors\/[^/]+\/src\/server\.ts$/ },
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
