---
name: nimbus-file-map
description: >
  Pointer index from "where does X live?" to file path, for the Nimbus monorepo.
  Use when the user asks where a subsystem, HITL gate, vault key, migration, Tauri
  allowlist, agent, connector, or RPC handler lives — or when about to grep for an
  entry-point. Faster than `Glob` for high-traffic files. Curated by hand and lags
  recent changes — treat entries as hints and verify with `Glob` / `Grep` before
  code changes.
---

# Nimbus Key File Locations

Curated pointer index. Source of truth is the working tree — verify a path with `Glob` before editing.

## Engine + Security

| File | Purpose |
|---|---|
| `packages/gateway/src/engine/executor.ts` | HITL gate — `HITL_REQUIRED` frozen set; most security-critical file |
| `packages/gateway/src/engine/coordinator.ts` | `AgentCoordinator` — multi-agent orchestration; `executeAll` runs sub-tasks in parallel |
| `packages/gateway/src/engine/sub-agent.ts` | `runSubAgent` — single sub-task executor; `sub_task_results` DB lifecycle |
| `packages/gateway/src/engine/tool-output-envelope.ts` | `wrapToolOutput` — invariant `I11` envelope at LLM-facing boundary |
| `packages/gateway/src/db/tool-call-log.ts` | `writeToolCallLog` + `readToolCallLog` + `MAX_ENVELOPE_BYTES` — forensic complement to `I11` (V29) |
| `packages/gateway/src/index/tool-call-log-v29-sql.ts` | V29 — `tool_call_log` table + 3 indexes |
| `packages/gateway/src/ipc/audit-rpc.ts` | `dispatchAuditRpc` — `audit.verify/exportAll/getSummary/toolCalls`; CLI-only (NOT LAN, NOT Tauri) |

## Platform Abstraction Layer

| File | Purpose |
|---|---|
| `packages/gateway/src/platform/index.ts` | PAL — `createPlatformServices()` dispatch |
| `packages/gateway/src/platform/win32.ts` | Windows platform impl |
| `packages/gateway/src/platform/darwin.ts` | macOS platform impl |
| `packages/gateway/src/platform/linux.ts` | Linux platform impl |

## Extension Sandbox (invariant `I15`)

| File | Purpose |
|---|---|
| `packages/gateway/src/platform/sandbox/sandbox-runner.ts` | `SandboxRunner` interface + `createSandboxRunner()` dispatcher (I15 entry) |
| `packages/gateway/src/platform/sandbox/sandbox-wrapper.ts` | Wrapper script — reads manifest from env, calls `runner.spawn`. **Single I15 boundary** |
| `packages/gateway/src/platform/sandbox/linux.ts` | Linux runner — bwrap + helper + iptables; `decideNetworkMode` / `buildBwrapArgv` exposed |
| `packages/gateway/src/platform/sandbox/darwin.ts` | macOS runner — sandbox-exec SBPL profile generator |
| `packages/gateway/src/platform/sandbox/win32.ts` | Windows runner — AppContainer + `internetClient` capability, enforced via the unprivileged native `nimbus-sandbox-helper.exe` (ACL grants + Job Object + `CreateProcessW`), not FFI; per-host network filtering deferred (would need WFP callout drivers) |
| `packages/gateway/src/platform/sandbox/seccomp-filter.ts` | Default Linux seccomp BPF filter — raw bytecode; AUDIT_ARCH_X86_64 guard |
| `packages/gateway/src/platform/sandbox/{orphan-reap,win32-reap}.ts` | Windows AppContainer orphan-reap, wired at `platform/assemble.ts` boot |
| `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts` | `wrapServerSpec(spec, manifest, cwd)` — I15 wiring entrypoint |
| `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts` | `FIRST_PARTY_MANIFESTS` — per-connector sandbox manifests |
| `packages/gateway/src-native/sandbox-helper/main.c` | Privileged C helper — `cap_net_admin+ep` via setcap; setns/unshare-killer |
| _(standalone repo)_ `nimbus-sdk/src/testing/sandbox-contract.ts` | `runSandboxContractTests(manifestPath)` — [nimbus-agent/nimbus-sdk](https://github.com/nimbus-agent/nimbus-sdk), published as `@nimbus-dev/sdk` — SDK API for connector authors |
| `docs/sandbox.md` | Operator-facing reference; `#platform-asymmetry` + `#windows-platform-status` |

## Extensions — Dependency Resolution

| File | Purpose |
|---|---|
| `packages/gateway/src/extensions/dependency-types.ts` | Solver contracts: `ResolvedDep`, `InstallPlan`, `RegistryFetcher`, `DependencyConflict` |
| `packages/gateway/src/extensions/dependency-errors.ts` | `DependencyConflictError` / `OfflineDependencyResolutionError` / `ReverseDepBlockedError` + `is*` |
| `packages/gateway/src/extensions/dependency-graph.ts` | `resolveClosure(root, fetcher, opts)` — backtracking DFS solver |
| `packages/gateway/src/extensions/dependency-store.ts` | `recordInstall` / `clearDeps` / `forwardDeps` / `reverseDeps` over V31 `extension_dependency` |
| `packages/gateway/src/extensions/registry-fetcher.ts` | `createRegistryFetcher` — local-first solver adapter |
| `packages/gateway/src/extensions/missing-dependency-registry.ts` | `missingDependencyRegistry` singleton + completeness-guard reasons |
| `packages/gateway/src/index/extension-dependency-v31-sql.ts` | V31 — `extension_dependency` table + reverse index |

## Vault + Auth

| File | Purpose |
|---|---|
| `packages/gateway/src/vault/index.ts` | `NimbusVault` interface |
| `packages/gateway/src/auth/google-access-token.ts` | Google per-service OAuth — `resolveGoogleOAuthVaultKey()`, `anyGoogleOAuthVaultPresent()` |
| `packages/gateway/src/auth/oauth-vault-tokens.ts` | Generic OAuth helpers — `getValidVaultOAuthAccessToken()`, `microsoftOAuthAccessFromConfig()` |
| `packages/gateway/src/auth/oauth-registry.ts` | OAuth provider registry — `OAUTH_PROVIDERS` (google/microsoft/slack/notion/zoom/hubspot/miro/canva/figma/salesforce) + `getValidVaultAccessToken` single-flight; `StoredOAuthTokens`/`PKCEResult` carry optional `instanceUrl` (Salesforce per-tenant host, additive) |
| `packages/gateway/src/auth/<svc>-access-token.ts` | Per-provider `getValid<Svc>AccessToken(vault)` delegating to `OAUTH_PROVIDERS.<svc>` (zoom/hubspot/miro/canva/figma). Salesforce's `getValidSalesforceAuth` returns `{ accessToken, instanceUrl }` — requires the per-tenant `instance_url` from the stored blob (no silent fallback) |

## Connectors + MCP Mesh

A **standard connector** is a triple — `connectors/<x>-sync.ts` (sync handler) + `connectors/<x>-<noun>-mapping.ts` (pure item mapper) + `connectors/<x>/src/server.ts` (read-only `<x>_list/get/search`). ~77 connectors follow this shape: **derive the path from the connector name.** The file is the source of truth for auth, pagination, cursor shape (`{ pass }`), and `MAX_*` caps — that per-connector detail is deliberately **not** mirrored here, because it drifts. Below: shared infra, then the connectors that **deviate** from the standard shape.

### Shared connector infra

| File | Purpose |
|---|---|
| `packages/gateway/src/connectors/` | Connector mesh root; `lazy-mesh/` bundle spawns cloud/observability MCPs when vault keys exist |
| `packages/gateway/src/connectors/health.ts` | Health state machine — `transitionHealth()`, `ConnectorHealthSnapshot` |
| `packages/gateway/src/connectors/connector-vault.ts` | Per-service OAuth helpers — `perServiceOAuthVaultKey()`, `readConnectorSecret()` |
| `packages/gateway/src/connectors/connector-secrets-manifest.ts` | `CONNECTOR_VAULT_SECRET_KEYS` — per-connector PAT/API-key manifest |
| `packages/gateway/src/connectors/remove-intent.ts` | Connector removal — cascade vault + index cleanup via `executeRemoveIntent()` |
| `packages/gateway/src/connectors/openapi-indexer-sync.ts` | OpenAPI/AsyncAPI spec indexer; `getLastSyncStats()` exposes skipped counters |
| `packages/gateway/src/connectors/_lib/` | Shared sync helpers — `fetch-outcome.ts` (`connectorFetch`: rate-limit + fetch + bytes + parse), `aws-cli.ts` (`awsCliJson` cred-scoped spawn, I1), `pagination.ts`, `http.ts`, `item-builder.ts`, `auth.ts`, `rate-limit-observer.ts` |
| `packages/gateway/src/sync/connectivity.ts` | Network connectivity probe — guards the sync scheduler against offline backoff |

### Deviating connectors (by class)

Everything else follows the standard triple. These break from it in a way worth knowing **before** you edit — open the named files for specifics.

| Class | Connectors | What's special |
|---|---|---|
| **3-legged OAuth via registry** | hubspot, miro, canva, figma, salesforce, zoom | Auth flows through `OAUTH_PROVIDERS` (`auth/oauth-registry.ts`), not a static PAT. Salesforce carries a per-tenant `instance_url`; zoom also emits `zoom:transcript` (`zoom-transcript-mapping.ts` + `vttToPlainText`). |
| **OAuth sub-service** | google-meet | Extends the existing `google` provider (NOT a new `OAuthProvider`); reads `getValidGoogleAccessToken(vault, "google_meet")`; rides the shared google bundle spawn slot. |
| **Tier-3 metadata-only, reuses cloud creds** | bigquery · cloud-logging · vertex-ai (reuse `gcp.*`) · athena · cloudwatch · sagemaker (reuse `aws.*` via `_lib/aws-cli.ts`) | No own vault key. **METADATA only** — schema/counts/config, never row/log/inference data. Each `connectors/<x>/test/no-row-data.test.ts` calls `assertNoRowDataTools`; server `src/tools.ts` exports `<X>_TOOL_NAMES` + a `cliArg` flag-smuggle guard where it shells out. |
| **Tier-3 metadata-only, own per-tenant key** | elasticsearch (`elasticsearch.url` + `.api_key`, REST via `connectorFetch`) · great-expectations (`great_expectations.results_dir`, filesystem-read, no network/creds) | Own key but still no-row-data (same `assertNoRowDataTools` gate). great-expectations' mapper is the strip site — copies aggregate scalars only, never the `unexpected_*` sample lists. |
| **Read connector with a HITL write tool** | obsidian | Emits `obsidian_note` + `backlinks` edges; the MCP server also exposes the HITL-gated `obsidian_append_to_daily_note`. |
| **Email (Tier-4), HITL send** | imap, fastmail, protonmail | `<svc>:email` — HEADERS + capped plain-text PREVIEW + attachment METADATA only, NEVER attachment bytes or full body; all → `PROSE_HEAVY_TYPES`. imap/protonmail use imapflow (IMAP) + nodemailer (SMTP) — protonmail via the ProtonMail Bridge loopback (`secure:false`, self-signed); the gateway sync reuses the shared `_lib/imap-client.ts` `fetchImapMessages` + `ImapMessageInput`. fastmail is native JMAP over HTTPS (`jmap-core.ts`, session + batched `Email/query`+`get` with `maxBodyValueBytes`). Each exposes a HITL-gated `<svc>_mail_send` gated by the existing `email.send` action type (no executor change). per-tenant host:port added to the sandbox at spawn. |
| **Local filesystem, no network (Tier-5)** | localdb, storybook, dataprofile, great-expectations | Pure path-traversal-guarded filesystem reads — no network, no DB connection, no code execution; the configured dir is added to `filesystem.read` at spawn (`phase3Add<X>Mcp`), the MCP server reads it from env. localdb (`localdb.scripts_dir`) indexes saved `.sql` files (`localdb:saved_query`); storybook (`storybook.dir`) reads the `index.json`/`stories.json` manifest (`storybook:story`); dataprofile (`dataprofile.dir`) schema-profiles `.parquet`/`.csv`/`.jsonl`/`.json` into `dataprofile:data_model` (no-row-data — parquet footer via `hyparquet`, csv header, json/jsonl keys; injectable parquet reader; `assertNoRowDataTools` contract); great-expectations reads validation-result JSON (see no-row-data row above). |

## Local Index + Migrations + DB

| File | Purpose |
|---|---|
| `packages/gateway/src/index/migrations/runner.ts` | Migration runner; `INDEXED_SCHEMA_STEPS`; pre-migration backup; rollback on throw |
| `packages/gateway/src/index/*-v<N>-sql.ts` | Migration SQL constants (e.g., `vec-items-1536-v30-sql.ts`, `audit-session-v24-sql.ts`) |
| `packages/gateway/src/index/vec-items-1536-v30-sql.ts` | V30 — `vec_items_1536` virtual table + dim-aware delete triggers |
| `packages/gateway/src/embedding/routing.ts` | `PROSE_HEAVY_TYPES` + `EMBEDDING_DIM_*` + `isProseHeavy` helper |
| `packages/gateway/src/embedding/routing-pipeline.ts` | `RoutingEmbeddingPipeline` — dispatches by `(service, type)` |
| `packages/gateway/src/embedding/create-routing-runtime.ts` | `tryCreateRoutingEmbeddingRuntime` — hybrid factory; MiniLM fallback |
| `packages/gateway/src/search/dual-search.ts` | `vectorSearchChunksDual` — KNN over both `vec_items_*` tables |
| `packages/gateway/src/ipc/index-reembed-rpc.ts` | `dispatchIndexReembedRpc` — `index.reembed` / `index.reembedCancel`; CLI-only |
| `packages/gateway/src/index/item-store.ts` | **`upsertIndexedItemForSync` — the single depth chokepoint every connector's item write goes through** (see `nimbus-index-body-depth` skill) |
| `packages/gateway/src/index/body-caps.ts` | `BODY_MAX_PROSE = 16_384` / 512 for everything else; surrogate-safe clamp |
| `packages/gateway/src/index/body-store-v48-sql.ts` | V48 — `item.body` + `item.body_complete`; `item_fts` repointed off `body_preview` |
| `packages/gateway/src/index/depth-default-v49-sql.ts` | V49 — backfills `sync_state.depth` `'summary'` → `'full'` (leaves `metadata_only`) |
| `packages/gateway/src/ipc/index-rebody-rpc.ts` | `index.rebody` / `index.rebodyCancel` — body backfill; CLI-only, FORBIDDEN_OVER_LAN |
| `packages/gateway/src/automation/graph-predicate.ts` | Graph predicate types/parser/evaluator |
| `packages/gateway/src/automation/watcher-engine.ts` | Watcher loop; applies `graph_predicate_json` post-filter |
| `packages/gateway/src/db/verify.ts` | `nimbus db verify` — non-destructive integrity checks |
| `packages/gateway/src/db/repair.ts` | `nimbus db repair` — targeted recovery, audit-logged |
| `packages/gateway/src/db/snapshot.ts` | Manual + scheduled snapshots |
| `packages/gateway/src/db/metrics.ts` | `IndexMetrics` — counts, embedding coverage, latency percentiles |
| `packages/gateway/src/db/latency-ring-buffer.ts` | In-memory ring buffer → `query_latency_log` |
| `packages/gateway/src/db/write.ts` | Central DB write wrapper — catches `SQLITE_FULL`, throws `DiskFullError` |

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
| `packages/gateway/src/agents/expert.ts` | `nimbus expert <topic-or-file>` — parallel sub-agents; emits `agents.expert.briefReady` |
| `packages/gateway/src/agents/impact.ts` | `nimbus impact <file-or-PR-url>` — 5-way reverse-dep blast radius |
| `packages/gateway/src/agents/_lib/findings.ts` | `ExpertBrief` / `ExpertFinding` / `Evidence` types + ranking |
| `packages/gateway/src/agents/_lib/gap-notes.ts` | Gap-note detectors (empty index, missing connector/entity/relation) |
| `packages/gateway/src/agents/_lib/render.ts` | Deterministic Markdown fallback renderer |
| `packages/gateway/src/agents/_lib/synthesize.ts` | LLM synthesis layer with deterministic fallback |
| `packages/gateway/src/agents/why.ts` + `why-peek.ts` | `nimbus why <ref>` — six-lane provenance briefs over the relationship graph |
| `packages/gateway/src/agents/glossary.ts` | `nimbus glossary [<term>]` — implicit-knowledge glossary; `glossary_term` + `glossary_pass_state` (V45/V46) |
| `packages/gateway/src/agents/decisions.ts` | `nimbus decisions` — implicit ADR extractor; `decision_record`/`_evidence`/`_pass_state` (V47) |
| `packages/gateway/src/agents/ownership.ts` | `nimbus owners [<path>]` — git-blame-derived ownership read surface; `person --owns--> file\|directory\|service` graph edges + `ownership_pass_state` (V51) |

## Metrics + CI/CD

| File | Purpose |
|---|---|
| `packages/gateway/src/metrics/dora.ts` | Four pure DORA calculators: `deploymentFrequency`, `leadTimeForChanges`, `changeFailureRate`, `mttr` |
| `packages/gateway/src/metrics/dora-config.ts` | `ServiceConfig` type + URN parser + provider→service-column map |
| `packages/gateway/src/preflight/preflight.ts` | Pure pre-deploy check — three counts (P1 incidents, failing CI, PR conflicts) |
| `packages/gateway/src/ipc/metrics-rpc.ts` | `dispatchMetricsRpc` — `metrics.dora` |
| `packages/gateway/src/ipc/preflight-rpc.ts` | `dispatchPreflightRpc` — `deploy.preflight` |
| `packages/cli/src/commands/metrics.ts` | `nimbus metrics dora --service <id>` |
| `packages/cli/src/commands/deploy.ts` | `nimbus deploy preflight --service <id> --target-ref <ref>` |
| `packages/github-actions/preflight-query/` | First-party Action — wraps `GET /v1/preflight/deploy` |
| `packages/gateway/src/deployment/annotate.ts` | Pure post-deploy annotation — upserts `item` + V28 `deployment_items` shadow + audit |
| `packages/gateway/src/deployment/external-id.ts` | Stable `external_id` derivation (provider + sha + env) |
| `packages/gateway/src/deployment/types.ts` | `DeploymentAnnotateInput` / `DeploymentAnnotateResult` |
| `packages/gateway/src/ipc/deployment-rpc.ts` | `dispatchDeploymentRpc` — internal `deployment.annotate` (NOT in renderer allowlist) |
| `packages/gateway/src/ipc/http-write-routes.ts` | `WRITE_ROUTE_ALLOWLIST` + `dispatchWriteRoute` — invariant `I13` |
| `packages/gateway/src/ipc/http-auth.ts` | `requireBearer` + `tokenFingerprint` — reads `http_api.deployment_token` |
| `packages/gateway/src/ipc/http-rate-limit.ts` | `HttpWriteRateLimiter` — per-token sliding window (60 req/min) |
| `packages/cli/src/commands/deploy-annotate.ts` | `nimbus deploy annotate --service --sha --target-ref --env --status` |
| `packages/github-actions/annotate-action/` | First-party Action — wraps `POST /v1/deployments` |

## IPC

| File | Purpose |
|---|---|
| `packages/gateway/src/ipc/` | JSON-RPC 2.0 server (one file per namespace under `handlers/`) |
| `packages/gateway/src/ipc/agents-rpc.ts` | `agents.expert` + `agents.impact`; rejects array payloads |
| `packages/gateway/src/ipc/llm-rpc.ts` | `dispatchLlmRpc` — `llm.listModels` / `llm.getStatus` |
| `packages/gateway/src/ipc/voice-rpc.ts` | `dispatchVoiceRpc` — `voice.*` |
| `packages/gateway/src/ipc/updater-rpc.ts` | `dispatchUpdaterRpc` — `updater.getStatus/checkNow/applyUpdate/rollback` |
| `packages/gateway/src/ipc/http-server.ts` | Read-only local HTTP API (`localhost`, `SQLITE_OPEN_READONLY`) |
| `packages/gateway/src/ipc/http-routes.ts` | `HTTP_ROUTES` — source of truth for OpenAPI drift gate |
| `packages/gateway/src/ipc/openapi-loader.ts` | `loadOpenApiJsonBytes` — cached YAML→JSON for `GET /v1/openapi.json` |
| `packages/gateway/openapi/v1.yaml` | OpenAPI 3.1 schema; serves `/v1/metrics/dora`, `/v1/preflight/deploy`, `POST /v1/deployments` |
| `packages/gateway/src/ipc/metrics-server.ts` | Prometheus endpoint (`localhost`, off by default) |
| `packages/gateway/src/ipc/lan-crypto.ts` | NaCl box keypair, `sealBoxFrame` / `openBoxFrame` |
| `packages/gateway/src/ipc/lan-pairing.ts` | `PairingWindow` — single-use base58 code, 5-min expiry |
| `packages/gateway/src/ipc/lan-rate-limit.ts` | `LanRateLimiter` — per-IP sliding window |
| `packages/gateway/src/ipc/lan-rpc.ts` | `LanError`, `checkLanMethodAllowed` — invariant `I5` |
| `packages/gateway/src/ipc/lan-server.ts` | `LanServer` — `Bun.listen` TCP; length-framed NaCl-box RPC |

## Updater

| File | Purpose |
|---|---|
| `packages/gateway/src/updater/updater.ts` | `Updater` state machine — manifest, semver, download, Ed25519 verify, install |
| `packages/gateway/src/updater/manifest-fetcher.ts` | `fetchUpdateManifest` — typed fetch with `AbortController` timeout |
| `packages/gateway/src/updater/signature-verifier.ts` | `verifyBinarySignature` — Ed25519 over SHA-256 |
| `packages/gateway/src/updater/public-key.ts` | Embedded Ed25519 pubkey; `NIMBUS_DEV_UPDATER_PUBLIC_KEY` override for tests |

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
| `packages/cli/src/commands/index-cmd.ts` | `nimbus index reembed` — IPC-driven with progress streaming |
| `packages/cli/src/commands/team.ts` | `nimbus team` — discover/pair/namespace/query/who-knows/consent/listen (federation) |
| `packages/cli/src/commands/identity.ts` | `nimbus identity` — OIDC login/status/logout/bind/unbind (`I18`) |
| `packages/cli/src/commands/scim.ts` | `nimbus scim` — status/set-token (SCIM v2 provisioning) |
| `packages/cli/src/commands/share.ts` | `nimbus share` — create/list/prune/pubkey/approve/reject (`I27`); `--as-recipe` |
| `packages/cli/src/commands/tui.tsx` | `nimbus tui` entry — gateway check, fallback detection, Ink |
| `packages/cli/src/tui/App.tsx` | TUI root — state machine + Option-1 layout |
| `packages/cli/src/tui/state.ts` | Reducer: `idle` / `streaming` / `awaiting-hitl` / `disconnected` |

## SDK / Client / Standalone client repos

| File | Purpose |
|---|---|
| `packages/gateway/src/clips/*` | Gateway web-clip surface — `PairingWindowController` (I30) + `clip-token-store.ts`; ingest via `POST /v1/clips` (the browser extension itself is the standalone repo below) |
| _(standalone repo)_ | `@nimbus-dev/sdk` — [nimbus-agent/nimbus-sdk](https://github.com/nimbus-agent/nimbus-sdk) (npm, MIT) — extension-authoring contract; the connectors consume the published package |
| _(standalone repo)_ | `@nimbus-dev/connectors` — [nimbus-agent/nimbus-mcp-servers](https://github.com/nimbus-agent/nimbus-mcp-servers) (npm, AGPL-3.0-only) — all 94 first-party MCP connectors as ONE package; the gateway bundles them into its binary via `BUNDLED_CONNECTORS`. Per-connector SYNC handlers stay here in `gateway/src/connectors/` |
| _(standalone repo)_ | `@nimbus-dev/client` — [nimbus-agent/nimbus-client](https://github.com/nimbus-agent/nimbus-client) (npm, MIT) — `NimbusClient`, `MockClient`; `packages/cli` and the VS Code extension consume the published package |
| _(standalone repo)_ | VS Code extension — [nimbus-agent/nimbus-vscode](https://github.com/nimbus-agent/nimbus-vscode) (Marketplace + Open VSX) |
| _(standalone repo)_ | Web clipper — [nimbus-agent/nimbus-web-clipper](https://github.com/nimbus-agent/nimbus-web-clipper) (Chrome + Firefox MV3) |

## Tauri UI (frontend + Rust bridge)

| File | Purpose |
|---|---|
| `packages/ui/src-tauri/src/gateway_bridge.rs` | Rust IPC bridge — `ALLOWED_METHODS`, `NO_TIMEOUT_METHODS`, `GLOBAL_BROADCAST_METHODS`; invariant `I7` |
| `packages/ui/src-tauri/src/tray.rs` | System tray icon, menu, state forwarding |
| `packages/ui/src-tauri/src/quick_query.rs` | Quick Query window lifecycle |
| `packages/ui/src-tauri/src/hitl_popup.rs` | HITL popup window lifecycle |
| `packages/ui/src-tauri/src/lib.rs` | Tauri app entry — plugins, tray init, global shortcut, macOS accessory mode |
| `packages/ui/src-tauri/capabilities/default.json` | Tauri capability set — windows, permissions |
| `packages/ui/src-tauri/tauri.conf.json` | CSP + window config (invariant `I8`) |
| `packages/ui/src/ipc/client.ts` | `NimbusIpcClient`, `createIpcClient()`, `parseError()`; credential redaction |
| `packages/ui/src/ipc/types.ts` | Shared IPC types |
| `packages/ui/src/store/index.ts` | `useNimbusStore` — Zustand v5 + `persist`; 11 slices |
| `packages/ui/src/store/partialize.ts` | `persistPartialize` — 5-key whitelist + 5-key forbidden deep-scrub |
| `packages/ui/src/providers/GatewayConnectionProvider.tsx` | `onConnectionState` mirror + first-run routing |
| `packages/ui/src/App.tsx` | `createBrowserRouter` — all UI routes |
| `packages/ui/src/pages/` | Route-level pages: `QuickQuery`, `Onboarding`, `Dashboard`, `HitlPopup`, `Settings/*` |
| `packages/ui/src/components/hitl/HitlPopupPage.tsx` | Head-of-queue consent dialog → `consent.respond` |
| `packages/ui/src/components/hitl/StructuredPreview.tsx` | XSS-safe recursive preview of `consent.request` details |
| `packages/ui/src/hooks/useIpcQuery.ts` | Typed polling hook (pauses on hidden / disconnected) |
| `packages/ui/src/hooks/useIpcSubscription.ts` | Typed Tauri event listener hook |
| `packages/ui/src/hooks/useConfirm.tsx` | Inline confirm dialog hook with typed-name confirmation |
| `packages/ui/src/store/slices/` | Per-domain Zustand slices (dashboard / hitl / settings / profile / telemetry / connectors / model / data) |

## Audit + Structure Audit

| File | Purpose |
|---|---|
| `scripts/structure-audit/lib.ts` | Shared B3 helpers — `REPO_ROOT`, `stripComments`, `countAnyInSource`, `iterateSourceFiles` |
| `scripts/structure-audit/check-doc-references.ts` | Doc-ref drift audit (broken `[text](path)` and backtick path refs) over CLAUDE/GEMINI + all of `docs/` + the skills; `DOCS_EXCLUDED_PREFIXES` names the few docs that are out and why |
| `scripts/structure-audit/check-nimbus-invariants.ts` | Static-time complement to `security-invariants.test.ts` (I1 + vault-key allowlist + static rules D10–D27 — derive the range from the file, it has read low twice) |
| `scripts/structure-audit/check-openapi-drift.ts` | OpenAPI drift detector — `v1.yaml` vs `HTTP_ROUTES` |
| `docs/structure-audit/baseline.md` | Phase 1 baseline reference; per-dimension state + Phase 2 thresholds |

## Security Scan

| File | Purpose |
|---|---|
| `packages/gateway/src/security/secret-patterns.ts` | `SECRET_PATTERNS` (21 prefix-anchored) + `redactSecret` + `buildContextSnippet` |
| `packages/gateway/src/security/scan.ts` | `scanItemsForSecrets` — pure scanner over `Iterable<ScanItem>`; no I/O |
| `packages/gateway/src/ipc/security-rpc.ts` | `dispatchSecurityRpc` — `security.scan`; CLI-only (NOT Tauri, NOT LAN) |
| `packages/cli/src/commands/security.ts` | `nimbus security scan [--json]`; respects `NO_COLOR` + `isTTY` |
| `packages/gateway/test/e2e/scenarios/security-scan.e2e.test.ts` | Acceptance — AWS public example key in a `summary`-depth filesystem item |

## Phase 6 — Team, Federation & Share

| File | Purpose |
|---|---|
| `packages/gateway/src/federation/query-gate.ts` | `answerFederatedQuery` — invariant `I17`/`D13` leak-proof federated read gate |
| `packages/gateway/src/federation/invoke-gate.ts` | `answerFederatedInvoke` — invariants `I19`/`I26` team-tool / warehouse-write peer gate |
| `packages/gateway/src/federation/preflight-gate.ts` | `I24`/`D18` federated action-request preflight (LOCAL owner HITL, sandboxed) |
| `packages/gateway/src/identity/verifier.ts` | `isOperatorValid` — invariant `I18`/`D14` sole IdP-token validation site |
| `packages/gateway/src/teamvault/team-tool-invoke.ts` | `I19`/`D15` ephemeral team-credentialed connector |
| `packages/gateway/src/policy/policy-gate.ts` | `EnforcedPolicy` resolution — invariant `I22`/`D16` (tighten-only, fail-closed) |
| `packages/gateway/src/chatops/reply-dispatcher.ts` | Operational ChatOps posts — invariant `I23`/`D17` server-derived `ReplyTarget` |
| `packages/gateway/src/engine/quorum/quorum-coordinator.ts` | Quorum HITL — invariant `I21` (DISTINCT authed peers, deny aborts) |
| `packages/gateway/src/tribal/tribal-write-gate.ts` | Tribal-knowledge KB capture — invariant `I25`/`D19` config-pinned destination |
| `packages/gateway/src/share/share-gate.ts` | `createShare` — invariant `I27`/`D21` sole outbound-share chokepoint (see `nimbus-share-virality` skill) |
| `packages/gateway/src/egress/egress-ledger.ts` | `appendEgressEntry` + `EgressSink` — invariant `I29`/`D22` egress-ledger append before `connectors.dispatch` (see `nimbus-egress` skill) |
| `packages/gateway/src/egress/{egress-record,egress-verify,egress-prune,egress-sign}.ts` | Entry builder (`serviceOf` destination) / BLAKE3-chain verify (timing-safe, I10) / HITL-gated prune tombstone / Vault-reused receipt sign |
| `packages/gateway/src/egress/{egress-coverage,egress-boot-marker,egress-source-type}.ts` | `THIS_BINARY_COVERAGE` (the machine-readable claim) / per-process boot marker hashed into `source_id` / the 10-member `source_type` union (frozen at 8 in #1038, reopened for `mcp` then `http`) |
| `packages/gateway/src/egress/agent-brief-egress.ts` | `recordAgentBriefEgress` — the agent-brief ledger append for BOTH external transports, MCP-originated and verified-local-HTTP (I29 / D22 rules (c)+(d)); its ONLY caller is `ipc/agents-rpc.ts` `dispatchAgentsRpc` |
| `packages/gateway/src/egress/egress-bearing-kinds.ts` | `EGRESS_BEARING_CLIENT_KINDS` — the TOTAL `ClientKind` → `source_type` map that decides whether a caller's brief is ledgered |
| `packages/gateway/src/agent-runs/agent-run-store.ts` | `AgentRunController` — in-memory HTTP agent runs; reservation-based admission, lazy expiry, 410-vs-404 tombstones |
| `packages/gateway/src/agent-runs/agent-http-invoke.ts` | `buildAgentHttpInvoker` — the HTTP entry point into `agents.*`; reaches them via `dispatchAgentsRpc`, never an emitter (D22 rule (d)) |
| `packages/gateway/src/ipc/egress-rpc.ts` | `egress.{head,list,verify,proveWindow,prune}` — 4 renderer-exposed reads + CLI-only HITL-gated prune |
| `packages/cli/src/commands/prove.ts` | `nimbus prove "<query>"` + `nimbus egress [verify\|prune]` CLI |
| `packages/gateway/src/index/egress-ledger-v44-sql.ts` | V44 `egress_ledger` migration SQL |
| `packages/gateway/src/exec/exec-gate.ts` | `runExecution` — invariant `I33`/`D23` sole sandboxed-code-execution path (config + policy refusal BEFORE consent, `canConfine(policy)`, read-once body, `network: []` by construction) |
| `packages/gateway/src/computer-use/cu-gate.ts` | `runAction` / `openSession` — invariant `I35`/`D26` computer-use chokepoint; branch count IS the ordered gate sequence, so refactor by PHASE, never suppress |
| `packages/gateway/src/computer-use/cu-lanes/*` | The `browser` (raw CDP, no dependency) and `terminal` (pipe-backed shell) lane drivers — `D26(b)`/`D26(c)`; the browser lane is confined by Chromium's own sandbox, NOT `SandboxRunner` |
| `packages/gateway/src/multimodal/media-gate.ts` | `understandArtifact` — invariant `I37`/`D27` local-vs-remote decision; locality DERIVED from `provider.isLocal` (`I34`), never a caller flag |
| `packages/gateway/src/multimodal/media-grant-store.ts` | `createGrant` / `hasActiveGrant` — the SOLE writer of the V59 `media_grant` table (`D27(b)`); REFUSES an `av`-modality row, which is one of the two mechanisms keeping audio/video local |
| `packages/gateway/src/multimodal/build-media-pass-deps.ts` | The one wiring site allowed to name `createRemoteVlm` (`D27(a)`) and `createOllamaVlm` (`D22(g)`), each inside a `wrapLedgeredVlm(...)` argument list |
| `packages/gateway/src/egress/vlm-egress.ts` | `wrapLedgeredVlm` — the `model`-class appender over `VlmProvider.describe` (`D22(g)`); `payload_summary` = model name + image byte COUNT, never the prompt or the bytes |
| `packages/gateway/src/index/{computer-use-v57-sql,media-pass-v58-sql,media-grant-v59-sql}.ts` | V57 `cu_session`/`cu_action`, V58 `media_pass_cursor`, V59 `media_grant` migration SQL |
| `packages/cli/src/commands/{exec,computer,media-cmd,media-grants-cmd}.ts` | `nimbus exec` / `nimbus computer` / `nimbus media understand` / `nimbus media allow-remote`+`grants` CLI |
| `packages/gateway/src/ipc/{exec-rpc,computer-rpc,media-rpc}.ts` | `exec.*` / `computer.*` / `media.*` — all three LAN-forbidden (`I5`) and absent from the Tauri allowlist (`I7`) |

## Top-level docs

| File | Purpose |
|---|---|
| `docs/architecture.md` | Full subsystem design — read before modifying any subsystem |
| `docs/roadmap.md` | Phases, acceptance criteria, delivered summary |
| `docs/SECURITY-INVARIANTS.md` | I1–I37 rationale (I28 reserved) + anti-patterns + audit cross-references |
| `docs/release/manual-smoke-headless.md` | Reusable manual smoke checklist; per-platform results matrix |
| `docs/cli/use-in-ci.md` | CI integration examples (GitHub Actions, GitLab, Jenkins) using `nimbus query --json` |
| `docs/templates/nimbus-pre-commit.sh` | Bash pre-commit template — `nimbus diag` reachability + incident/CI gates |
| `docs/cli/pre-commit.md` | Pre-commit hook docs — install, env-var knobs, exit codes |
