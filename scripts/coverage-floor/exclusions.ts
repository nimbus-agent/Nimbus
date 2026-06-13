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
  { kind: "exact", path: "packages/gateway/src/connectors/mapped-row.ts" },
  { kind: "exact", path: "packages/client/src/index.ts" },
  { kind: "exact", path: "packages/client/src/stream-events.ts" },
  { kind: "exact", path: "packages/sdk/src/ipc/index.ts" },

  { kind: "exact", path: "packages/gateway/src/platform/sandbox/sandbox-wrapper.ts" },
  { kind: "exact", path: "packages/sdk/src/testing/sandbox-probe.ts" },
  { kind: "exact", path: "packages/gateway/src/db/query-guard-worker.ts" },
  { kind: "exact", path: "packages/gateway/src/embedding/embedding-worker.ts" },
  {
    kind: "exact",
    path: "packages/gateway/src/embedding/load-feature-extraction-pipeline.ts",
  },
  { kind: "exact", path: "packages/gateway/src/index.ts" },
  { kind: "exact", path: "packages/cli/src/index.ts" },
  { kind: "exact", path: "packages/cli/src/lib/gateway-process.ts" },
  { kind: "exact", path: "packages/cli/src/commands/start.ts" },
  { kind: "exact", path: "packages/cli/src/commands/tui.tsx" },
  { kind: "exact", path: "packages/cli/src/commands/repl.ts" },
  { kind: "exact", path: "packages/cli/src/commands/doctor.ts" },
  // `team.ts` runTeam is a CLI IPC command shell (no injection seam); the testable
  // parseTeamArgs is covered by team.test.ts. Same exemption class as start/repl/doctor.
  { kind: "exact", path: "packages/cli/src/commands/team.ts" },
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

  // `chatops-tool-runner-e2e-sink.ts` (Phase 6 Slice 5): a TEST-ONLY file-backed mock ChatOps
  // transport, reachable only via the `NIMBUS_CHATOPS_E2E_SINK_DIR` env seam (same precedent class
  // as `NIMBUS_SKIP_EMBEDDING_RUNTIME`). It stands in for the bot-credentialed connector subprocess
  // so the ChatOps e2e can drive a REAL gateway without the OS sandbox spawn (verified independently
  // by chatops-bot-spawn.test.ts). Not shipped logic — never exercised in a normal gateway boot.
  { kind: "exact", path: "packages/gateway/src/chatops/chatops-tool-runner-e2e-sink.ts" },

  // Test-only support files (imported solely by *.test.ts; not shipped logic). Verified
  // 2026-06-08 by import grep. Sub-project B0; D may relocate these under a `testing/` dir
  // (which discoverSourceFiles already auto-skips) to make the exemption self-enforcing.
  { kind: "exact", path: "packages/cli/src/tui/test-helpers/context.ts" },
  { kind: "exact", path: "packages/cli/src/commands/cli-test-helpers.ts" },
  { kind: "exact", path: "packages/gateway/src/identity/identity-test-helpers.ts" },
  { kind: "exact", path: "packages/gateway/src/updater/updater-test-fixtures.ts" },

  { kind: "exact", path: "packages/gateway/src/connectors/lazy-mesh/slot.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/server/options.ts" },
  // `assemble.ts` is the boot-assembly I/O orchestrator (opens SQLite, spawns sidecars,
  // wires every runtime together) — same untestable shell class as `gateway/src/index.ts`
  // and `ipc/server/options.ts`. The new federation glue block is inert by default
  // (federation.enabled = false); testing it requires a full subprocess boot.
  { kind: "exact", path: "packages/gateway/src/platform/assemble.ts" },
  { kind: "exact", path: "packages/gateway/src/embedding/embedding-runtime.ts" },
  { kind: "exact", path: "packages/gateway/src/index/ranked-item.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/nimbus-vault.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/agent-invoke.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/workflow-invoke.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/connector-rpc-handlers/context.ts" },

  { kind: "dirPrefix", prefix: "packages/gateway/src/perf/" },

  { kind: "dirPrefix", prefix: "packages/gateway/src-native/" },

  { kind: "pathRegex", re: /^packages\/gateway\/src\/index\/[^/]+-v\d+-sql\.ts$/ },

  { kind: "basenameRegex", re: /^types\.ts$/ },
  { kind: "basenameRegex", re: /-types\.ts$/ },

  // `transport.ts` is a types-only module (the `ChatTransport` interface + type re-exports, zero
  // executable lines) — lcov emits no SF: record for it, so the gate reads it as 0%. Same
  // type-only class as the `types.ts` basenameRegex above; excluded for the identical reason.
  { kind: "exact", path: "packages/gateway/src/chatops/transport/transport.ts" },

  { kind: "pathRegex", re: /^packages\/github-actions\/[^/]+\/src\/main\.ts$/ },

  // The gateway-side IMAP fetcher is a thin imapflow socket adapter (constructs
  // `new ImapFlow(...)` and opens a real TLS connection) with no injection seam —
  // the same untestable I/O shell as a connector `server.ts`. The testable logic
  // (mapping, cursor, transient-failure handling) lives in `imap-sync.ts` +
  // `imap-email-mapping.ts`, which ARE covered.
  { kind: "exact", path: "packages/gateway/src/connectors/_lib/imap-client.ts" },

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
