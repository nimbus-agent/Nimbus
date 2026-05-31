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
| `packages/gateway/src/platform/sandbox/win32.ts` | Windows runner — AppContainer + `internetClient` capability; FFI WIP |
| `packages/gateway/src/platform/sandbox/seccomp-filter.ts` | Default Linux seccomp BPF filter — raw bytecode; AUDIT_ARCH_X86_64 guard |
| `packages/gateway/src/platform/sandbox/orphan-reap.ts` | Windows AppContainer orphan-reap at Gateway startup |
| `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts` | `wrapServerSpec(spec, manifest, cwd)` — I15 wiring entrypoint |
| `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts` | `FIRST_PARTY_MANIFESTS` — per-connector sandbox manifests |
| `packages/gateway/src-native/sandbox-helper/main.c` | Privileged C helper — `cap_net_admin+ep` via setcap; setns/unshare-killer |
| `packages/sdk/src/testing/sandbox-contract.ts` | `runSandboxContractTests(manifestPath)` — SDK API for connector authors |
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
| `packages/gateway/src/auth/zoom-access-token.ts` | `getValidZoomAccessToken(vault)` — delegates to `OAUTH_PROVIDERS.zoom` |
| `packages/gateway/src/auth/hubspot-access-token.ts` | `getValidHubspotAccessToken(vault)` — delegates to `OAUTH_PROVIDERS.hubspot` |
| `packages/gateway/src/auth/miro-access-token.ts` | `getValidMiroAccessToken(vault)` — delegates to `OAUTH_PROVIDERS.miro` |
| `packages/gateway/src/auth/canva-access-token.ts` | `getValidCanvaAccessToken(vault)` — delegates to `OAUTH_PROVIDERS.canva` (PKCE + Basic-header, like Zoom) |
| `packages/gateway/src/auth/figma-access-token.ts` | `getValidFigmaAccessToken(vault)` — delegates to `OAUTH_PROVIDERS.figma` (body-secret, like Miro) |
| `packages/gateway/src/auth/salesforce-access-token.ts` | `getValidSalesforceAuth(vault)` — delegates to `OAUTH_PROVIDERS.salesforce` (PKCE + body-secret), returns `{ accessToken, instanceUrl }`; requires the per-tenant `instance_url` from the stored blob (no silent fallback) |

## Connectors + MCP Mesh

Per-connector triples are `connectors/<x>-sync.ts` (sync handler) + `connectors/<x>-<noun>-mapping.ts` (pure item mapper) + `mcp-connectors/<x>/src/server.ts` (read-only MCP tools `<x>_list/get/search`). For auth, pagination, deferred write tools — read the file.

| File | Purpose |
|---|---|
| `packages/gateway/src/connectors/` | MCP connector mesh (`lazy-mesh/` bundle spawns AWS/Azure/GCP/IaC/observability MCPs when vault keys exist) |
| `packages/gateway/src/connectors/health.ts` | Health state machine — `transitionHealth()`, `ConnectorHealthSnapshot` |
| `packages/gateway/src/connectors/connector-vault.ts` | Per-service OAuth helpers — `perServiceOAuthVaultKey()`, `readConnectorSecret()` |
| `packages/gateway/src/connectors/connector-secrets-manifest.ts` | `CONNECTOR_VAULT_SECRET_KEYS` — per-connector PAT/API-key manifest |
| `packages/gateway/src/connectors/remove-intent.ts` | Connector removal — cascade vault + index cleanup via `executeRemoveIntent()` |
| `packages/gateway/src/connectors/openapi-indexer-sync.ts` | OpenAPI/AsyncAPI spec indexer; `getLastSyncStats()` exposes skipped counters |
| `packages/gateway/src/connectors/obsidian-sync.ts` | Obsidian vault — emits `obsidian_note` + `backlinks` edges |
| `packages/mcp-connectors/obsidian/src/server.ts` | Obsidian MCP — reads + HITL-gated `obsidian_append_to_daily_note` |
| `packages/gateway/src/connectors/snyk-sync.ts` | Snyk vulns — emits `snyk:vulnerability` |
| `packages/gateway/src/connectors/snyk-issue-mapping.ts` | Pure Snyk issue → `IndexedItem` |
| `packages/mcp-connectors/snyk/src/server.ts` | Snyk MCP — read-only `snyk_list/get/search` |
| `packages/gateway/src/connectors/bitrise-sync.ts` | Bitrise mobile-CI — emits `bitrise:app` + `bitrise:build` |
| `packages/gateway/src/connectors/bitrise-build-mapping.ts` | Pure Bitrise app + build → `IndexedItem` |
| `packages/mcp-connectors/bitrise/src/server.ts` | Bitrise MCP — read-only `bitrise_list/get/search` |
| `packages/gateway/src/connectors/sonarqube-sync.ts` | SonarQube + SonarCloud — emits `sonarqube:code_issue` |
| `packages/gateway/src/connectors/sonarqube-issue-mapping.ts` | Pure SonarQube issue → `IndexedItem` |
| `packages/mcp-connectors/sonarqube/src/server.ts` | SonarQube MCP — read-only `sonarqube_list/get/search` |
| `packages/gateway/src/connectors/semgrep-sync.ts` | Semgrep SAST — emits `semgrep:finding` |
| `packages/gateway/src/connectors/semgrep-finding-mapping.ts` | Pure Semgrep finding → `IndexedItem` |
| `packages/mcp-connectors/semgrep/src/server.ts` | Semgrep MCP — read-only `semgrep_list/get/search` |
| `packages/gateway/src/connectors/wiz-sync.ts` | Wiz CSPM (GraphQL) — emits `wiz:issue` |
| `packages/gateway/src/connectors/wiz-issue-mapping.ts` | Pure Wiz issue → `IndexedItem` |
| `packages/mcp-connectors/wiz/src/server.ts` | Wiz MCP — read-only `wiz_list/get/search` |
| `packages/gateway/src/connectors/launchdarkly-sync.ts` | LaunchDarkly flags — emits `launchdarkly:feature_flag` |
| `packages/gateway/src/connectors/launchdarkly-flag-mapping.ts` | Pure LaunchDarkly flag → `IndexedItem` |
| `packages/mcp-connectors/launchdarkly/src/server.ts` | LaunchDarkly MCP — read-only `launchdarkly_list/get/search` |
| `packages/gateway/src/connectors/flagsmith-sync.ts` | Flagsmith flags — emits `flagsmith:feature_flag` |
| `packages/gateway/src/connectors/flagsmith-feature-mapping.ts` | Pure Flagsmith feature → `IndexedItem` |
| `packages/mcp-connectors/flagsmith/src/server.ts` | Flagsmith MCP — read-only `flagsmith_list/get/search` |
| `packages/gateway/src/connectors/argocd-sync.ts` | ArgoCD GitOps — emits `argocd:application` |
| `packages/gateway/src/connectors/argocd-application-mapping.ts` | Pure ArgoCD Application → `IndexedItem` |
| `packages/mcp-connectors/argocd/src/server.ts` | ArgoCD MCP — read-only `argocd_list/get/search` |
| `packages/gateway/src/connectors/flux-sync.ts` | Flux GitOps Toolkit (9 CRD kinds) — emits `flux:resource` |
| `packages/gateway/src/connectors/flux-resource-mapping.ts` | Pure Flux CR → `IndexedItem`; `kind` discriminator |
| `packages/mcp-connectors/flux/src/server.ts` | Flux MCP — read-only `flux_list/get/search` |
| `packages/gateway/src/connectors/dbt-sync.ts` | dbt Cloud — emits `dbt:job` |
| `packages/gateway/src/connectors/dbt-job-mapping.ts` | Pure dbt Cloud job → `IndexedItem` |
| `packages/mcp-connectors/dbt/src/server.ts` | dbt Cloud MCP — read-only `dbt_list/get/search` |
| `packages/gateway/src/connectors/metabase-sync.ts` | Metabase BI — emits `metabase:dashboard` |
| `packages/gateway/src/connectors/metabase-dashboard-mapping.ts` | Pure Metabase dashboard → `IndexedItem` |
| `packages/mcp-connectors/metabase/src/server.ts` | Metabase MCP — read-only `metabase_list/get/search` |
| `packages/gateway/src/connectors/superset-sync.ts` | Apache Superset BI — emits `superset:dashboard` |
| `packages/gateway/src/connectors/superset-dashboard-mapping.ts` | Pure Superset dashboard → `IndexedItem` |
| `packages/mcp-connectors/superset/src/server.ts` | Superset MCP — read-only `superset_list/get/search`; JWT cached per process |
| `packages/gateway/src/connectors/databricks-sync.ts` | Databricks orchestration — emits `databricks:data_pipeline` |
| `packages/gateway/src/connectors/databricks-job-mapping.ts` | Pure Databricks job → `IndexedItem` |
| `packages/mcp-connectors/databricks/src/server.ts` | Databricks MCP — read-only `databricks_list/get/search` |
| `packages/gateway/src/connectors/mlflow-sync.ts` | MLflow model registry — emits `mlflow:ml_model` |
| `packages/gateway/src/connectors/mlflow-model-mapping.ts` | Pure MLflow `RegisteredModel` → `IndexedItem` |
| `packages/mcp-connectors/mlflow/src/server.ts` | MLflow MCP — read-only `mlflow_list/get/search` |
| `packages/gateway/src/connectors/vercel-sync.ts` | Vercel deployments — emits `vercel:deployment` |
| `packages/gateway/src/connectors/vercel-deployment-mapping.ts` | Pure Vercel deployment → `IndexedItem` |
| `packages/mcp-connectors/vercel/src/server.ts` | Vercel MCP — read-only `vercel_list/get/search` |
| `packages/gateway/src/connectors/netlify-sync.ts` | Netlify sites — emits `netlify:site` |
| `packages/gateway/src/connectors/netlify-site-mapping.ts` | Pure Netlify site → `IndexedItem` |
| `packages/mcp-connectors/netlify/src/server.ts` | Netlify MCP — read-only `netlify_list/get/search` |
| `packages/gateway/src/connectors/stripe-sync.ts` | Stripe billing — emits `stripe:invoice` |
| `packages/gateway/src/connectors/stripe-invoice-mapping.ts` | Pure Stripe invoice → `IndexedItem` |
| `packages/mcp-connectors/stripe/src/server.ts` | Stripe MCP — read-only `stripe_list/get/search` |
| `packages/gateway/src/connectors/mercury-sync.ts` | Mercury banking — emits `mercury:account` |
| `packages/gateway/src/connectors/mercury-account-mapping.ts` | Pure Mercury account → `IndexedItem`; stores `last4` only |
| `packages/mcp-connectors/mercury/src/server.ts` | Mercury MCP — read-only `mercury_list/get/search` |
| `packages/gateway/src/connectors/readwise-sync.ts` | Readwise — emits `readwise:highlight` |
| `packages/gateway/src/connectors/readwise-highlight-mapping.ts` | Pure Readwise highlight → `IndexedItem` |
| `packages/mcp-connectors/readwise/src/server.ts` | Readwise MCP — read-only `readwise_list/get/search` |
| `packages/gateway/src/connectors/raindrop-sync.ts` | Raindrop.io bookmarks — emits `raindrop:bookmark` |
| `packages/gateway/src/connectors/raindrop-bookmark-mapping.ts` | Pure Raindrop bookmark → `IndexedItem` |
| `packages/mcp-connectors/raindrop/src/server.ts` | Raindrop MCP — read-only `raindrop_list/get/search` |
| `packages/gateway/src/connectors/intercom-sync.ts` | Intercom support — emits `intercom:conversation` |
| `packages/gateway/src/connectors/intercom-conversation-mapping.ts` | Pure Intercom conversation → `IndexedItem` |
| `packages/mcp-connectors/intercom/src/server.ts` | Intercom MCP — read-only `intercom_list/get/search` |
| `packages/gateway/src/connectors/zendesk-sync.ts` | Zendesk Support (per-tenant) — emits `zendesk:ticket` |
| `packages/gateway/src/connectors/zendesk-ticket-mapping.ts` | Pure Zendesk ticket → `IndexedItem` |
| `packages/mcp-connectors/zendesk/src/server.ts` | Zendesk MCP — read-only `zendesk_list/get/search` |
| `packages/gateway/src/connectors/lever-sync.ts` | Lever recruiting/ATS — emits `lever:posting` (no candidate PII) |
| `packages/gateway/src/connectors/lever-posting-mapping.ts` | Pure Lever posting → `IndexedItem` |
| `packages/mcp-connectors/lever/src/server.ts` | Lever MCP — read-only `lever_list/get/search` |
| `packages/gateway/src/connectors/greenhouse-sync.ts` | Greenhouse ATS (Harvest API) — emits `greenhouse:job` (no candidate PII) |
| `packages/gateway/src/connectors/greenhouse-job-mapping.ts` | Pure Greenhouse job → `IndexedItem` |
| `packages/mcp-connectors/greenhouse/src/server.ts` | Greenhouse MCP — read-only `greenhouse_list/get/search` |
| `packages/gateway/src/connectors/pipedrive-sync.ts` | Pipedrive CRM — emits `pipedrive:deal`; token in query string (never logged) |
| `packages/gateway/src/connectors/pipedrive-deal-mapping.ts` | Pure Pipedrive deal → `IndexedItem` |
| `packages/mcp-connectors/pipedrive/src/server.ts` | Pipedrive MCP — read-only `pipedrive_list/get/search` |
| `packages/gateway/src/connectors/stackoverflow-sync.ts` | Stack Overflow for Teams Q&A — emits `stackoverflow:question` |
| `packages/gateway/src/connectors/stackoverflow-question-mapping.ts` | Pure SO question → `IndexedItem` |
| `packages/mcp-connectors/stackoverflow/src/server.ts` | SO Teams MCP — read-only `stackoverflow_list/get/search` |
| `packages/gateway/src/connectors/zotero-sync.ts` | Zotero references (API-key + non-secret library spec) — emits `zotero:reference`; offset/`start` walk; cursor `{ pass }` |
| `packages/gateway/src/connectors/zotero-reference-mapping.ts` | Pure Zotero item → `IndexedItem`; skips attachment/note item types |
| `packages/mcp-connectors/zotero/src/server.ts` | Zotero MCP — read-only `zotero_list/get/search` |
| `packages/gateway/src/connectors/dependencytrack-sync.ts` | OWASP Dependency-Track SBOM/supply-chain (per-tenant host + API key) — emits `dependencytrack:project`; page-number walk; cursor `{ pass }` |
| `packages/gateway/src/connectors/dependencytrack-project-mapping.ts` | Pure Dependency-Track project → `IndexedItem`; surfaces embedded vuln metrics |
| `packages/mcp-connectors/dependencytrack/src/server.ts` | Dependency-Track MCP — read-only `dependencytrack_list/get/search` |
| `packages/gateway/src/connectors/airflow-sync.ts` | Apache Airflow DAGs (per-tenant host + HTTP Basic auth, header built inline) — emits `airflow:dag`; body-based `total_entries` + offset walk; cursor `{ pass }` |
| `packages/gateway/src/connectors/airflow-dag-mapping.ts` | Pure Airflow DAG → `IndexedItem`; surfaces paused/active/owners/schedule/tags; local `parseIsoMs` |
| `packages/mcp-connectors/airflow/src/server.ts` | Airflow MCP — read-only `airflow_list/get/search` |
| `packages/gateway/src/connectors/prefect-sync.ts` | Prefect deployments (per-tenant workspace API root + Bearer api_key) — emits `prefect:deployment`; `POST /deployments/filter` body offset walk; cursor `{ pass }` |
| `packages/gateway/src/connectors/prefect-deployment-mapping.ts` | Pure Prefect deployment → `IndexedItem`; surfaces paused/work pool/queue/schedule/status/tags; local `parseIsoMs`; url always null |
| `packages/mcp-connectors/prefect/src/server.ts` | Prefect MCP — read-only `prefect_list/get/search` (list is a POST filter) |
| `packages/gateway/src/connectors/dagster-sync.ts` | Dagster jobs (per-tenant host + `Dagster-Cloud-Api-Token`) — emits `dagster:job`; single GraphQL `POST /graphql` walking `repositoriesOrError → nodes[].pipelines[]`, single-pass flatten, `MAX_JOBS` cap; cursor `{ pass }`; Wiz-style graceful GraphQL-error handling (`errors` array / `PythonError`) |
| `packages/gateway/src/connectors/dagster-job-mapping.ts` | Pure Dagster job → `IndexedItem`; `external_id` = stable `<location>:<repository>:<jobName>` triple (NOT the opaque base64 id); best-effort `<base_url>/locations/<location>/jobs/<jobName>` url |
| `packages/mcp-connectors/dagster/src/server.ts` | Dagster MCP — read-only `dagster_list/get/search` (GraphQL repositories catalog, flattened to jobs) |
| `packages/gateway/src/connectors/ramp-sync.ts` | Ramp card spend (OAuth2 client-credentials token exchange) — emits `ramp:transaction`; `page.next` cursor walk; cursor `{ pass }`; 401 re-exchange once |
| `packages/gateway/src/connectors/ramp-transaction-mapping.ts` | Pure Ramp transaction → `IndexedItem`; safe fields only (no PAN); local `parseIsoMs` |
| `packages/mcp-connectors/ramp/src/server.ts` | Ramp MCP — read-only `ramp_list/get/search`; bearer token cached per process |
| `packages/gateway/src/connectors/zoom-sync.ts` | Zoom meetings + recordings (OAuth) — emits `zoom:meeting` + `zoom:transcript`; cursor `{ pass, lastRecordingsTo }` |
| `packages/gateway/src/connectors/zoom-meeting-mapping.ts` | Pure Zoom meeting → `IndexedItem` |
| `packages/gateway/src/connectors/zoom-transcript-mapping.ts` | Pure Zoom transcript → `IndexedItem` + `vttToPlainText` helper |
| `packages/mcp-connectors/zoom/src/server.ts` | Zoom MCP — read-only `zoom_list/get/search/recordings_list/transcript_get` |
| `packages/gateway/src/connectors/hubspot-sync.ts` | HubSpot CRM deals (3-legged OAuth via registry — first Tier-2 infra-prover) — emits `hubspot:deal`; `paging.next.after` cursor walk; cursor `{ pass }` |
| `packages/gateway/src/connectors/hubspot-deal-mapping.ts` | Pure HubSpot deal → `IndexedItem`; `parseHubspotMs` (ISO + epoch-ms); url/canonical_url null |
| `packages/mcp-connectors/hubspot/src/server.ts` | HubSpot MCP — read-only `hubspot_list/get/search` |
| `packages/gateway/src/connectors/miro-sync.ts` | Miro boards (3-legged OAuth via registry — 7th provider) — emits `miro:board`; top-level `cursor` query-param walk; cursor `{ pass }` |
| `packages/gateway/src/connectors/miro-board-mapping.ts` | Pure Miro board → `IndexedItem`; ISO `parseIsoMs`; url/canonical_url = viewLink (null when absent) |
| `packages/mcp-connectors/miro/src/server.ts` | Miro MCP — read-only `miro_list/get/search` |
| `packages/gateway/src/connectors/canva-sync.ts` | Canva designs (3-legged OAuth via registry — 8th provider, PKCE + Basic-header like Zoom) — emits `canva:design`; top-level `continuation` query-param walk; cursor `{ pass }` |
| `packages/gateway/src/connectors/canva-design-mapping.ts` | Pure Canva design → `IndexedItem`; epoch-seconds `parseCanvaTimestampMs` (ISO-tolerant); url/canonical_url = view_url (else edit_url, else null) |
| `packages/mcp-connectors/canva/src/server.ts` | Canva MCP — read-only `canva_list/get/search` |
| `packages/gateway/src/connectors/figma-sync.ts` | Figma files for a single configured team (3-legged OAuth via registry — 9th provider, body-secret like Miro) — emits `figma:file`; two-level fetch (team projects → per-project files) flattened, `MAX_PROJECTS`/`MAX_FILES` capped; reads `figma.oauth` + non-secret `figma.team_id` (second-key pattern); cursor `{ pass }` |
| `packages/gateway/src/connectors/figma-file-mapping.ts` | Pure Figma file → `IndexedItem`; `external_id` = file `key`; ISO `parseIsoMs`; url/canonical_url = `https://www.figma.com/file/<key>` (constructed from key) |
| `packages/mcp-connectors/figma/src/server.ts` | Figma MCP — read-only `figma_list/get/search` (two-level team-projects → files fetch) |
| `packages/gateway/src/connectors/salesforce-sync.ts` | Salesforce Opportunities (3-legged OAuth + PKCE via registry — 10th provider; per-tenant `instance_url`) — emits `salesforce:opportunity`; SOQL query API `GET <instance_url>/services/data/v60.0/query`, walks `nextRecordsUrl` cursor, `MAX_PAGES=20`; reads `salesforce.oauth` then `getValidSalesforceAuth` → `{ accessToken, instanceUrl }`; cursor `{ pass }` |
| `packages/gateway/src/connectors/salesforce-opportunity-mapping.ts` | Pure Salesforce Opportunity → `IndexedItem`; `external_id` = SF `Id`; ISO `parseIsoMs`; url/canonical_url null (pure mapper, no instance host) |
| `packages/mcp-connectors/salesforce/src/server.ts` | Salesforce MCP — read-only `salesforce_list/get/search`; reads `SALESFORCE_ACCESS_TOKEN` + `SALESFORCE_INSTANCE_URL` from env (per-tenant host) |
| `packages/gateway/src/connectors/google-meet-sync.ts` | Google Meet past conference records — **extends the existing `google` provider as a sub-service** (NOT a new `OAuthProvider`); emits `google_meet:meeting`; `GET https://meet.googleapis.com/v2/conferenceRecords?pageSize=50`, paginates via `nextPageToken`; reads `getValidGoogleAccessToken(vault, "google_meet")`; cursor `{ v:1, pageToken }` (google_photos shape); rides the shared google bundle spawn slot |
| `packages/gateway/src/connectors/google-meet-meeting-mapping.ts` | Pure Google Meet conference record → `IndexedItem`; `external_id` = id segment of `name` (strip `conferenceRecords/`); ISO `parseIsoMs`; title `Meeting <startTime date>` (no human title); url/canonical_url null |
| `packages/mcp-connectors/google-meet/src/server.ts` | Google Meet MCP — read-only `google_meet_list/get/search`; base `https://meet.googleapis.com/v2`; reads `GOOGLE_OAUTH_ACCESS_TOKEN` from env |
| `packages/gateway/src/connectors/bigquery-sync.ts` | BigQuery datasets/tables METADATA (Tier-3, no-row-data) — **reuses `gcp.*` creds** (no own vault key); mints token via `gcloud auth print-access-token` (injectable `mintAccessToken`), walks BigQuery REST `datasets`→`tables`(→detail for `schema.fields`); emits `bigquery:table`; cursor `{ pass }`; `ensureBigqueryMcpRunning` → phase3 bundle |
| `packages/gateway/src/connectors/bigquery-table-mapping.ts` | Pure BigQuery table → `IndexedItem`; `external_id` = `<project>:<datasetId>.<tableId>`; schema field names/types + row COUNTS + byte sizes only (NO row data); epoch-MILLIS timestamp parse; `extractSchemaFields` flattens RECORD fields |
| `packages/mcp-connectors/bigquery/src/server.ts` | BigQuery MCP — read-only `bigquery_list/get/search` (METADATA only); `src/tools.ts` exports `BIGQUERY_TOOL_NAMES` + `registerBigqueryTools`; mints token via gcloud, calls BigQuery REST metadata endpoints; **`test/no-row-data.test.ts` calls `assertNoRowDataTools`** (Tier-3 differentiator) |
| `packages/gateway/src/connectors/_lib/aws-cli.ts` | Shared AWS-CLI helper — `awsCredentialsExtra(ctx)` (reads `aws.*` creds → scoped env or null) + `awsCliJson(ctx, args)` (spawns `aws <args> --output json` with the cred env, I1); reused by aws-sync + athena-sync (SageMaker/CloudWatch next) |
| `packages/gateway/src/connectors/athena-sync.ts` | Athena catalogs/databases/tables METADATA (Tier-3, no-row-data) — **reuses `aws.*` creds** (no own vault key) via `_lib/aws-cli.ts`; walks `aws athena list-data-catalogs`→`list-databases`→`list-table-metadata` (injectable `runAwsCli`); emits `athena:table`; cursor `{ pass }`; `ensureAthenaMcpRunning` → phase3 bundle |
| `packages/gateway/src/connectors/athena-table-mapping.ts` | Pure Athena table → `IndexedItem`; `external_id` = `<catalog>/<database>.<tableName>`; column names/types + partition keys + parameters + timestamps only (NO row data); defensive ISO/epoch-seconds timestamp parse |
| `packages/mcp-connectors/athena/src/server.ts` | Athena MCP — read-only `athena_list/get/search` (METADATA only); `src/tools.ts` exports `ATHENA_TOOL_NAMES` + `registerAthenaTools`; shells `aws athena list-*`/`get-table-metadata` (reads AWS_* from env); **`test/no-row-data.test.ts` calls `assertNoRowDataTools`** (Tier-3 differentiator) |
| `packages/gateway/src/sync/connectivity.ts` | Network connectivity probe — guards sync scheduler against offline backoff |

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
| `packages/gateway/src/ipc/http-routes.ts` | `READ_ONLY_HTTP_ROUTES` — source of truth for OpenAPI drift gate |
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
| `packages/cli/src/commands/tui.tsx` | `nimbus tui` entry — gateway check, fallback detection, Ink |
| `packages/cli/src/tui/App.tsx` | TUI root — state machine + Option-1 layout |
| `packages/cli/src/tui/state.ts` | Reducer: `idle` / `streaming` / `awaiting-hitl` / `disconnected` |

## SDK / Client / VS Code

| File | Purpose |
|---|---|
| `packages/sdk/src/index.ts` | `@nimbus-dev/sdk` public API |
| `packages/client/src/index.ts` | `@nimbus-dev/client` — `NimbusClient`, `MockClient` |
| `packages/vscode-extension/` | `nimbus-vscode` — Marketplace + Open VSX |

## Tauri UI (frontend + Rust bridge)

| File | Purpose |
|---|---|
| `packages/ui/src-tauri/src/gateway_bridge.rs` | Rust IPC bridge — `ALLOWED_METHODS` (62), `NO_TIMEOUT_METHODS` (4), `GLOBAL_BROADCAST_METHODS`; invariant `I7` |
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
| `scripts/structure-audit/check-doc-references.ts` | Doc-ref drift audit (broken `[text](path)` and backtick path refs) |
| `scripts/structure-audit/check-nimbus-invariants.ts` | Static-time complement to `security-invariants.test.ts` (I1 + vault-key allowlist) |
| `scripts/structure-audit/check-openapi-drift.ts` | OpenAPI drift detector — `v1.yaml` vs `READ_ONLY_HTTP_ROUTES` |
| `docs/structure-audit/baseline.md` | Phase 1 baseline reference; per-dimension state + Phase 2 thresholds |

## Security Scan

| File | Purpose |
|---|---|
| `packages/gateway/src/security/secret-patterns.ts` | `SECRET_PATTERNS` (21 prefix-anchored) + `redactSecret` + `buildContextSnippet` |
| `packages/gateway/src/security/scan.ts` | `scanItemsForSecrets` — pure scanner over `Iterable<ScanItem>`; no I/O |
| `packages/gateway/src/ipc/security-rpc.ts` | `dispatchSecurityRpc` — `security.scan`; CLI-only (NOT Tauri, NOT LAN) |
| `packages/cli/src/commands/security.ts` | `nimbus security scan [--json]`; respects `NO_COLOR` + `isTTY` |
| `packages/gateway/test/e2e/scenarios/security-scan.e2e.test.ts` | Acceptance — AWS public example key in a `summary`-depth filesystem item |

## Top-level docs

| File | Purpose |
|---|---|
| `docs/architecture.md` | Full subsystem design — read before modifying any subsystem |
| `docs/roadmap.md` | Phases, acceptance criteria, delivered summary |
| `docs/SECURITY-INVARIANTS.md` | I1–I16 rationale + anti-patterns + audit cross-references |
| `docs/release/manual-smoke-headless.md` | Reusable manual smoke checklist; per-platform results matrix |
| `docs/cli/use-in-ci.md` | CI integration examples (GitHub Actions, GitLab, Jenkins) using `nimbus query --json` |
| `docs/templates/nimbus-pre-commit.sh` | Bash pre-commit template — `nimbus diag` reachability + incident/CI gates |
| `docs/cli/pre-commit.md` | Pre-commit hook docs — install, env-var knobs, exit codes |
| `docs/og-card.png` | OG social card PNG (1200×630, deterministic resvg-js render) |
| `docs/assets/og-card.svg` | OG card source SVG |
| `docs/assets/fonts/JetBrainsMono-Regular.ttf` | Deterministic OG render font — Regular (SIL OFL 1.1) |
| `docs/assets/fonts/JetBrainsMono-Bold.ttf` | Deterministic OG render font — Bold (SIL OFL 1.1) |
| `docs/assets/hero-cast-light.svg` | Rendered asciinema cast — light variant |
| `docs/assets/hero-cast-dark.svg` | Rendered asciinema cast — dark variant |
| `scripts/render-og-card.ts` | `bun run render:og-card` — resvg-js renderer for `docs/og-card.png` |
