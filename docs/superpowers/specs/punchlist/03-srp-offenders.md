# Punch list — section 3: SRP offenders (>500 LOC)

Total files: 58

| File | LOC | Exports | Names (first 8) |
|---|---|---|---|
| `packages/gateway/test/unit/ipc/connector-rpc-handlers/auth.test.ts` | 1761 | 0 |  |
| `packages/gateway/src/connectors/lazy-mesh/phase3-config.test.ts` | 1567 | 0 |  |
| `packages/cli/src/commands/connector.ts` | 1238 | 1 | runConnector |
| `packages/gateway/src/config/nimbus-toml.ts` | 1149 | 53 | NimbusEmbeddingToml, DEFAULT_NIMBUS_EMBEDDING_TOML, parseNimbusTomlEmbeddingSection, resolveNimbusTomlForProfile, loadNimbusEmbeddingFromPath, loadNimbusEmbeddingFromConfigDir, NimbusLlmToml, DEFAULT_NIMBUS_LLM_TOML… |
| `packages/gateway/src/extensions/install-from-local.test.ts` | 1148 | 0 |  |
| `packages/gateway/src/engine/engine.test.ts` | 1106 | 0 |  |
| `packages/gateway/src/engine/agent.test.ts` | 1057 | 0 |  |
| `packages/gateway/src/index/local-index.ts` | 1011 | 9 | SearchRankOptions, AuditEntry, IndexSearchQuery, SemanticSearchDeps, LocalIndexOptions, LanPeerRow, CURRENT_SCHEMA_VERSION, isAllowedMetaKey… |
| `packages/gateway/src/ipc/automation-rpc.test.ts` | 998 | 0 |  |
| `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts` | 981 | 35 | phase3AddAwsMcp, phase3AddAzureMcp, phase3AddGcpMcp, phase3AddIacMcp, phase3AddGrafanaMcp, phase3AddSentryMcp, phase3AddNewrelicMcp, phase3AddDatadogMcp… |
| `packages/gateway/src/ipc/diagnostics-rpc.test.ts` | 960 | 0 |  |
| `packages/gateway/test/unit/connectors/github-sync.test.ts` | 941 | 0 |  |
| `packages/gateway/test/unit/connectors/slack-sync.test.ts` | 932 | 0 |  |
| `packages/gateway/test/unit/connectors/lazy-mesh/connector-spawns.test.ts` | 913 | 0 |  |
| `packages/cli/src/commands/extension.test.ts` | 848 | 0 |  |
| `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts` | 840 | 18 | ensurePhase3BundleMcp, ensureGoogleDriveMcp, ensureMicrosoftBundleMcp, ensureGithubMcp, ensureGitlabMcp, ensureBitbucketMcp, ensureSlackMcp, ensureLinearMcp… |
| `packages/gateway/test/unit/auth/pkce.test.ts` | 840 | 0 |  |
| `packages/gateway/test/unit/connectors/gitlab-sync.test.ts` | 834 | 0 |  |
| `packages/gateway/src/extensions/install-from-local.ts` | 809 | 5 | resolveSystemTarCommand, assertSafeExtensionId, extensionInstallDirectory, InstallExtensionFromLocalResult, installExtensionFromLocalDirectory |
| `packages/cli/src/commands/extension.ts` | 803 | 31 | hasFlag, takeFlagValue, stripFlags, ExtensionListTableRow, formatExtensionListTable, runExtensionList, fetchSandboxPosture, formatExtensionInfoHuman… |
| `packages/gateway/src/engine/router.test.ts` | 799 | 0 |  |
| `packages/gateway/test/unit/connectors/bitbucket-sync.test.ts` | 776 | 0 |  |
| `packages/cli/src/commands/connector.test.ts` | 767 | 0 |  |
| `packages/gateway/src/ipc/server/dispatchers.ts` | 754 | 20 | tryDispatchLlmRpc, tryDispatchAgentsRpc, tryDispatchVoiceRpc, tryDispatchUpdaterRpc, tryDispatchAuditRpc, tryDispatchSecurityRpc, tryDispatchMetricsRpc, tryDispatchPreflightRpc… |
| `packages/gateway/src/index/migrations/runner.ts` | 731 | 4 | readIndexedUserVersion, MigrationBackupOptions, MigrationRollbackError, runIndexedSchemaMigrations |
| `packages/gateway/src/sync/scheduler.ts` | 726 | 1 | SyncScheduler |
| `packages/vscode-extension/src/extension.ts` | 716 | 6 | ActivateDeps, activateWithDeps, activate, deactivate, InlineHitlReq, createInlineHitlSurface |
| `packages/gateway/src/extensions/verify-extensions.test.ts` | 706 | 0 |  |
| `packages/gateway/src/ipc/server/dispatchers.test.ts` | 704 | 0 |  |
| `packages/gateway/src/ipc/connector-rpc-handlers/auth.ts` | 690 | 1 | handleConnectorAuth |
| `packages/gateway/test/unit/connectors/github-actions-sync.test.ts` | 656 | 0 |  |
| `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts` | 653 | 4 | FIRST_PARTY_MANIFESTS, manifestForFirstParty, hostnameFromUrl, manifestWithExtraNetworkHosts |
| `packages/gateway/test/unit/metrics/dora.test.ts` | 652 | 0 |  |
| `packages/gateway/src/connectors/gitlab-sync.ts` | 640 | 2 | GitlabSyncableOptions, createGitlabSyncable |
| `packages/gateway/src/connectors/lazy-mesh/mesh.test.ts` | 623 | 0 |  |
| `packages/gateway/src/ipc/ipc.test.ts` | 615 | 0 |  |
| `packages/gateway/test/unit/connectors/jenkins-sync.test.ts` | 607 | 0 |  |
| `packages/gateway/src/telemetry/flush-scheduler.test.ts` | 597 | 0 |  |
| `packages/gateway/test/unit/preflight/preflight.test.ts` | 593 | 0 |  |
| `packages/gateway/src/ipc/diagnostics-rpc.ts` | 590 | 4 | DiagnosticsRpcError, DiagnosticsRpcContext, buildSandboxDiagPayload, dispatchDiagnosticsRpc |
| `packages/gateway/test/unit/connectors/discord-sync.test.ts` | 579 | 0 |  |
| `packages/gateway/src/extensions/verify-extensions.ts` | 571 | 4 | ExtensionMeshHandle, verifyOneExtensionStrict, VerifyExtensionsSignatureOpts, verifyExtensionsBestEffort |
| `packages/ui/src/ipc/client.ts` | 559 | 3 | NimbusIpcClient, createIpcClient, __resetIpcClientForTests |
| `packages/gateway/src/updater/updater.test.ts` | 553 | 0 |  |
| `packages/gateway/src/connectors/gmail-sync.ts` | 552 | 5 | GmailSyncCursorV1, encodeGmailSyncCursor, decodeGmailSyncCursor, GmailSyncableOptions, createGmailSyncable |
| `packages/gateway/src/connectors/teams-sync.ts` | 546 | 5 | TeamsSyncCursorV1, encodeTeamsSyncCursor, decodeTeamsSyncCursor, TeamsSyncableOptions, createTeamsSyncable |
| `packages/gateway/test/unit/connectors/lazy-mesh/credential-orchestration.test.ts` | 545 | 0 |  |
| `packages/gateway/src/embedding/lazy-scheduler.test.ts` | 544 | 0 |  |
| `packages/ui/src/ipc/types.ts` | 540 | 77 | ConnectionState, DiagSnapshot, ConnectorHealth, ConnectorSummary, JsonRpcNotification, JsonRpcErrorPayload, MethodNotAllowedError, GatewayOfflineError… |
| `packages/gateway/test/unit/connectors/circleci-sync.test.ts` | 539 | 0 |  |
| `packages/mcp-connectors/google-drive/src/server.ts` | 532 | 0 |  |
| `packages/gateway/src/engine/agent.ts` | 524 | 2 | NimbusEngineAgentDeps, createNimbusEngineAgent |
| `packages/gateway/test/integration/extensions/auto-update-roundtrip.test.ts` | 515 | 0 |  |
| `packages/gateway/src/connectors/github-sync.ts` | 513 | 5 | MergeableStateRefreshInput, shouldRefreshMergeableState, extractPrMetadataForIndex, GithubSyncableOptions, createGithubSyncable |
| `packages/gateway/src/connectors/lazy-mesh/mesh.ts` | 513 | 2 | LazyConnectorMesh, createLazyConnectorMesh |
| `packages/gateway/src/platform/assemble.ts` | 511 | 1 | assemblePlatformServices |
| `packages/gateway/src/connectors/pagerduty-sync.test.ts` | 510 | 0 |  |
| `packages/ui/src/pages/Watchers.tsx` | 505 | 1 | Watchers |

## Triage rule

- LOC>500 + exports>=3 unrelated symbols → split candidate.
- LOC>500 + one cohesive exported class/function → keep but audit for internal SRP.
- LOC>500 in a test file → ignore for pass 5 (tests are frozen).
