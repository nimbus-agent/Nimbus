---
name: nimbus-file-map
description: >
  Pointer index from "what subsystem owns X" to the file path holding the canonical implementation,
  for the Nimbus monorepo. Use this skill when the user asks "where does X live?" or "where is the
  HITL gate / vault / migration runner / Tauri allowlist / agents directory?", or when you are about
  to grep for an entry-point and would benefit from a curated, semantically-described starting list.
  This is faster and more accurate than `Glob` for high-traffic files like `engine/executor.ts`,
  `vault/index.ts`, `connectors/`, `db/`, `llm/`, `ipc/`, agent surfaces (`agents/expert.ts`,
  `agents/impact.ts`, `agents/_lib/*`), Tauri bridge (`gateway_bridge.rs`), and UI store slices.
  Decay note: the table is curated by hand and lags real changes. If the user asks about something
  recent (last 24 h) or a file you cannot find in the repo, treat the entry as a hint and verify
  with `Glob` / `Grep` before recommending changes.
---

# Nimbus Key File Locations

This is the curated pointer index. Source-of-truth is the working tree — verify a path with `Glob` before relying on it for code changes.

## Engine + Security

| File | Purpose |
|---|---|
| `packages/gateway/src/engine/executor.ts` | HITL gate — `HITL_REQUIRED` frozen set; most security-critical file |
| `packages/gateway/src/engine/coordinator.ts` | `AgentCoordinator` — multi-agent sub-task orchestration, depth + tool-call guards; `executeAll` runs sub-tasks in parallel (Phase 5 T3 PR 1) |
| `packages/gateway/src/engine/sub-agent.ts` | `runSubAgent` — single sub-task executor with `sub_task_results` DB lifecycle |
| `packages/gateway/src/engine/tool-output-envelope.ts` | `wrapToolOutput` — invariant `I11` envelope at the LLM-facing boundary |
| `packages/gateway/src/db/tool-call-log.ts` | `writeToolCallLog` + `readToolCallLog` + `MAX_ENVELOPE_BYTES` — forensic complement to `I11` (Phase 5 T6 PR 2 / V29); called at both `wrapToolOutput` wiring sites in `engine/agent.ts` + `connectors/lazy-mesh/mesh.ts` |
| `packages/gateway/src/index/tool-call-log-v29-sql.ts` | V29 migration SQL — `tool_call_log` table + 3 indexes (`session`, `tool_id+called_at`, `called_at`) |
| `packages/gateway/src/ipc/audit-rpc.ts` | `dispatchAuditRpc` — `audit.verify` / `audit.exportAll` / `audit.getSummary` / `audit.toolCalls` (Phase 5 T6 PR 2). `audit.toolCalls` is IPC-only — NOT LAN-callable (I5), NOT in Tauri allowlist (I7), NOT exposed via the HTTP API |

## Platform Abstraction Layer

| File | Purpose |
|---|---|
| `packages/gateway/src/platform/index.ts` | PAL — `createPlatformServices()` dispatch |
| `packages/gateway/src/platform/win32.ts` | Windows platform implementation |
| `packages/gateway/src/platform/darwin.ts` | macOS platform implementation |
| `packages/gateway/src/platform/linux.ts` | Linux platform implementation |

## Extension Sandbox (T2 PR 1 — invariant `I15`)

| File | Purpose |
|---|---|
| `packages/gateway/src/platform/sandbox/sandbox-runner.ts` | `SandboxRunner` PAL interface + `createSandboxRunner()` dispatcher (I15 entry point). |
| `packages/gateway/src/platform/sandbox/sandbox-wrapper.ts` | Wrapper script invoked by lazy-mesh ServerSpec entries — reads manifest from env, calls `runner.spawn`. **Single I15 execution boundary**. |
| `packages/gateway/src/platform/sandbox/linux.ts` | Linux SandboxRunner — bwrap + nimbus-sandbox-helper + per-host iptables; `decideNetworkMode` + `buildBwrapArgv` exposed for unit tests. |
| `packages/gateway/src/platform/sandbox/darwin.ts` | macOS SandboxRunner — sandbox-exec SBPL profile generator. |
| `packages/gateway/src/platform/sandbox/win32.ts` | Windows SandboxRunner — AppContainer + `internetClient` capability + orphan-reap helpers; FFI WIP. |
| `packages/gateway/src/platform/sandbox/seccomp-filter.ts` | Default Linux seccomp BPF filter — raw bytecode emit, no native libseccomp; includes AUDIT_ARCH_X86_64 guard. |
| `packages/gateway/src/platform/sandbox/orphan-reap.ts` | Windows AppContainer orphan-reap at Gateway startup. |
| `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts` | `wrapServerSpec(spec, manifest, cwd)` — I15 wiring entrypoint for every lazy-mesh ServerSpec. |
| `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts` | Static `FIRST_PARTY_MANIFESTS` registry — per-connector sandbox manifests (T2 PR 1 §6). |
| `packages/gateway/src-native/sandbox-helper/main.c` | Privileged C helper — `cap_net_admin+ep` via setcap; enforce-and-exec mode + `--check-caps` probe; post-unshare AUDIT_ARCH guard + setns/unshare-killer. |
| `packages/sdk/src/testing/sandbox-contract.ts` | `runSandboxContractTests(manifestPath)` — SDK API for first- and third-party connector authors. |
| `docs/sandbox.md` | Operator-facing sandbox reference; `#platform-asymmetry` + `#windows-platform-status` anchors. |

## Extensions — Dependency Resolution (T2 PR 4)

| File | Purpose |
|---|---|
| `packages/gateway/src/extensions/dependency-types.ts` | Solver type contracts: `ResolvedDep`, `ResolvedNode`, `InstallPlan`, `RegistryFetcher`, `ExtensionManifestForSolver`, `ResolveClosureOptions`, `DependencyConstraint`, `DependencyConflict` (T2 PR 4) |
| `packages/gateway/src/extensions/dependency-errors.ts` | `DependencyConflictError` / `OfflineDependencyResolutionError` / `ReverseDepBlockedError` + `is*` narrowing helpers (T2 PR 4) |
| `packages/gateway/src/extensions/dependency-graph.ts` | `resolveClosure(root, fetcher, opts)` — custom backtracking DFS solver; `ancestors: Set` separate from `pinned` so diamond DAGs aren't false-positive cycles (T2 PR 4) |
| `packages/gateway/src/extensions/dependency-store.ts` | `recordInstall` / `clearDeps` / `forwardDeps` / `reverseDeps` — `dbRun`-backed CRUD over V31 `extension_dependency` (T2 PR 4) |
| `packages/gateway/src/extensions/registry-fetcher.ts` | `createRegistryFetcher` — local-first solver adapter; installed ids resolve from on-disk manifest without network (T2 PR 4) |
| `packages/gateway/src/extensions/missing-dependency-registry.ts` | `missingDependencyRegistry` singleton + completeness-guard reason types (parallel to `PreT2DisabledRegistry` + `SignatureDisabledRegistry`, T2 PR 4) |
| `packages/gateway/src/index/extension-dependency-v31-sql.ts` | V31 SQL constant: `extension_dependency` table + `idx_extension_dependency_reverse` index (T2 PR 4) |

## Vault + Auth

| File | Purpose |
|---|---|
| `packages/gateway/src/vault/index.ts` | `NimbusVault` interface |
| `packages/gateway/src/auth/google-access-token.ts` | Google per-service OAuth token resolution — `resolveGoogleOAuthVaultKey()`, `anyGoogleOAuthVaultPresent()` |
| `packages/gateway/src/auth/oauth-vault-tokens.ts` | Generic OAuth token storage/refresh helpers — `getValidVaultOAuthAccessToken()`, `microsoftOAuthAccessFromConfig()` |

## Connectors + MCP Mesh

| File | Purpose |
|---|---|
| `packages/gateway/src/connectors/` | MCP connector mesh (`lazy-mesh/` — Phase 3 bundle spawns AWS/Azure/GCP/IaC/observability MCPs when vault keys exist) |
| `packages/gateway/src/connectors/health.ts` | Connector health state machine — `transitionHealth()`, `ConnectorHealthSnapshot` |
| `packages/gateway/src/connectors/connector-vault.ts` | Per-service OAuth vault key helpers + typed connector-secret reader — `perServiceOAuthVaultKey()`, `writePerServiceOAuthKey()`, `migrateToPerServiceOAuthKeys()`, `readConnectorSecret()` |
| `packages/gateway/src/connectors/connector-secrets-manifest.ts` | `CONNECTOR_VAULT_SECRET_KEYS` — per-connector PAT/API-key vault manifest; `clearConnectorVaultSecretKeys()` |
| `packages/gateway/src/connectors/remove-intent.ts` | Connector removal — cascade vault + index cleanup via `executeRemoveIntent()` |
| `packages/gateway/src/connectors/openapi-indexer-sync.ts` | OpenAPI / AsyncAPI spec indexer (Phase 5 Wave A PR 1); `getLastSyncStats()` exposes skipped-spec counters |
| `packages/gateway/src/connectors/obsidian-sync.ts` | Obsidian vault connector (Phase 5 Wave A PR 2); emits `obsidian_note` items + `backlinks` graph edges |
| `packages/mcp-connectors/obsidian/src/server.ts` | Obsidian MCP server — reads + HITL-gated `obsidian_append_to_daily_note` |
| `packages/gateway/src/connectors/snyk-sync.ts` | Snyk vulnerability connector (Phase 5 T2/Wave-A, 2026-05-21); walks `/v1/orgs → /v1/org/<id>/projects → aggregated-issues`; emits `snyk:vulnerability` items via `mapSnykAggregatedIssueToItem` |
| `packages/gateway/src/connectors/snyk-issue-mapping.ts` | Pure Snyk aggregated-issue → `IndexedItem` mapper; surfaces `{ severity, cve_id, affected_package, fix_available, fix_version, project_url, ... }` in metadata. Unit-tested independently of the HTTP path |
| `packages/mcp-connectors/snyk/src/server.ts` | Snyk MCP server — read-only tools `snyk_list` / `snyk_get` / `snyk_search`. `hitlRequired: []` — `snyk.issue.ignore` is a deferred Phase 8 follow-up |
| `packages/gateway/src/connectors/bitrise-sync.ts` | Bitrise mobile-CI connector (Phase 5 Wave B, 2026-05-21); walks `/v0.1/me/apps → /v0.1/apps/<slug>/builds`; emits `bitrise:app` + `bitrise:build` items via `mapBitriseAppToItem` / `mapBitriseBuildToItem` |
| `packages/gateway/src/connectors/bitrise-build-mapping.ts` | Pure Bitrise app + build → `IndexedItem` mappers; surfaces `{ status, status_code, workflow_id, app_slug, branch, commit_hash, commit_message, triggered_by, pull_request_id, triggered_at, started_at, finished_at, duration_ms }` in metadata. Unit-tested independently of the HTTP path |
| `packages/mcp-connectors/bitrise/src/server.ts` | Bitrise MCP server — read-only tools `bitrise_list` / `bitrise_get` / `bitrise_search`. `hitlRequired: []` — trigger / abort writes are a deferred follow-up |
| `packages/gateway/src/sync/connectivity.ts` | Network connectivity probe — guards the sync scheduler against consuming backoff on offline events |

## Local Index + Migrations + DB

| File | Purpose |
|---|---|
| `packages/gateway/src/index/migrations/runner.ts` | Migration runner; orchestrates `INDEXED_SCHEMA_STEPS`; pre-migration backup; rollback on throw |
| `packages/gateway/src/index/*-v<N>-sql.ts` | Migration SQL constants (e.g., `vec-items-1536-v30-sql.ts`, `obsidian-notes-v26-sql.ts`, `api-endpoint-v25-sql.ts`, `audit-session-v24-sql.ts`, `lan-peers-v19-sql.ts`) |
| `packages/gateway/src/index/vec-items-1536-v30-sql.ts` | V30 migration SQL — `vec_items_1536` virtual table + dim-aware delete triggers (T6 PR 3). |
| `packages/gateway/src/embedding/routing.ts` | `PROSE_HEAVY_TYPES` set + `EMBEDDING_DIM_*` constants + `routingKey` / `isProseHeavy` helpers (T6 PR 3). |
| `packages/gateway/src/embedding/routing-pipeline.ts` | `RoutingEmbeddingPipeline` — wraps two `SqliteEmbeddingPipeline`s and dispatches by `(service, type)` (T6 PR 3). |
| `packages/gateway/src/embedding/create-routing-runtime.ts` | `tryCreateRoutingEmbeddingRuntime` — hybrid-mode factory; falls back to MiniLM-only when `openai.api_key` missing (T6 PR 3). |
| `packages/gateway/src/search/dual-search.ts` | `vectorSearchChunksDual` — KNN over both `vec_items_*` tables, merge by distance (T6 PR 3). |
| `packages/gateway/src/ipc/index-reembed-rpc.ts` | `dispatchIndexReembedRpc` — `index.reembed` / `index.reembedCancel` long-running handler (T6 PR 3). CLI-only — NOT LAN-callable (I5), NOT in Tauri allowlist (I7). |
| `packages/gateway/src/automation/graph-predicate.ts` | Graph predicate types/parser/evaluator |
| `packages/gateway/src/automation/watcher-engine.ts` | Watcher evaluation loop; applies `graph_predicate_json` post-filter |
| `packages/gateway/src/db/verify.ts` | `nimbus db verify` — non-destructive integrity checks |
| `packages/gateway/src/db/repair.ts` | `nimbus db repair` — targeted recovery, audit-logged |
| `packages/gateway/src/db/snapshot.ts` | Manual + scheduled snapshots |
| `packages/gateway/src/db/metrics.ts` | `IndexMetrics` — counts, embedding coverage, latency percentiles |
| `packages/gateway/src/db/latency-ring-buffer.ts` | In-memory ring buffer; async batch flush to `query_latency_log` |
| `packages/gateway/src/db/write.ts` | Central DB write wrapper — catches `SQLITE_FULL`, re-throws `DiskFullError` |

## LLM + Voice

| File | Purpose |
|---|---|
| `packages/gateway/src/llm/types.ts` | `LlmProvider`, `LlmTaskType`, `LlmModelInfo`, `LlmGenerateOptions/Result` |
| `packages/gateway/src/llm/gpu-arbiter.ts` | `GpuArbiter` — single-slot GPU VRAM mutex with activity-aware timeout |
| `packages/gateway/src/llm/ollama-provider.ts` | `OllamaProvider` — Ollama HTTP wrapper |
| `packages/gateway/src/llm/llamacpp-provider.ts` | `LlamaCppProvider` — llama-server HTTP wrapper |
| `packages/gateway/src/llm/router.ts` | `LlmRouter` — task routing, air-gap enforcement |
| `packages/gateway/src/llm/registry.ts` | `LlmRegistry` — discovery, `llm_models` DB sync |
| `packages/gateway/src/voice/service.ts` | `VoiceService` — STT (`whisper-cli`), TTS, wake-word loop |
| `packages/gateway/src/voice/tts.ts` | `NativeTtsProvider` — `say` (mac), SAPI (Win), `espeak-ng`/`spd-say` (Linux) |

## Built-in Agents

| File | Purpose |
|---|---|
| `packages/gateway/src/agents/expert.ts` | `nimbus expert <topic-or-file>` — parallel sub-agents over PR/review/incident; emits `agents.expert.briefReady` |
| `packages/gateway/src/agents/impact.ts` | `nimbus impact <file-or-PR-url>` — 5-way reverse-dep blast radius; emits `agents.impact.briefReady` |
| `packages/gateway/src/agents/_lib/findings.ts` | `ExpertBrief` / `ExpertFinding` / `Evidence` types + ranking helpers |
| `packages/gateway/src/agents/_lib/gap-notes.ts` | Gap-note detectors (empty index, missing connector, missing entity, missing relation) |
| `packages/gateway/src/agents/_lib/render.ts` | Deterministic Markdown fallback renderer |
| `packages/gateway/src/agents/_lib/synthesize.ts` | LLM synthesis layer with deterministic fallback |

## Metrics + CI/CD

| File | Purpose |
|---|---|
| `packages/gateway/src/metrics/dora.ts` | Four pure DORA calculators: `deploymentFrequency`, `leadTimeForChanges`, `changeFailureRate`, `mttr`. Returns `DoraMetricsResult` envelope. |
| `packages/gateway/src/metrics/dora-config.ts` | `ServiceConfig` type (with `DoraServiceConfig` back-compat alias) + URN parser + provider→service-column map. |
| `packages/gateway/src/preflight/preflight.ts` | Pure pre-deploy check: three counts (active P1 incidents, failing CI on target_ref, open PR conflicts). Returns `DeployPreflightResult` envelope. |
| `packages/gateway/src/ipc/metrics-rpc.ts` | `dispatchMetricsRpc` — `metrics.dora` JSON-RPC handler. |
| `packages/gateway/src/ipc/preflight-rpc.ts` | `dispatchPreflightRpc` — `deploy.preflight` JSON-RPC handler. |
| `packages/cli/src/commands/metrics.ts` | `nimbus metrics dora --service <id> [--since 30d] [--json]`. |
| `packages/cli/src/commands/deploy.ts` | `nimbus deploy preflight --service <id> --target-ref <ref> [--mode warn\|block\|off] [--json]`. |
| `packages/github-actions/preflight-query/` | First-party GitHub Action that wraps `GET /v1/preflight/deploy`. |
| `packages/gateway/src/deployment/annotate.ts` | Pure post-deploy annotation calculator: validates payload, upserts `item` (`type='deployment'`) + the V28 `deployment_items` shadow row, writes one audit entry (Phase 5 T4 PR 3b). |
| `packages/gateway/src/deployment/external-id.ts` | Stable `external_id` derivation for annotated deploys (provider + sha + env). |
| `packages/gateway/src/deployment/types.ts` | `DeploymentAnnotateInput` / `DeploymentAnnotateResult` types shared by RPC + HTTP write route. |
| `packages/gateway/src/ipc/deployment-rpc.ts` | `dispatchDeploymentRpc` — internal `deployment.annotate` JSON-RPC handler (NOT in renderer allowlist). |
| `packages/gateway/src/ipc/http-write-routes.ts` | `WRITE_ROUTE_ALLOWLIST` + `dispatchWriteRoute` — invariant `I13` compile-time allowlist for HTTP write surface (Phase 5 T4 PR 3b). |
| `packages/gateway/src/ipc/http-auth.ts` | `requireBearer` + `tokenFingerprint` — bearer-token auth for HTTP write routes; reads `http_api.deployment_token` from vault. |
| `packages/gateway/src/ipc/http-rate-limit.ts` | `HttpWriteRateLimiter` — per-token sliding-window rate limit (60 req/min) for the HTTP write surface. |
| `packages/cli/src/commands/deploy-annotate.ts` | `nimbus deploy annotate --service <id> --sha <sha> --target-ref <ref> --env <env> --status <s> --started-at <ms>`. |
| `packages/github-actions/annotate-action/` | First-party GitHub Action that wraps `POST /v1/deployments`. |

## IPC

| File | Purpose |
|---|---|
| `packages/gateway/src/ipc/` | JSON-RPC 2.0 IPC server (one file per namespace under `handlers/`) |
| `packages/gateway/src/ipc/agents-rpc.ts` | `agents.expert` + `agents.impact` handlers; rejects array payloads |
| `packages/gateway/src/ipc/llm-rpc.ts` | `dispatchLlmRpc` — `llm.listModels` / `llm.getStatus` |
| `packages/gateway/src/ipc/voice-rpc.ts` | `dispatchVoiceRpc` — `voice.*` handlers |
| `packages/gateway/src/ipc/updater-rpc.ts` | `dispatchUpdaterRpc` — `updater.getStatus`/`checkNow`/`applyUpdate`/`rollback` |
| `packages/gateway/src/ipc/http-server.ts` | Read-only local HTTP API (`localhost` only, `SQLITE_OPEN_READONLY`) |
| `packages/gateway/src/ipc/http-routes.ts` | `READ_ONLY_HTTP_ROUTES` — canonical route list; single source of truth for the OpenAPI drift CI gate (Phase 5 T4 PR 1) |
| `packages/gateway/src/ipc/openapi-loader.ts` | `loadOpenApiJsonBytes` — cached YAML→JSON parse for `GET /v1/openapi.json` (Phase 5 T4 PR 1) |
| `packages/gateway/openapi/v1.yaml` | Hand-authored OpenAPI 3.1 schema for the read-only HTTP API; serves `/v1/metrics/dora` (T4 PR 2), `/v1/preflight/deploy` (T4 PR 3a), and `POST /v1/deployments` (T4 PR 3b). |
| `packages/gateway/src/ipc/metrics-server.ts` | Prometheus endpoint (`localhost`, off by default) |
| `packages/gateway/src/ipc/lan-crypto.ts` | NaCl box keypair, `sealBoxFrame` / `openBoxFrame` |
| `packages/gateway/src/ipc/lan-pairing.ts` | `PairingWindow` — single-use base58 pairing code, 5-min expiry |
| `packages/gateway/src/ipc/lan-rate-limit.ts` | `LanRateLimiter` — per-IP sliding-window failure tracking |
| `packages/gateway/src/ipc/lan-rpc.ts` | `LanError`, `checkLanMethodAllowed` — invariant `I5` |
| `packages/gateway/src/ipc/lan-server.ts` | `LanServer` — `Bun.listen` TCP server; length-framed NaCl-box RPC |

## Updater

| File | Purpose |
|---|---|
| `packages/gateway/src/updater/updater.ts` | `Updater` state machine — manifest, semver compare, download, Ed25519 verify, install |
| `packages/gateway/src/updater/manifest-fetcher.ts` | `fetchUpdateManifest` — typed fetch with `AbortController` timeout |
| `packages/gateway/src/updater/signature-verifier.ts` | `verifyBinarySignature` — Ed25519 over SHA-256 |
| `packages/gateway/src/updater/public-key.ts` | Embedded Ed25519 public key; `NIMBUS_DEV_UPDATER_PUBLIC_KEY` override for tests |

## Telemetry + Config + Perf

| File | Purpose |
|---|---|
| `packages/gateway/src/telemetry/collector.ts` | Opt-in telemetry — aggregate counters only, no content |
| `packages/gateway/src/config/profiles.ts` | Named config profiles (`work`, `personal`); Vault key prefixing |
| `packages/gateway/src/perf/` | B2 bench harness — `BenchHarness`, `PerfFixture`, `HistoryLine`, `bench-cli.ts` |

## CLI

| File | Purpose |
|---|---|
| `packages/cli/src/index.ts` | CLI entry point |
| `packages/cli/src/ipc-client/` | IPC client + consent channel |
| `packages/cli/src/commands/query.ts` | `nimbus query` — structured query with `--sql` guard |
| `packages/cli/src/commands/config.ts` | `nimbus config get/set/list/validate/edit` |
| `packages/cli/src/commands/profile.ts` | `nimbus profile create/list/switch/delete` |
| `packages/cli/src/commands/diag.ts` | `nimbus diag` — diagnostic snapshot; `slow-queries` subcommand |
| `packages/cli/src/commands/doctor.ts` | `nimbus doctor` — environment health |
| `packages/cli/src/commands/telemetry.ts` | `nimbus telemetry show/disable` |
| `packages/cli/src/commands/expert.ts` | `nimbus expert` — calls `agents.expert`, streams Markdown |
| `packages/cli/src/commands/impact.ts` | `nimbus impact` — calls `agents.impact`; `--json` / `--service` filter |
| `packages/cli/src/commands/bench.ts` | `nimbus bench` — `Bun.spawn` wrapper around `bench-runner.ts` |
| `packages/cli/src/commands/index-cmd.ts` | `nimbus index reembed` — IPC-driven reembed CLI with progress streaming (T6 PR 3). |
| `packages/cli/src/commands/tui.tsx` | `nimbus tui` entry — gateway check, fallback detection, Ink |
| `packages/cli/src/tui/App.tsx` | TUI root — state machine + Option-1 layout |
| `packages/cli/src/tui/state.ts` | Top-level reducer: `idle` / `streaming` / `awaiting-hitl` / `disconnected` |

## SDK / Client / VS Code

| File | Purpose |
|---|---|
| `packages/sdk/src/index.ts` | `@nimbus-dev/sdk` public API |
| `packages/client/src/index.ts` | `@nimbus-dev/client` — `NimbusClient`, `MockClient` |
| `packages/vscode-extension/` | `nimbus-vscode` — Marketplace + Open VSX (current tag `vscode-v0.1.2`) |

## Tauri UI (frontend + Rust bridge)

| File | Purpose |
|---|---|
| `packages/ui/src-tauri/src/gateway_bridge.rs` | Rust IPC bridge — `ALLOWED_METHODS` (62), `NO_TIMEOUT_METHODS` (4), `GLOBAL_BROADCAST_METHODS` (`profile.switched`); invariant `I7` |
| `packages/ui/src-tauri/src/tray.rs` | System tray icon, menu, state forwarding |
| `packages/ui/src-tauri/src/quick_query.rs` | Quick Query window lifecycle |
| `packages/ui/src-tauri/src/hitl_popup.rs` | HITL popup window lifecycle |
| `packages/ui/src-tauri/src/lib.rs` | Tauri app entry — plugins, tray init, global shortcut, macOS accessory mode |
| `packages/ui/src-tauri/capabilities/default.json` | Tauri capability set — windows, permissions |
| `packages/ui/src-tauri/tauri.conf.json` | CSP + window config (invariant `I8`) |
| `packages/ui/src/ipc/client.ts` | `NimbusIpcClient`, `createIpcClient()`, `parseError()`; credential redaction (5 forbidden keys) |
| `packages/ui/src/ipc/types.ts` | Shared IPC types |
| `packages/ui/src/store/index.ts` | `useNimbusStore` — Zustand v5 + `persist`; 11 slices |
| `packages/ui/src/store/partialize.ts` | `persistPartialize` — 5-key whitelist + 5-key forbidden deep-scrub |
| `packages/ui/src/providers/GatewayConnectionProvider.tsx` | `onConnectionState` mirror + first-run routing |
| `packages/ui/src/App.tsx` | `createBrowserRouter` — all UI routes |
| `packages/ui/src/pages/` | Route-level pages: `QuickQuery`, `Onboarding`, `Dashboard`, `HitlPopup`, `Settings`, `settings/*` panels |
| `packages/ui/src/components/hitl/HitlPopupPage.tsx` | Head-of-queue consent dialog → `consent.respond` |
| `packages/ui/src/components/hitl/StructuredPreview.tsx` | XSS-safe recursive preview of `consent.request` details |
| `packages/ui/src/hooks/useIpcQuery.ts` | Typed polling hook (pauses on hidden / disconnected) |
| `packages/ui/src/hooks/useIpcSubscription.ts` | Typed Tauri event listener hook |
| `packages/ui/src/hooks/useConfirm.tsx` | Inline confirm dialog hook with typed-name confirmation |
| `packages/ui/src/store/slices/` | Per-domain Zustand slices (dashboard / hitl / settings / profile / telemetry / connectors / model / data) |

## Audit + Structure Audit

| File | Purpose |
|---|---|
| `scripts/structure-audit/lib.ts` | Shared B3 audit helpers — `REPO_ROOT`, `stripComments`, `countAnyInSource`, `iterateSourceFiles` |
| `scripts/structure-audit/check-doc-references.ts` | Doc-ref drift audit (broken `[text](path)` and backtick path refs) |
| `scripts/structure-audit/check-nimbus-invariants.ts` | Static-time complement to `security-invariants.test.ts` (invariants `I1`, vault-key allow-list) |
| `scripts/structure-audit/check-openapi-drift.ts` | OpenAPI drift detector — compares `v1.yaml` paths against `READ_ONLY_HTTP_ROUTES`; powers `audit:openapi-drift` CI gate (Phase 5 T4 PR 1) |
| `docs/structure-audit/baseline.md` | Phase 1 baseline reference; per-dimension state + Phase 2 thresholds |

## Security Scan (Phase 5)

| File | Purpose |
|---|---|
| `packages/gateway/src/security/secret-patterns.ts` | `SECRET_PATTERNS` (v1: 21 prefix-anchored patterns) + `redactSecret` (first-4/last-4) + `buildContextSnippet` (±40 chars, `[REDACTED]` middle). |
| `packages/gateway/src/security/scan.ts` | `scanItemsForSecrets` — pure scanner over `Iterable<ScanItem>`. No DB, no audit, no I/O. |
| `packages/gateway/src/ipc/security-rpc.ts` | `dispatchSecurityRpc` — `security.scan` handler. Builds depth map from `sync_state.depth`, skips `metadata_only` (reported), writes one `security.scan_completed` audit row. CLI-only — NOT in Tauri allowlist (I7); namespace `security` is in `FORBIDDEN_OVER_LAN` (I5). |
| `packages/cli/src/commands/security.ts` | `runSecurity` — `nimbus security scan [--json]`. Respects `NO_COLOR` + `isTTY`. |
| `packages/gateway/test/e2e/scenarios/security-scan.e2e.test.ts` | Phase 5 acceptance test — AWS public example key in a `summary`-depth filesystem item. |

## Top-level docs

| File | Purpose |
|---|---|
| `docs/architecture.md` | Full subsystem design — read before modifying any subsystem |
| `docs/roadmap.md` | Phases, acceptance criteria, delivered summary |
| `docs/SECURITY-INVARIANTS.md` | I1–I15 rationale + anti-patterns + audit cross-references (I15 = sandbox runner intrinsic to extension spawn, T2 PR 1) |
| `docs/release/manual-smoke-headless.md` | Reusable manual smoke checklist for headless releases; per-platform results matrix |
| `docs/cli/use-in-ci.md` | Worked CI integration examples (GitHub Actions self-hosted, GitLab CI, Jenkins) using `nimbus query --json` (Phase 5 T4 PR 1) |
| `docs/templates/nimbus-pre-commit.sh` | Bash pre-commit hook template — fail-open `nimbus diag --json` reachability check + incident/CI gates (Phase 5 T4 PR 1) |
| `docs/og-card.png` | OG social card PNG (1200×630, deterministic resvg-js render) |
| `docs/assets/og-card.svg` | OG card source SVG |
| `docs/assets/fonts/JetBrainsMono-Regular.ttf` | Deterministic OG render font — Regular weight (SIL OFL 1.1) |
| `docs/assets/fonts/JetBrainsMono-Bold.ttf` | Deterministic OG render font — Bold weight (SIL OFL 1.1) |
| `docs/assets/hero-cast-light.svg` | Rendered asciinema cast — light variant |
| `docs/assets/hero-cast-dark.svg` | Rendered asciinema cast — dark variant |
| `scripts/render-og-card.ts` | `bun run render:og-card` — resvg-js renderer for `docs/og-card.png` |
