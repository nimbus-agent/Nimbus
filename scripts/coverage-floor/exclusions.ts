export type ExclusionPattern =
  | { kind: "exact"; path: string }
  | { kind: "dirPrefix"; prefix: string }
  | { kind: "basenameRegex"; re: RegExp }
  | { kind: "pathRegex"; re: RegExp };

export const EXCLUSIONS: readonly ExclusionPattern[] = Object.freeze([
  { kind: "exact", path: "packages/gateway/src/vault/win32.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/darwin.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/linux.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/ffi-ptr.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/win32.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/darwin.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/linux.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/browser.ts" },

  { kind: "exact", path: "packages/gateway/src/platform/sandbox/linux.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/darwin.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/win32.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/orphan-reap.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/sandbox-runner.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/index.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/factory.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/index.ts" },
  { kind: "exact", path: "packages/gateway/src/connectors/index.ts" },
  { kind: "exact", path: "packages/client/src/index.ts" },
  { kind: "exact", path: "packages/sdk/src/ipc/index.ts" },

  { kind: "exact", path: "packages/gateway/src/platform/sandbox/sandbox-wrapper.ts" },

  // ── Bun Workers (separate realm) ──
  // Bun Workers run in a separate realm the Istanbul `[test].preload` plugin cannot reach (parity
  // with Bun's native --coverage, which also misses workers). §5.3 probe (D3, 2026-06-14): a
  // worker-side preload re-register + __coverage__ flush was attempted; it WORKED mechanically (a
  // worker-spawned via Bun's `preload:` option re-registered the babel-plugin-istanbul Bun loader
  // inside the worker realm, produced a valid istanbul map with real branchMap/branch-hits, and
  // merged cleanly back into the main realm's globalThis.__coverage__ for report-coverage.ts). It
  // was NOT durably wired: doing so would thread a test-only `preload:` injection seam plus a
  // coverage-message merge protocol through the two PRODUCTION worker spawn sites
  // (db/query-guard.ts, embedding/worker-bridge.ts) and each worker's onmessage contract —
  // invasive cross-realm scaffolding in production I/O shells, and a divergence from Bun-native
  // --coverage parity, for no real gain. The meaningful orchestration was extracted to the
  // unit-tested `embedding/embedding-worker-core.ts` (NOT excluded), leaving:
  //   - `embedding-worker.ts`: a thin wiring shell (constructs real deps, routes origin-validated msgs).
  //   - `query-guard-worker.ts`: a genuinely-thin onmessage (security check lives in worker-security.ts;
  //     opens a readonly DB, runs the SQL, posts back) — nothing to extract.
  { kind: "exact", path: "packages/gateway/src/db/query-guard-worker.ts" },
  { kind: "exact", path: "packages/gateway/src/embedding/embedding-worker.ts" },
  {
    kind: "exact",
    path: "packages/gateway/src/embedding/load-feature-extraction-pipeline.ts",
  },
  { kind: "exact", path: "packages/gateway/src/index.ts" },
  { kind: "exact", path: "packages/cli/src/index.ts" },
  { kind: "exact", path: "packages/cli/src/lib/gateway-process.ts" },
  // `start.ts`: the testable pure helpers (`decideStartAction`, `wantsNoWizard`) are exported +
  // unit-tested by `start.test.ts`; the residual is irreducible subprocess/socket/timer boot glue
  // (`spawnGateway`, the IPC ready-poll race, the TTY onboarding loop) with no injection seam —
  // same untestable I/O-shell class as a connector `server.ts`. (`decideStartAction` is also
  // currently dead — inlined by `handleExistingGatewayState`; a surgical fast-follow can remove it.)
  { kind: "exact", path: "packages/cli/src/commands/start.ts" },
  { kind: "exact", path: "packages/cli/src/commands/tui.tsx" },
  { kind: "exact", path: "packages/cli/src/commands/repl.ts" },
  { kind: "exact", path: "packages/cli/src/commands/doctor.ts" },
  // `assemble-sync-registrations.ts` is boot glue: ~89 hardcoded `syncScheduler.register(...)`
  // calls whose line coverage depends on which connectors the integration/boot tests happen to
  // spawn — it flakes ±0.6% between identical runs, which a one-directional ratchet can't absorb.
  // Same I/O/boot-glue exemption class as assemble.ts.
  { kind: "exact", path: "packages/gateway/src/platform/assemble-sync-registrations.ts" },

  // `policy.ts` / `admin.ts` (Phase 6 Slice 4): the testable cores (parsePolicyArgs/
  // parseAdminArgs + runPolicyCommand/runAdminCommand, injected `client`) are covered by
  // policy.test.ts / admin.test.ts; the residual uncovered lines are the runPolicy/runAdmin
  // wrappers — CLI IPC shells that construct a real `IPCClient` + `process.exit`, no seam.
  // Same exemption class as team.ts.
  { kind: "exact", path: "packages/cli/src/commands/policy.ts" },
  { kind: "exact", path: "packages/cli/src/commands/admin.ts" },

  // `chatops.ts` (Phase 6 Slice 5): the testable cores (parseChatopsArgs + runChatopsCommand
  // with an injected `client`) are covered by chatops.test.ts; the residual uncovered lines are
  // the runChatops wrapper — a CLI IPC shell that reads gateway state, constructs a real
  // `IPCClient`, and calls `process.exit`, with no injection seam. Same exemption class as team.ts.
  { kind: "exact", path: "packages/cli/src/commands/chatops.ts" },

  // `chatops-tool-runner-e2e-sink.ts` (Phase 6 Slice 5): env-gated by `NIMBUS_CHATOPS_E2E_SINK_DIR`
  // (same precedent class as `NIMBUS_SKIP_EMBEDDING_RUNTIME`) and STATICALLY IMPORTED by production boot
  // (`platform/assemble.ts`) — so it is excluded as a genuinely-untestable env-gated shell, NOT relocated
  // (relocating it would point a production import into the coverage-skipped tree). It is the file-backed
  // mock ChatOps transport that stands in for the bot-credentialed connector subprocess in the e2e; inert
  // in a normal boot (the env var is unset). Imports are production-safe: node:fs/node:path + type-only.
  { kind: "exact", path: "packages/gateway/src/chatops/chatops-tool-runner-e2e-sink.ts" },

  // `assemble.ts` is the boot-assembly I/O orchestrator (opens SQLite, spawns sidecars,
  // wires every runtime together) — same untestable shell class as `gateway/src/index.ts`
  // and `ipc/server/options.ts`. The new federation glue block is inert by default
  // (federation.enabled = false); testing it requires a full subprocess boot.
  { kind: "exact", path: "packages/gateway/src/platform/assemble.ts" },

  { kind: "dirPrefix", prefix: "packages/gateway/src/perf/" },

  { kind: "dirPrefix", prefix: "packages/gateway/src-native/" },

  { kind: "pathRegex", re: /^packages\/gateway\/src\/index\/[^/]+-v\d+-sql\.ts$/ },

  { kind: "basenameRegex", re: /^types\.ts$/ },
  { kind: "basenameRegex", re: /-types\.ts$/ },

  // ── Type-only / zero-executable-line modules ──────────────────────────────────────────────────
  // These emit NO `SF:` lcov record (no executable statements) → the gate reads them as 0% and they
  // can NEVER rejoin the floor — same class as the `types.ts` / `-types.ts` basenameRegex above. There
  // is nothing to test. Each file carries a guardian header forbidding runtime logic. No rename
  // (avoids import churn across every consumer for marginal gain).
  { kind: "exact", path: "packages/gateway/src/index/ranked-item.ts" },
  { kind: "exact", path: "packages/gateway/src/embedding/embedding-runtime.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/nimbus-vault.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/agent-invoke.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/workflow-invoke.ts" },
  { kind: "exact", path: "packages/gateway/src/connectors/mapped-row.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/connector-rpc-handlers/context.ts" },
  { kind: "exact", path: "packages/gateway/src/connectors/lazy-mesh/slot.ts" },
  { kind: "exact", path: "packages/gateway/src/chatops/transport/transport.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/server/options.ts" },
  { kind: "exact", path: "packages/client/src/stream-events.ts" },
  // ──────────────────────────────────────────────────────────────────────────────────────────────

  { kind: "pathRegex", re: /^packages\/github-actions\/[^/]+\/src\/main\.ts$/ },

  { kind: "pathRegex", re: /^packages\/mcp-connectors\/[^/]+\/src\/server\.ts$/ },
  // Each MCP connector's `src/tools.ts` is the same connect-shell class as its
  // `server.ts`: thin `reg(name, desc, schema, handler)` registrations whose
  // handlers shell out to a CLI (`Bun.spawn`) or `fetch` a remote API. The
  // testable logic (no-row-data stripping, arg guards, response mapping) lives in
  // shared helpers / sibling modules that ARE covered; the I/O shell is exempt,
  // exactly like server.ts.
  { kind: "pathRegex", re: /^packages\/mcp-connectors\/[^/]+\/src\/tools\.ts$/ },
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
