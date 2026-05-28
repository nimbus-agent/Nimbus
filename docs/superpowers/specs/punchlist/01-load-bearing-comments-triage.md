# Section 1 triage

Drives Pass 2 docs migration. One row per source-1 entry.

## Summary

- Total rows: 277
- `[DOCS:...]` (migrate in Pass 2): 215
- `[DELETE-ONLY]` (strip in Pass 3, no migration): 51
- `[N/A]` (false positive): 11

Counts by target doc:

- `docs/SECURITY-INVARIANTS.md`: 192
- `docs/architecture.md`: 4
- `docs/internals/test-fixtures.md`: 9
- `docs/internals/known-todos.md`: 4
- `docs/internals/upstream-workarounds.md`: 1
- `docs/internals/platform-quirks.md`: 2
- `docs/connectors/<name>.md` (multiple): 3 — github, vercel, slack

## Decisions

### BUG-ref (13)

All 13 are regression-coverage comments or fix-tracking references documenting already-shipped bug fixes. No future task, no rationale to migrate.

- `packages/cli/src/commands/data.ts:39` → `[DELETE-ONLY]`
- `packages/cli/src/lib/interactive-ipc-handlers.test.ts:2` → `[DELETE-ONLY]`
- `packages/cli/src/tui/App.test.tsx:162` → `[DELETE-ONLY]`
- `packages/cli/src/tui/App.tsx:215` → `[DELETE-ONLY]`
- `packages/cli/src/tui/App.tsx:339` → `[DELETE-ONLY]`
- `packages/cli/src/tui/ConnectorHealth.test.tsx:21` → `[DELETE-ONLY]`
- `packages/cli/src/tui/ConnectorHealth.test.tsx:88` → `[DELETE-ONLY]`
- `packages/cli/src/tui/ConnectorHealth.tsx:13` → `[DELETE-ONLY]`
- `packages/cli/test/integration/cli-banner-suppression.integration.test.ts:2` → `[DELETE-ONLY]`
- `packages/gateway/src/engine/run-ask.ts:28` → `[DELETE-ONLY]`
- `packages/gateway/src/engine/run-conversational-agent.ts:19` → `[DELETE-ONLY]`
- `packages/gateway/src/engine/run-conversational-agent.ts:72` → `[DELETE-ONLY]`
- `packages/gateway/src/platform/assemble.ts:189` → `[DELETE-ONLY]`

### HITL (130)

- `packages/cli/src/commands/data.ts:36` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/cli/src/lib/interactive-ipc-handlers.test.ts:5` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/cli/src/lib/interactive-ipc-handlers.ts:17` → `[DELETE-ONLY]`
- `packages/cli/src/lib/interactive-ipc-handlers.ts:35` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/cli/src/tui/App.test.tsx:188` → `[DELETE-ONLY]`
- `packages/cli/src/tui/App.test.tsx:433` → `[DELETE-ONLY]`
- `packages/cli/src/tui/QueryInput.tsx:146` → `[DELETE-ONLY]`
- `packages/client/src/stream-events.ts:38` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/client/src/stream-events.ts:39` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/client/test/node-compat.test.ts:206` → `[DOCS:docs/internals/test-fixtures.md]`
- `packages/client/test/node-compat.test.ts:208` → `[DELETE-ONLY]`
- `packages/gateway/src/automation/workflow-hitl-preview.ts:2` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/automation/workflow-hitl-preview.ts:106` → `[DELETE-ONLY]`
- `packages/gateway/src/automation/workflow-runner.ts:132` → `[DELETE-ONLY]`
- `packages/gateway/src/connectors/registry.ts:50` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:54` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:57` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:60` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:63` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:68` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:72` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:74` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:77` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:80` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:84` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:86` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:89` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:93` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:97` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:100` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:103` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:106` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:110` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:114` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:117` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:120` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/registry.ts:123` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/engine/agent.ts:440` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/engine/audit-payload-safety.test.ts:14` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/engine/executor.ts:16` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/engine/executor.ts:17` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/engine/executor.ts:194` → `[DELETE-ONLY]`
- `packages/gateway/src/engine/index.ts:8` → `[DELETE-ONLY]`
- `packages/gateway/src/engine/run-ask.ts:209` → `[DELETE-ONLY]`
- `packages/gateway/src/engine/tool-output-envelope.ts:6` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/engine/types.ts:22` → `[DELETE-ONLY]`
- `packages/gateway/src/extensions/auto-update-permissions-diff.ts:16` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/extensions/auto-update-types.ts:12` → `[DELETE-ONLY]`
- `packages/gateway/src/extensions/auto-update-types.ts:40` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/extensions/auto-update-types.ts:47` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/extensions/dependency-graph.ts:126` → `[DELETE-ONLY]`
- `packages/gateway/src/extensions/dependency-types.ts:48` → `[DELETE-ONLY]`
- `packages/gateway/src/extensions/manifest.ts:60` → `[DELETE-ONLY]`
- `packages/gateway/src/extensions/permissions-validator.ts:29` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/index.ts:62` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/consent.ts:29` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/consent.ts:32` → `[DELETE-ONLY]`
- `packages/gateway/src/ipc/data-rpc.test.ts:25` → `[DOCS:docs/internals/test-fixtures.md]`
- `packages/gateway/src/ipc/data-rpc.ts:23` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/lan-rpc.ts:21` → `[DELETE-ONLY]`
- `packages/gateway/src/ipc/reindex-rpc.test.ts:56` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/reindex-rpc.ts:8` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/server/dispatchers.ts:284` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/server/vault-dispatch.ts:22` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/server/vault-dispatch.ts:101` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/perf/surfaces/bench-hitl-popup.ts:2` → `[DELETE-ONLY]`
- `packages/gateway/src/security-invariants.test.ts:78` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/watcher/anomaly-detector.ts:2` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/test/e2e/scenarios/catchup.e2e.test.ts:7` → `[DELETE-ONLY]`
- `packages/gateway/test/e2e/scenarios/expert.e2e.test.ts:6` → `[DELETE-ONLY]`
- `packages/gateway/test/e2e/scenarios/hitl-write-ops.test.ts:2` → `[DELETE-ONLY]`
- `packages/gateway/test/e2e/scenarios/hitl-write-ops.test.ts:17` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/test/e2e/scenarios/hitl-write-ops.test.ts:34` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/test/e2e/scenarios/impact.e2e.test.ts:7` → `[DELETE-ONLY]`
- `packages/mcp-connectors/aws/src/server.ts:2` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/azure/src/server.ts:2` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/bitbucket/src/server.ts:4` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/circleci/src/server.ts:3` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/confluence/src/server.ts:4` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/gcp/src/server.ts:2` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/github/src/server.ts:4` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/github-actions/src/server.ts:3` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/gitlab/src/server.ts:4` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/gitlab/src/server.ts:5` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/gmail/src/server.ts:4` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/google-drive/src/server.ts:4` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/google-drive/src/server.ts:432` → `[N/A]`
- `packages/mcp-connectors/google-drive/src/server.ts:464` → `[N/A]`
- `packages/mcp-connectors/google-drive/src/server.ts:485` → `[N/A]`
- `packages/mcp-connectors/google-drive/src/server.ts:518` → `[N/A]`
- `packages/mcp-connectors/iac/src/server.ts:2` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/jenkins/src/server.ts:3` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/jira/src/server.ts:4` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/kubernetes/src/server.ts:2` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/linear/src/server.ts:4` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/notion/src/server.ts:3` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/obsidian/src/server.ts:11` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/obsidian/src/server.ts:13` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/obsidian/src/server.ts:67` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/obsidian/src/server.ts:342` → `[DELETE-ONLY]`
- `packages/mcp-connectors/obsidian/src/server.ts:410` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/onedrive/src/server.ts:4` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/outlook/src/server.ts:7` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/pagerduty/src/server.ts:3` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/slack/src/server.ts:4` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/mcp-connectors/teams/src/server.ts:3` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/ui/src/components/hitl/StructuredPreview.tsx:6` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/ui/src/components/hitl/StructuredPreview.tsx:84` → `[DELETE-ONLY]`
- `packages/ui/src/components/PendingUpdates.tsx:9` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/ui/src/lib/restart.ts:7` → `[DOCS:docs/architecture.md]`
- `packages/ui/src/store/partialize.ts:5` → `[DOCS:docs/architecture.md]`
- `packages/ui/src-tauri/src/gateway_bridge.rs:152` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/ui/src-tauri/src/gateway_bridge.rs:591` → `[DOCS:docs/architecture.md]`
- `packages/vscode-extension/src/chat/webview/main.ts:8` → `[DELETE-ONLY]`
- `packages/vscode-extension/src/chat/webview/main.ts:9` → `[DELETE-ONLY]`
- `packages/vscode-extension/src/chat/webview/main.ts:315` → `[DELETE-ONLY]`
- `packages/vscode-extension/src/chat/webview/render.ts:88` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/vscode-extension/src/extension.ts:16` → `[DOCS:docs/internals/known-todos.md]`
- `packages/vscode-extension/src/extension.ts:71` → `[DELETE-ONLY]`
- `packages/vscode-extension/src/extension.ts:171` → `[DELETE-ONLY]`
- `packages/vscode-extension/src/extension.ts:248` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/vscode-extension/src/extension.ts:260` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/vscode-extension/src/extension.ts:453` → `[DELETE-ONLY]`
- `packages/vscode-extension/src/extension.ts:483` → `[DOCS:docs/internals/known-todos.md]`
- `packages/vscode-extension/src/extension.ts:490` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/vscode-extension/src/extension.ts:515` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/vscode-extension/src/extension.ts:520` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/vscode-extension/src/hitl/hitl-details-webview.ts:6` → `[DELETE-ONLY]`
- `packages/vscode-extension/test/unit/inline-hitl.test.ts:2` → `[DELETE-ONLY]`
- `scripts/cast-driver/fake-gateway.ts:7` → `[DELETE-ONLY]`

### I-numbered (87)

All 87 reference valid invariant numbers (I1–I16) and carry rationale that belongs in `docs/SECURITY-INVARIANTS.md`.

- `packages/cli/src/commands/deploy-annotate.ts:14` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/agents/_lib/synthesize.ts:42` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/automation/extension-store.ts:40` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts:29` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts:32` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts:49` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts:53` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts:597` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts:759` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts:10` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts:12` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts:590` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/mesh.test.ts:191` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/mesh.test.ts:248` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/mesh.test.ts:396` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/mesh.ts:82` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/phase3-config.test.ts:12` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts:14` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts:137` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts:424` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts:450` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts:503` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts:533` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts:566` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts:595` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts:804` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/slot.ts:43` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/user-mcp.ts:15` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/user-mcp.ts:106` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts:3` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts:29` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts:89` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/deployment/types.ts:5` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/engine/agent.ts:446` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/extensions/auto-update-orchestrate.ts:50` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/extensions/auto-update-rpc.ts:24` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/extensions/install-from-local.ts:120` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/extensions/install-from-local.ts:404` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/extensions/install-from-local.ts:556` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/extensions/install-from-local.ts:558` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/extensions/verify-extensions.ts:402` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/extensions/verify-extensions.ts:421` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/extensions/verify-extensions.ts:468` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/extensions/verify-signature.ts:6` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/index/tool-call-log-v29-sql.ts:3` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/index/tool-call-log-v29-sql.ts:9` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/automation-rpc.ts:97` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/automation-rpc.ts:99` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/automation-rpc.ts:101` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/automation-rpc.ts:431` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/automation-rpc.ts:433` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/automation-rpc.ts:435` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/deployment-rpc.ts:5` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/http-routes.ts:5` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/http-routes.ts:13` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/http-server.ts:323` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/http-write-routes.test.ts:15` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/http-write-routes.ts:2` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/people-rpc.test.ts:8` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/preflight-rpc.ts:5` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/security-rpc.ts:7` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/server/dispatchers.ts:609` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/server/options.ts:78` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/server/options.ts:84` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/platform/sandbox/sandbox-runner.ts:8` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/platform/sandbox/sandbox-wrapper.ts:5` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/platform/sandbox/seccomp-filter.ts:2` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/search/vec-store.ts:16` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/util/timing-safe-compare.ts:32` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/test/e2e/scenarios/dependency-lifecycle.e2e.test.ts:43` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/test/integration/db/disk-full-propagation.test.ts:296` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/test/integration/deployment/i11-envelope.test.ts:2` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/test/integration/deployment/i11-envelope.test.ts:6` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/test/unit/connectors/lazy-mesh/connector-spawns.test.ts:9` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/test/unit/connectors/lazy-mesh/connector-spawns.test.ts:208` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/test/unit/connectors/lazy-mesh/connector-spawns.test.ts:209` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/test/unit/connectors/lazy-mesh/connector-spawns.test.ts:251` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/test/unit/connectors/lazy-mesh/connector-spawns.test.ts:365` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/github-actions/annotate-action/src/main.ts:289` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/sdk/src/crypto/canonical-json.ts:4` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/sdk/src/crypto/canonical-json.ts:56` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/sdk/src/crypto/verify-signature.ts:4` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `scripts/package-linux-installers.ts:339` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `scripts/structure-audit/check-nimbus-invariants.ts:6` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `scripts/structure-audit/check-nimbus-invariants.ts:66` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `scripts/structure-audit/check-nimbus-invariants.ts:72` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `scripts/structure-audit/check-nimbus-invariants.ts:73` → `[DOCS:docs/SECURITY-INVARIANTS.md]`

### NOTE (6)

- `packages/gateway/src/connectors/github-sync.ts:65` → `[DOCS:docs/connectors/github.md]`
- `packages/gateway/src/connectors/vercel-deployment-mapping.ts:9` → `[DOCS:docs/connectors/vercel.md]`
- `packages/gateway/src/ipc/server/inline-handlers.ts:301` → `[DOCS:docs/architecture.md]`
- `packages/gateway/test/unit/connectors/slack-sync.test.ts:516` → `[DOCS:docs/connectors/slack.md]`
- `scripts/cast-driver/harness.ts:25` → `[DOCS:docs/internals/platform-quirks.md]`
- `scripts/cast-driver/harness.ts:66` → `[DOCS:docs/internals/platform-quirks.md]`

### TODO (2)

- `packages/gateway/src/connectors/lazy-mesh/user-mcp.ts:34` → `[DOCS:docs/internals/known-todos.md]`
- `packages/gateway/test/unit/connectors/bitbucket-sync.test.ts:375` → `[DOCS:docs/internals/known-todos.md]`

### WORKAROUND (1)

- `packages/gateway/src/platform/platform.test.ts:41` → `[DOCS:docs/internals/upstream-workarounds.md]`

### security/timing (29)

- `packages/cli/src/commands/extension-sync.test.ts:85` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/cli/src/commands/update.test.ts:55` → `[DOCS:docs/internals/test-fixtures.md]`
- `packages/gateway/src/agents/impact.test.ts:71` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/automation/graph-predicate.ts:184` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/embedding/create-routing-runtime.test.ts:35` → `[DOCS:docs/internals/test-fixtures.md]`
- `packages/gateway/src/embedding/lazy-scheduler.test.ts:462` → `[DOCS:docs/internals/test-fixtures.md]`
- `packages/gateway/src/embedding/model.test.ts:9` → `[DOCS:docs/internals/test-fixtures.md]`
- `packages/gateway/src/embedding/model.ts:57` → `[DOCS:docs/internals/test-fixtures.md]`
- `packages/gateway/src/extensions/auto-update-apply.ts:4` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/extensions/spawn-env.ts:3` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/extensions/verify-extensions.ts:162` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/http-auth.ts:8` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/lan-rpc.ts:17` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/ipc/lan-server.ts:160` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/memory/session-memory-store.test.ts:79` → `[DELETE-ONLY]`
- `packages/gateway/src/perf/surfaces/bench-sqlite-contention.ts:43` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/platform/assemble.ts:463` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/platform/platform.test.ts:49` → `[DELETE-ONLY]`
- `packages/gateway/src/platform/worker-security.test.ts:12` → `[DOCS:docs/internals/test-fixtures.md]`
- `packages/gateway/src/updater/updater.ts:172` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/util/timing-safe-compare.ts:4` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/util/timing-safe-compare.ts:7` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/util/timing-safe-compare.ts:11` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/util/timing-safe-compare.ts:30` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/src/util/timing-safe-compare.ts:33` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/test/integration/connectors/pipedrive-sync-fake-server.test.ts:101` → `[DOCS:docs/internals/test-fixtures.md]`
- `packages/gateway/test/integration/connectors/pipedrive-sync-fake-server.test.ts:305` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `packages/gateway/test/unit/connectors/lazy-mesh/connector-spawns.test.ts:10` → `[DOCS:docs/SECURITY-INVARIANTS.md]`
- `scripts/cast-driver/fake-gateway.ts:111` → `[DELETE-ONLY]`

### ticket-ref (9)

- `packages/gateway/src/agents/impact.ts:152` → `[N/A]`
- `packages/gateway/src/agents/impact.ts:166` → `[N/A]`
- `packages/gateway/src/agents/_lib/findings.ts:6` → `[N/A]`
- `packages/gateway/src/ipc/server/server.ts:85` → `[DELETE-ONLY]`
- `packages/gateway/test/unit/connectors/bitbucket-sync.test.ts:723` → `[N/A]`
- `scripts/coverage-floor/exclusions.ts:191` → `[DELETE-ONLY]`
- `scripts/structure-audit/lib.ts:124` → `[N/A]`
- `scripts/structure-audit/lib.ts:125` → `[N/A]`
- `scripts/structure-audit/lib.ts:130` → `[N/A]`
