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
| `packages/gateway/src/connectors/sonarqube-sync.ts` | SonarQube + SonarCloud code-quality connector (Phase 5 Tier 2, 2026-05-22); walks `GET /api/components/search?qualifiers=TRK → /api/issues/search` (paged 100/page, 20 pages/project cap); emits `sonarqube:code_issue` items via `mapSonarIssueToItem`. Default base `https://sonarcloud.io`; self-hosted via `sonarqube.url` vault key |
| `packages/gateway/src/connectors/sonarqube-issue-mapping.ts` | Pure SonarQube issue → `IndexedItem` mapper; surfaces `{ severity, type (BUG/VULNERABILITY/CODE_SMELL), status, rule, component, project_key, file_path, line, tags, effort, debt, author, message, creation_date, update_date, canonical_url, organization }` in metadata. Unit-tested independently of the HTTP path |
| `packages/mcp-connectors/sonarqube/src/server.ts` | SonarQube MCP server — read-only tools `sonarqube_list` / `sonarqube_get` / `sonarqube_search`. `hitlRequired: []` — `sonarqube.hotspot.review` + `sonarqube.issue.transition` are deferred Phase 8 follow-ups |
| `packages/gateway/src/connectors/semgrep-sync.ts` | Semgrep AppSec Platform SAST connector (Phase 5 Tier 2, 2026-05-22); walks `GET /api/v1/deployments → /api/v1/deployments/<slug>/findings` (paged 100/page, 20 pages/cycle cap); emits `semgrep:finding` items via `mapSemgrepFindingToItem`. Deployment slug auto-discovered when `semgrep.deployment_slug` is unset |
| `packages/gateway/src/connectors/semgrep-finding-mapping.ts` | Pure Semgrep finding → `IndexedItem` mapper; surfaces `{ severity, confidence, rule_name, rule_message, categories, file_path, line, end_line, column, repository, branch, triage_state, status, created_at, relevant_since, line_of_code_url }` in metadata. Unit-tested independently of the HTTP path |
| `packages/mcp-connectors/semgrep/src/server.ts` | Semgrep MCP server — read-only tools `semgrep_list` / `semgrep_get` / `semgrep_search`. `hitlRequired: []` — `semgrep.finding.triage` (ignore/suppress/accept-risk) is a deferred Phase 8 follow-up |
| `packages/gateway/src/connectors/wiz-sync.ts` | Wiz cloud-security (CSPM) connector (Phase 5 Tier 2, 2026-05-24); OAuth `client_credentials` auth at `auth.app.wiz.io`, then walks the `issues(first, after, filterBy)` GraphQL query at `api.app.wiz.io` (paged 100/page, 20 pages/cycle cap); emits `wiz:issue` items via `mapWizIssueToItem`. Regional override via `wiz.api_url` / `wiz.auth_url` vault keys |
| `packages/gateway/src/connectors/wiz-issue-mapping.ts` | Pure Wiz GraphQL issue → `IndexedItem` mapper; surfaces `{ severity, status, type, source_rule_id, source_rule_name, entity_id, entity_name, entity_type, project_ids, project_names, description, remediation, created_at, updated_at, resolved_at, canonical_url }` in metadata; `issueUrl` derives the user-facing `app.wiz.io` host. Unit-tested independently of the GraphQL path |
| `packages/mcp-connectors/wiz/src/server.ts` | Wiz MCP server — read-only tools `wiz_list` / `wiz_get` / `wiz_search`. `hitlRequired: []` — `wiz.issue.resolve` + `wiz.issue.assign` are deferred Phase 8 follow-ups |
| `packages/gateway/src/connectors/launchdarkly-sync.ts` | LaunchDarkly feature-flag connector (Phase 5 Tier 1, 2026-05-24); API-token auth (raw `Authorization` header), walks `GET /api/v2/projects → /api/v2/flags/{projectKey}` (offset-paged 100/page, 20 pages/project cap); emits `launchdarkly:feature_flag` items via `mapLaunchDarklyFlagToItem`. Regional override via `launchdarkly.base_url`; single-project via `launchdarkly.project_key` |
| `packages/gateway/src/connectors/launchdarkly-flag-mapping.ts` | Pure LaunchDarkly flag → `IndexedItem` mapper; surfaces `{ key, name, kind, project_key, tags, temporary, archived, maintainer, maintainer_id, description, variation_count, environments, env_states, created_at, updated_at, canonical_url }` in metadata; `flagUrl` builds the project flag page URL. Unit-tested independently of the REST path |
| `packages/mcp-connectors/launchdarkly/src/server.ts` | LaunchDarkly MCP server — read-only tools `launchdarkly_list` / `launchdarkly_get` / `launchdarkly_search`. `hitlRequired: []` — `launchdarkly.flag.toggle` is a deferred Phase 8 follow-up |
| `packages/gateway/src/connectors/flagsmith-sync.ts` | Flagsmith feature-flag connector (Phase 5 Tier 1, 2026-05-24); admin-API-token auth (`Authorization: Token <token>`), walks `GET /api/v1/projects/ → /api/v1/projects/{id}/features/` (DRF-paged 100/page, 20 pages/project cap) + one `/projects/{id}/tags/` call per project to resolve tag ids to labels; emits `flagsmith:feature_flag` items via `mapFlagsmithFeatureToItem`. Definitions-only (per-environment state + segments deferred). Regional / self-hosted host root via `flagsmith.api_base` |
| `packages/gateway/src/connectors/flagsmith-feature-mapping.ts` | Pure Flagsmith feature → `IndexedItem` mapper; surfaces `{ name, type, default_enabled, initial_value, description, tags, is_archived, owner_count, project_id, project_name, created_at, canonical_url }` in metadata; `appBaseFromApiBase` derives the `app.` dashboard host from the `api.` host and `featureUrl` builds the project page URL. Unit-tested independently of the REST path |
| `packages/mcp-connectors/flagsmith/src/server.ts` | Flagsmith MCP server — read-only tools `flagsmith_list` / `flagsmith_get` / `flagsmith_search`. `hitlRequired: []` — `flagsmith.flag.toggle` is a deferred Phase 8 follow-up |
| `packages/gateway/src/connectors/argocd-sync.ts` | ArgoCD GitOps connector (Phase 5 Tier 1, 2026-05-25); self-hosted Bearer-JWT auth (`Authorization: Bearer <token>`), single `GET /api/v1/applications` walk (no pagination — ArgoCD returns the full list); emits `argocd:application` items via `mapArgocdApplicationToItem`. Required vault keys `argocd.url` + `argocd.token` (no SaaS default); the sandbox network host is extended from `argocd.url` at spawn time (Grafana pattern). Applications-only — AppProjects + sync history deferred |
| `packages/gateway/src/connectors/argocd-application-mapping.ts` | Pure ArgoCD Application → `IndexedItem` mapper; descends nested `metadata`/`spec`/`status` defensively, surfaces `{ name, namespace, project, sync_status, health_status, repo_url, path, target_revision, dest_server, dest_namespace, revision, created_at, canonical_url }` in metadata; `applicationUrl` builds `<base>/applications/<name>` (UI + API share the host). Unit-tested independently of the REST path |
| `packages/mcp-connectors/argocd/src/server.ts` | ArgoCD MCP server — read-only tools `argocd_list` / `argocd_get` / `argocd_search`. `hitlRequired: []` — `argocd.app.sync` / `argocd.app.delete` writes are deferred to Phase 6 |
| `packages/gateway/src/connectors/flux-sync.ts` | Flux (GitOps Toolkit) connector (Phase 5 Tier 1, 2026-05-25); self-hosted SA-Bearer auth (`Authorization: Bearer <token>`), walks 9 CRD kinds via `GET /apis/<group>/<version>/<plural>` on the Kubernetes API (non-ok per kind is non-fatal — log + continue, tolerates version drift / uninstalled groups); emits a single `flux:resource` item type via `mapFluxResourceToItem`. Required vault keys `flux.api_url` (K8s API base) + `flux.token` (read-only ServiceAccount JWT); the sandbox network host is extended from `flux.api_url` at spawn time (Grafana pattern). TLS note: self-signed K8s certs are rejected by Bun fetch in v1 — needs a CA-trusted endpoint |
| `packages/gateway/src/connectors/flux-resource-mapping.ts` | Pure Flux CR → `IndexedItem` mapper; single `flux:resource` type with `kind` discriminator, `external_id = <kind>/<namespace>/<name>` (`_` for cluster-scoped); descends nested `metadata`/`spec`/`status` defensively, surfaces `{ kind, name, namespace, ready_status, ready_reason, ready_message, suspend, url, path, last_applied_revision, last_attempted_revision, created_at, canonical_url }` in metadata from the `status.conditions` Ready entry; no web UI — `canonicalUrl` is a non-clickable `<kind>/<ns>/<name>` locator and the row `url` is null. Unit-tested independently of the REST path |
| `packages/mcp-connectors/flux/src/server.ts` | Flux MCP server — read-only tools `flux_list` / `flux_get` / `flux_search` over the 9-kind CRD walk table (kind enum). `hitlRequired: []` — `flux reconcile` / `flux suspend` writes are deferred to Phase 6 |
| `packages/gateway/src/connectors/dbt-sync.ts` | dbt Cloud connector (Phase 5 Tier 1, 2026-05-25); SaaS-token auth (`Authorization: Token <token>`), walks `GET /api/v2/accounts/ → /api/v2/accounts/{id}/jobs/` (offset-paged 100/page, 20 pages/account cap); reads dbt's `.data` list envelope; the `/accounts/` http/parse error maps to the pass-cursor-empty result while a per-account jobs error is non-fatal (warn + continue); emits `dbt:job` items via `mapDbtJobToItem`. Single-account via `dbt.account_id` (skips `/accounts/`); regional / custom-access-URL host via `dbt.api_base` (default `https://cloud.getdbt.com`). Jobs + run status only — model lineage (Discovery GraphQL API) deferred |
| `packages/gateway/src/connectors/dbt-job-mapping.ts` | Pure dbt Cloud job → `IndexedItem` mapper; single `dbt:job` type, `external_id = <accountId>:<jobId>`; surfaces `{ job_id, name, account_id, project_id, environment_id, dbt_version, state (1→active/2→deleted), schedule_cron, triggers, created_at, updated_at, most_recent_run_status, most_recent_run_finished_at, canonical_url }` in metadata; `jobUrl` builds the dbt Cloud job-UI deep link with an account-page fallback when project_id is absent. Unit-tested independently of the REST path |
| `packages/mcp-connectors/dbt/src/server.ts` | dbt Cloud MCP server — read-only tools `dbt_list` / `dbt_get` / `dbt_search` over accounts → jobs (Administrative API v2). `hitlRequired: []` — `dbt.job.trigger` is a deferred Phase 6 follow-up; model lineage (Discovery GraphQL API) is a separate deferred follow-up |
| `packages/gateway/src/connectors/metabase-sync.ts` | Metabase BI connector (Phase 5 Tier 1, 2026-05-25); self-hosted API-key auth via the `x-api-key` header (NOT `Authorization`), one `GET /api/collection` call (non-fatal — resolves collection ids → names) + one `GET /api/dashboard` walk (no pagination — Metabase returns the full list; reads bare array, else `.data`); the `/api/dashboard` http/parse error maps to the pass-cursor-empty result; emits `metabase:dashboard` items via `mapMetabaseDashboardToItem`. Required vault keys `metabase.url` + `metabase.api_key` (no SaaS default); the sandbox network host is extended from `metabase.url` at spawn time (Grafana pattern). Dashboards-only — saved questions/cards + collections-as-items deferred |
| `packages/gateway/src/connectors/metabase-dashboard-mapping.ts` | Pure Metabase dashboard → `IndexedItem` mapper; single `metabase:dashboard` type, `external_id = String(id)`; resolves `collection_name` from `ctx.collectionNames[String(collection_id)]` (collection id may be a number or the string `"root"`); surfaces `{ dashboard_id, name, description, collection_id, collection_name, creator_id, archived, card_count, created_at, updated_at, canonical_url }` in metadata; `dashboardUrl` builds `<base>/dashboard/<id>` (UI + API share the host). Unit-tested independently of the REST path |
| `packages/mcp-connectors/metabase/src/server.ts` | Metabase MCP server — read-only tools `metabase_list` / `metabase_get` / `metabase_search` over `/api/dashboard`. `hitlRequired: []` — saved questions (cards) + write tools are a deferred follow-up |
| `packages/gateway/src/connectors/superset-sync.ts` | Apache Superset BI connector (Phase 5 Tier 1, 2026-05-25); self-hosted login-then-Bearer auth — `POST /api/v1/security/login` (`{ username, password, provider: "db", refresh: true }`) mints a JWT, then walks `GET /api/v1/dashboard/?q=(page:N,page_size:100)` (Rison-paged `result` envelope, `MAX_PAGES=20`) with `Authorization: Bearer`; a login failure or a first-page http/parse error maps to the pass-cursor-empty result (later-page non-ok just breaks); emits `superset:dashboard` items via `mapSupersetDashboardToItem`. Required vault keys `superset.url` + `superset.username` + `superset.password` (no SaaS default; the password is never logged); the sandbox network host is extended from `superset.url` at spawn time (Grafana pattern). Dashboards-only — charts/datasets/saved queries deferred |
| `packages/gateway/src/connectors/superset-dashboard-mapping.ts` | Pure Apache Superset dashboard → `IndexedItem` mapper; single `superset:dashboard` type, `external_id = String(id)`; title falls back to `Dashboard <id>` when `dashboard_title` is missing/empty (the row is never nulled for a missing title); surfaces `{ dashboard_id, title, slug, published, status, owner_count, changed_by, changed_at, canonical_url }` in metadata (`changed_by` flattens the nested `{ first_name, last_name }`; `changed_at` parses `changed_on_utc`); `dashboardUrl` builds `<base>/superset/dashboard/<id>/` (UI + API share the host). Unit-tested independently of the REST path |
| `packages/mcp-connectors/superset/src/server.ts` | Apache Superset MCP server — read-only tools `superset_list` / `superset_get` / `superset_search` over `/api/v1/dashboard/`; logs in once per process (username/password → JWT, cached) and calls with a Bearer token. `hitlRequired: []` — charts/datasets/saved queries + write tools are a deferred follow-up |
| `packages/gateway/src/connectors/databricks-sync.ts` | Databricks data-orchestration connector (Phase 5 Tier 1, 2026-05-25); per-workspace Bearer-PAT auth (`Authorization: Bearer <token>`), best-effort one-page `GET /api/2.1/jobs/runs/list` enrichment (non-fatal — builds a latest-run-per-job map) then a token-paginated `GET /api/2.1/jobs/list` walk (`page_token`, `MAX_PAGES=20`); a first-page http/parse error maps to the pass-cursor-empty result while later-page errors just break; emits `databricks:data_pipeline` items via `mapDatabricksJobToItem`. Required vault keys `databricks.host` + `databricks.token` (no SaaS default); the per-workspace host is extended into the sandbox network list from `databricks.host` at spawn time (Grafana pattern). Jobs + latest run status only — clusters / SQL warehouses / notebooks deferred |
| `packages/gateway/src/connectors/databricks-job-mapping.ts` | Pure Databricks Jobs API 2.1 job → `IndexedItem` mapper; single `databricks:data_pipeline` type, `external_id = job_<jobId>`; descends nested `settings.name` + `settings.schedule.quartz_cron_expression` defensively, surfaces `{ job_id, name, creator_user_name, schedule_cron, format, created_at, latest_run_id, latest_run_status, latest_run_started_at, latest_run_duration_ms, latest_run_cluster_id, latest_run_triggered_by, canonical_url }` in metadata; Databricks timestamps are epoch milliseconds passed through verbatim (no `Date.parse`); latest-run enrichment via `ctx.runsByJobId`; title falls back to `Job <id>`; `jobUrl` builds `<host>/jobs/<jobId>`. Unit-tested independently of the REST path |
| `packages/mcp-connectors/databricks/src/server.ts` | Databricks MCP server — read-only tools `databricks_list` / `databricks_get` / `databricks_search` over the Jobs API 2.1 (`/api/2.1/jobs/list` + `/jobs/get`). Bearer-PAT auth via `DATABRICKS_HOST` + `DATABRICKS_TOKEN`. `hitlRequired: []` — clusters / SQL warehouses / notebooks reads + `job.trigger` / `job.cancel` / `cluster.restart` (HITL) writes are deferred Phase 6 follow-ups |
| `packages/gateway/src/connectors/mlflow-sync.ts` | MLflow model-registry connector (Phase 5 Tier 1, 2026-05-25); tracking-server Bearer-token auth (`Authorization: Bearer <token>`), single token-paginated `GET /api/2.0/mlflow/registered-models/search` walk (`next_page_token`, `MAX_PAGES=20`); a first-page http/parse error maps to the pass-cursor-empty result while later-page errors just break; emits `mlflow:ml_model` items via `mapMlflowModelToItem`. Required vault keys `mlflow.host` + `mlflow.token` (no SaaS default); the tracking-server host is extended into the sandbox network list from `mlflow.host` at spawn time (Grafana pattern). Registered models only — experiments / runs / metrics / params / artifacts deferred |
| `packages/gateway/src/connectors/mlflow-model-mapping.ts` | Pure MLflow `RegisteredModel` → `IndexedItem` mapper; single `mlflow:ml_model` type, `external_id = model_<name>`; selects the latest version (prefers the `Production`-stage entry, else the highest numeric `version`), surfaces `{ name, description, version_count, latest_version, latest_stage, latest_status, latest_run_id, created_at, updated_at, tags (key=value[]), canonical_url }` in metadata; MLflow timestamps are epoch milliseconds passed through verbatim (no `Date.parse`); `modelUrl` builds the `<host>/#/models/<name>` UI fragment route with the name URL-encoded. Unit-tested independently of the REST path |
| `packages/mcp-connectors/mlflow/src/server.ts` | MLflow MCP server — read-only tools `mlflow_list` / `mlflow_get` / `mlflow_search` over the Model Registry API (`/api/2.0/mlflow/registered-models/{search,get}`). Bearer auth via `MLFLOW_HOST` + `MLFLOW_TOKEN`. `hitlRequired: []` — experiments / runs / metrics / params / artifacts reads + `ml.model.promote` / `ml.model.transition-stage` (HITL) writes are deferred Phase 6 follow-ups |
| `packages/gateway/src/connectors/vercel-sync.ts` | Vercel deployment connector (Phase 5 Tier 1, 2026-05-25); Bearer-token auth (`Authorization: Bearer <token>`), walks `GET /v6/deployments?limit=100` paginating via `pagination.next` (an epoch-ms `until` value, `MAX_PAGES=20`); a first-page http/parse error maps to the pass-cursor-empty result while later-page errors just break; emits `vercel:deployment` items via `mapVercelDeploymentToItem`. Required vault key `vercel.token` + optional `vercel.team_id` (appended as `&teamId`); the API host is the fixed SaaS host `api.vercel.com` (static sandbox network — no host override). Deployments-only — projects / domains / env vars / aliases / logs deferred |
| `packages/gateway/src/connectors/vercel-deployment-mapping.ts` | Pure Vercel `/v6/deployments` element → `IndexedItem` mapper; single `vercel:deployment` type (the `type` column value `deployment` is shared with the CI/CD annotation pipeline but never collides — that pipeline keys rows under the CI-provider `service`), `external_id` = the verbatim `uid`; title `<name> — <state>` (state prefers `readyState` over `state`) with a `Deployment <uid>` fallback; bodyPreview = the commit message; `canonical_url`/`url` prefer `inspectorUrl`, else `https://<vercel.app host>`, else null; surfaces `{ uid, name, state, target, url, inspector_url, commit_sha, commit_message, commit_ref, pr_id, creator, created_at, canonical_url }` in metadata; `created` is epoch ms passed through verbatim (no `Date.parse`); nested `creator`/`meta` access is defensive via `asRecord`. Unit-tested independently of the REST path |
| `packages/mcp-connectors/vercel/src/server.ts` | Vercel MCP server — read-only tools `vercel_list` / `vercel_get` / `vercel_search` over the REST API (`/v6/deployments` + `/v13/deployments/{idOrUrl}`). Bearer auth via `VERCEL_TOKEN` + optional `VERCEL_TEAM_ID`. `hitlRequired: []` — redeploy / promote / cancel writes are deferred follow-ups; projects / domains / env vars / aliases / logs reads also deferred |
| `packages/gateway/src/connectors/netlify-sync.ts` | Netlify site connector (Phase 5 Tier 1, 2026-05-25); Bearer-PAT auth (`Authorization: Bearer <token>`), page-paginated `GET /api/v1/sites?per_page=100&page=N` walk over a bare JSON array (`MAX_PAGES=20`, stop on a short/empty page); a first-page http/parse error maps to the pass-cursor-empty result while later-page errors just break; emits `netlify:site` items via `mapNetlifySiteToItem`. Required vault key `netlify.token`; the API host is the fixed SaaS host `api.netlify.com` (static sandbox network — no host override). Sites + embedded published-deploy status only — per-deploy history / forms / functions / env vars / DNS deferred |
| `packages/gateway/src/connectors/netlify-site-mapping.ts` | Pure Netlify `/api/v1/sites` element → `IndexedItem` mapper; single `netlify:site` type, `external_id` = the verbatim site `id`; title = site `name` with a `Site <id>` fallback; bodyPreview = the `published_deploy.title`; `canonical_url`/`url` prefer `admin_url`, else `ssl_url`, else `url`, else null; surfaces `{ site_id, name, url, admin_url, ssl_url, repo_url, repo_branch, deploy_state, deploy_id, deploy_branch, commit_ref, commit_url, deploy_url, account_name, created_at, updated_at, canonical_url }` in metadata; Netlify timestamps are ISO-8601 strings parsed to epoch-ms via `parseIsoMs` (NOT passed through verbatim); nested `build_settings`/`published_deploy` access is defensive via `asRecord`. Unit-tested independently of the REST path |
| `packages/mcp-connectors/netlify/src/server.ts` | Netlify MCP server — read-only tools `netlify_list` / `netlify_get` / `netlify_search` over the REST API (`/api/v1/sites` + `/api/v1/sites/{siteId}`). Bearer-PAT auth via `NETLIFY_TOKEN`. `hitlRequired: []` — per-deploy history / forms / functions / env vars / DNS reads + deploy/site write tools are deferred follow-ups |
| `packages/gateway/src/connectors/stripe-sync.ts` | Stripe billing connector (Phase 5 Tier 1, 2026-05-25); Bearer secret-key auth (`Authorization: Bearer <sk_live_/sk_test_ key>`, never logged), cursor-paginated `GET /v1/invoices?limit=100` walk reading the `{ data, has_more }` list envelope, advancing `starting_after=<last invoice id>` until `has_more` is false (`MAX_PAGES=20`); a first-page http/parse error maps to the pass-cursor-empty result while later-page errors just break; emits `stripe:invoice` items via `mapStripeInvoiceToItem`. Required vault key `stripe.api_key`; the API host is the fixed SaaS host `api.stripe.com` (static sandbox network — no host override). Invoices-only — payments / customers / disputes / subscription events deferred |
| `packages/gateway/src/connectors/stripe-invoice-mapping.ts` | Pure Stripe `/v1/invoices` element → `IndexedItem` mapper; single `stripe:invoice` type, `external_id` = the verbatim invoice `id`; title `Invoice <number\|\|id> — <status>` (drops the `— <status>` suffix when status is absent); bodyPreview = `description`, else `<customer name\|\|email> — <amount>`; `canonical_url`/`url` prefer `hosted_invoice_url`, else `invoice_pdf`, else null; surfaces `{ invoice_id, number, customer_id, customer_name, customer_email, status, amount_due, amount_paid, currency, subscription_id, hosted_invoice_url, invoice_pdf, created_at, due_date, period_start, period_end, canonical_url }` in metadata; Stripe timestamps are epoch SECONDS converted to epoch-ms via `secondsToMs` (×1000; `0`/missing → null, NOT `Date.parse`); amounts are integer minor units (cents). Unit-tested independently of the REST path |
| `packages/mcp-connectors/stripe/src/server.ts` | Stripe MCP server — read-only tools `stripe_list` / `stripe_get` / `stripe_search` over the REST API (`/v1/invoices` + `/v1/invoices/{id}`). Bearer secret-key auth via `STRIPE_API_KEY`. `hitlRequired: []` — payments / customers / disputes / subscription events reads + `stripe.refund` (HITL) write are deferred follow-ups |
| `packages/gateway/src/connectors/mercury-sync.ts` | Mercury business-banking connector (Phase 5 Tier 1, 2026-05-25); Bearer API-token auth (`Authorization: Bearer <token>`, never logged), a single `GET /api/v1/accounts` reading the `{ accounts: [...] }` object envelope (no pagination — Mercury returns the full account list in one call); an http error maps to the pass-cursor-empty result while a parse error resets the cursor; emits `mercury:account` items via `mapMercuryAccountToItem`. Required vault key `mercury.token`; the API host is the fixed SaaS host `api.mercury.com` (static sandbox network — no host override). Accounts-only — transactions / bills / statements deferred |
| `packages/gateway/src/connectors/mercury-account-mapping.ts` | Pure Mercury `/api/v1/accounts` element → `IndexedItem` mapper; single `mercury:account` type, `external_id` = the verbatim account `id`; title = account `name` with an `Account <id>` fallback; bodyPreview = `<kind\|\|type> — <currentBalance> USD` when a balance is present, else the kind/type label, else the title; `canonical_url`/`url` are always null (Mercury accounts have no per-account public URL); surfaces `{ account_id, name, status, type, kind, account_number_last4, routing_number, available_balance, current_balance, legal_business_name, created_at, canonical_url }` in metadata; the full account number is NEVER stored — only the last 4 digits via `last4`; balances are USD major units (dollars, not cents) passed through verbatim; `createdAt` is an ISO-8601 string parsed to epoch-ms via `parseIsoMs` (NOT verbatim, NOT epoch seconds). Unit-tested independently of the REST path |
| `packages/mcp-connectors/mercury/src/server.ts` | Mercury MCP server — read-only tools `mercury_list` / `mercury_get` / `mercury_search` over the REST API (`/api/v1/accounts` + `/api/v1/account/{id}`, note the singular `account` in the get-by-id path). Bearer API-token auth via `MERCURY_TOKEN`. `hitlRequired: []` — transactions / bills / statements reads + wire / ACH (HITL) transfer writes are deferred follow-ups |
| `packages/gateway/src/connectors/readwise-sync.ts` | Readwise reading-app connector (Phase 5 Tier 1, 2026-05-25); DRF token auth (`Authorization: Token <token>`, NOT Bearer; never logged), page-number-paginated `GET /api/v2/highlights/?page_size=1000&page=N` walk reading the DRF `{ count, next, previous, results }` envelope, incrementing `page` while `results` is non-empty AND `next` is non-null (`MAX_PAGES=20`); a first-page http/parse error maps to the pass-cursor-empty result while later-page errors just break; emits `readwise:highlight` items via `mapReadwiseHighlightToItem`. Required vault key `readwise.token`; the API host is the fixed SaaS host `readwise.io` (static sandbox network — no host override). Highlights-only — books / documents / daily-review + the Reader v3 API deferred |
| `packages/gateway/src/connectors/readwise-highlight-mapping.ts` | Pure Readwise `/api/v2/highlights/` element → `IndexedItem` mapper; single `readwise:highlight` type, `external_id` = `String(<numeric highlight id>)` (the row is skipped when `id` is missing/non-numeric); title = the first 80 chars of the trimmed highlight `text` (`…` when truncated) with a `Highlight <id>` fallback; bodyPreview = the user's `note`, else the highlight `text`; `canonical_url`/`url` = the source article `url` for web highlights (null for book highlights — no per-highlight public URL); surfaces `{ highlight_id, text, note, book_id, location, location_type, color, tags, source_url, highlighted_at, updated_at, canonical_url }` in metadata (`tags` reduced to the tag-NAME array via `tagNames`, tolerating non-object entries; the highlight `text` is stored in full); `highlighted_at` / `updated` are ISO-8601 strings parsed to epoch-ms via `parseIsoMs` (NOT verbatim, NOT epoch seconds), `modifiedAt` = updated ?? highlighted_at ?? syncedAt; stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES`). Unit-tested independently of the REST path |
| `packages/mcp-connectors/readwise/src/server.ts` | Readwise MCP server — read-only tools `readwise_list` / `readwise_get` / `readwise_search` over the REST API (`/api/v2/highlights/?page_size=1000` + `/api/v2/highlights/{id}/`). DRF token auth via `READWISE_TOKEN` (`Authorization: Token <token>`, NOT Bearer). `hitlRequired: []` — books / documents / daily-review reads + the Reader v3 API are deferred follow-ups |
| `packages/gateway/src/connectors/raindrop-sync.ts` | Raindrop.io bookmarking connector (Phase 5 Tier 1, 2026-05-25); Bearer token auth (`Authorization: Bearer <token>`, never logged), page-number-paginated `GET /rest/v1/raindrops/0?perpage=50&page=N` walk (collection id `0` = the special "all raindrops" collection) reading the `{ result, items, count }` envelope, incrementing the 0-based `page` while `items` is non-empty AND a full page of `perpage=50` (a short page signals the last page; `MAX_PAGES=20`); a first-page http error maps to the pass-cursor-empty result (http keeps the prior cursor, parse resets) while later-page errors just break; emits `raindrop:bookmark` items via `mapRaindropBookmarkToItem`. Required vault key `raindrop.token`; the API host is the fixed SaaS host `api.raindrop.io` (static sandbox network — no host override). Bookmarks-only — collections-as-items / highlights / per-collection filtering deferred |
| `packages/gateway/src/connectors/raindrop-bookmark-mapping.ts` | Pure Raindrop `/rest/v1/raindrops/0` element → `IndexedItem` mapper; single `raindrop:bookmark` type, `external_id` = `String(<numeric _id>)` (the row is skipped when `_id` is missing/non-numeric); title = the bookmark `title`, else the `link`, else `Bookmark <id>`; bodyPreview = `excerpt`, else `note`, else `domain`, else the title; `canonical_url`/`url` = the bookmarked `link` (null when missing/empty); surfaces `{ bookmark_id, title, link, excerpt, note, domain, type, tags, collection_id, created_at, updated_at, canonical_url }` in metadata (`tags` is the tag string array stored verbatim via `tagStrings`, tolerating non-string entries; the `cover` field is deliberately NOT stored); `created` / `lastUpdate` are ISO-8601 strings parsed to epoch-ms via `parseIsoMs` (NOT verbatim, NOT epoch seconds), `modifiedAt` = lastUpdate ?? created ?? syncedAt; stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES`). Unit-tested independently of the REST path |
| `packages/mcp-connectors/raindrop/src/server.ts` | Raindrop MCP server — read-only tools `raindrop_list` / `raindrop_get` / `raindrop_search` over the REST API (`/rest/v1/raindrops/0?perpage=50` + `/rest/v1/raindrop/{id}`, note the SINGULAR `raindrop` in the get-by-id path). Bearer token auth via `RAINDROP_TOKEN`. `hitlRequired: []` — collections-as-items / highlights / per-collection filtering reads + bookmark write tools are deferred follow-ups |
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
| `docs/templates/nimbus-pre-commit.sh` | Bash pre-commit hook template — fail-open `nimbus diag --json` reachability check + incident/CI gates (Phase 5 T4 PR 1). Install + extend recipes live in [`docs/cli/pre-commit.md`](../../docs/cli/pre-commit.md). |
| `docs/cli/pre-commit.md` | User-facing pre-commit hook docs — install, env-var knobs (`NIMBUS_HOOK_BLOCK_ON_*`), exit codes, extension patterns (Phase 5 T4 PR 1 wrap-up). |
| `docs/og-card.png` | OG social card PNG (1200×630, deterministic resvg-js render) |
| `docs/assets/og-card.svg` | OG card source SVG |
| `docs/assets/fonts/JetBrainsMono-Regular.ttf` | Deterministic OG render font — Regular weight (SIL OFL 1.1) |
| `docs/assets/fonts/JetBrainsMono-Bold.ttf` | Deterministic OG render font — Bold weight (SIL OFL 1.1) |
| `docs/assets/hero-cast-light.svg` | Rendered asciinema cast — light variant |
| `docs/assets/hero-cast-dark.svg` | Rendered asciinema cast — dark variant |
| `scripts/render-og-card.ts` | `bun run render:og-card` — resvg-js renderer for `docs/og-card.png` |
