# Nimbus Changelog

Reverse-chronological log of dated deliveries. This file is the **single source** for the running delivery log — `CLAUDE.md`, `GEMINI.md`, and `docs/architecture.md` carry only a one-line status pointer to here, and [`docs/roadmap.md`](./roadmap.md) carries the forward-looking acceptance criteria and per-phase Shipped summaries.

Phase-level history before `v0.1.0` (Phases 1–4) lives in [`docs/roadmap.md` § Shipped](./roadmap.md#shipped); this file tracks the Phase 5 (Extended Surface) delivery cadence and later releases.

---

## Phase 5 — The Extended Surface (🔵 Active)

Core sequencing: T1 → T3 → Wave A → T4 → T6 → T2 → Wave B. Status: T3 ✅ · Wave A ✅ · T4 ✅ · T6 ✅ · T2 ✅ · Wave B (partial) · Tier-2 (partial).

### 2026-05-25

- **Tier-1 connector — ArgoCD** ✅ — GitOps application sync/health (`argocd:application`); self-hosted Bearer auth, single GET /api/v1/applications walk; sandbox host extended from `argocd.url` (Grafana pattern). Applications-only (AppProjects + sync history deferred).
- **Tier-1 connector — Flux** ✅ — GitOps Toolkit CRs (kustomizations, helm releases, sources, image automations) read from the Kubernetes API (`flux:resource`); self-hosted SA-bearer auth, status.conditions Ready health. Writes (reconcile/suspend) deferred to Phase 6.
- **Tier-1 connector — dbt Cloud** ✅ — Administrative-API jobs + run status (`dbt:job`); `Authorization: Token` auth. Model-lineage (Discovery API) + `dbt.job.trigger` HITL deferred.
- **Tier-1 connector — Metabase** ✅ — dashboards (`metabase:dashboard`) via the Metabase API (`x-api-key`); self-hosted host via `metabase.url`. Saved-questions/cards deferred.
- **Tier-1 connector — Superset** ✅ — dashboards (`superset:dashboard`) via the Superset API (username/password → JWT); self-hosted host via `superset.url`. Charts/datasets/saved-queries deferred.
- **Tier-1 connector — Databricks** ✅ — jobs + latest run status (`data_pipeline`) via the Jobs API 2.1 (Bearer PAT); per-workspace host via `databricks.host`. Clusters/SQL-warehouses/notebooks + write tools deferred.
- **Tier-1 connector — MLflow** ✅ — registered models (`ml_model`) via the Model Registry API (`GET /api/2.0/mlflow/registered-models/search`, Bearer token); tracking-server host via `mlflow.host`. Registered-models-only (experiments/runs/metrics/params/artifacts deferred); `ml.model.promote` / `ml.model.transition-stage` (HITL) writes deferred to Phase 6.
- **Tier-1 connector — Vercel** ✅ — deployments (`vercel:deployment`) via the Vercel REST API (`GET /v6/deployments`, Bearer token, `pagination.next` walk capped at 20 pages); `vercel.token` required + optional `vercel.team_id` (scoped via `&teamId`); fixed SaaS host `api.vercel.com` (static sandbox network — no host override). Surfaces git commit metadata + inspector URL for correlating deploys with PR/Slack history. Deployments-only (projects/domains/env-vars/aliases/logs deferred).
- **Tier-1 connector — Netlify** ✅ — sites + embedded published-deploy status (`netlify:site`) via the Netlify REST API (`GET /api/v1/sites?per_page=100&page=N`, Bearer PAT, page-paginated walk capped at 20 pages); `netlify.token` required; fixed SaaS host `api.netlify.com` (static sandbox network — no host override). Surfaces deploy state / branch / commit ref / preview URL + linked repo for "is the latest deploy live?" and "which site shipped this commit?". ISO-8601 timestamps parsed to epoch-ms. Sites-only (per-deploy history / forms / functions / env-vars / DNS deferred).
- **Tier-1 connector — Stripe** ✅ — invoices (`stripe:invoice`) via the Stripe REST API (`GET /v1/invoices?limit=100`, Bearer secret key, `starting_after` + `has_more` cursor walk capped at 20 pages); `stripe.api_key` required; fixed SaaS host `api.stripe.com` (static sandbox network — no host override). Surfaces number / status / customer / amounts / subscription id + hosted-invoice URL for billing correlation. Stripe epoch-SECONDS timestamps converted to epoch-ms (×1000); amounts are integer minor units (cents). Invoices-only (payments / customers / disputes / subscription events deferred; `stripe.refund` HITL deferred to Phase 6).
- **Tier-1 connector — Mercury** ✅ — bank accounts (`mercury:account`) via the Mercury REST API (a single `GET /api/v1/accounts` reading the `{ accounts: [...] }` envelope — no pagination); `mercury.token` required; fixed SaaS host `api.mercury.com` (static sandbox network — no host override). Surfaces name / status / type / kind / routing number / available + current USD balances / legal business name for banking questions. The full account number is never stored — only the last 4 digits (`account_number_last4`); balances are USD major units (dollars, not cents); `createdAt` is ISO-8601 parsed to epoch-ms; `canonical_url` is null (no per-account public URL). Accounts-only (transactions / bills / statements deferred; wire / ACH HITL writes deferred to Phase 6).
- **Tier-1 connector — Readwise** ✅ — saved highlights (`readwise:highlight`) via the Readwise REST API (`GET /api/v2/highlights/?page_size=1000&page=N`, DRF `Authorization: Token <token>` auth — NOT Bearer, reading the `{ count, next, previous, results }` page envelope, incrementing `page` while `results` is non-empty and `next` is non-null, capped at 20 pages); `readwise.token` required; fixed SaaS host `readwise.io` (static sandbox network — no host override). Surfaces the highlighted excerpt text / the user's note / parent book id / location + location type / color / tags / source article URL for reading questions. The source article `url` is the `canonical_url` for web highlights (null for books); `highlighted_at` / `updated` are ISO-8601 parsed to epoch-ms; the highlight type stays on local MiniLM embeddings (not prose-heavy). Highlights-only (books / documents / daily-review deferred; the Reader v3 API deferred).
- **Tier-1 connector — Raindrop** ✅ — saved bookmarks (`raindrop:bookmark`) via the Raindrop.io REST API (`GET /rest/v1/raindrops/0?perpage=50&page=N` — collection id `0` is the special "all raindrops" collection — Bearer `Authorization: Bearer <token>` auth, reading the `{ result, items, count }` envelope, incrementing the 0-based `page` while `items` is non-empty AND a full page, capped at 20 pages); `raindrop.token` required; fixed SaaS host `api.raindrop.io` (static sandbox network — no host override). Surfaces the bookmark title / excerpt / note / domain / type / tags / collection id + the bookmarked link for bookmarking questions. The bookmarked `link` is the `canonical_url` (null when absent); `created` / `lastUpdate` are ISO-8601 parsed to epoch-ms; the `raindrop:bookmark` type stays on local MiniLM embeddings (not prose-heavy). Bookmarks-only (collections-as-items / highlights / per-collection filtering deferred).

### 2026-05-24

- **Tier-2 connector — Wiz** ✅ — CSPM findings (Phase 8 security surface, delivered early).
- **Tier-1 connector — LaunchDarkly** ✅ — feature flags / experiments (Phase 7 Wave 3, delivered early).
- **Tier-1 connector — Flagsmith** ✅ — feature-flag definitions (`flagsmith:feature_flag`); `Authorization: Token` auth, walks `/api/v1/projects/ → /api/v1/projects/{id}/features/` (DRF-paged) + per-project tag resolution. Definitions-only (per-environment state + segments deferred).

### 2026-05-22

- **Tier-2 connector — Semgrep** ✅ — AppSec Platform SAST findings (`semgrep:finding`).
- **Tier-2 connector — SonarQube / SonarCloud** ✅ — code-quality issues (`sonarqube:code_issue`).
- **Pre-commit hook docs** ✅ — `docs/cli/pre-commit.md` + `docs/templates/nimbus-pre-commit.sh`.
- **Published OpenAPI spec** ✅ — `GET /v1/openapi.json` + `audit:openapi-drift` CI gate.
- **Coverage floor Phase 5** ✅.

### 2026-05-21

- **T2 PR 4 — dependency resolution** ✅ — manifest `dependsOn` + backtracking DFS solver, V31 `extension_dependency` table + reverse-dep index, reverse-dep guard on `nimbus extension remove` (`--force` override), `MissingDependencyRegistry`, local-first `RegistryFetcher`, `extension.info --deps` + `extension.list --tree`. Composes on I9 / I14 / I16.
- **T2 / Wave-A connector — Snyk** ✅ — `snyk:vulnerability` items.
- **Wave-B connector — Bitrise** ✅ — `bitrise:app` + `bitrise:build` items.
- **`nimbus security scan`** ✅ — local credential-hygiene scan over indexed content; CLI-only, `FORBIDDEN_OVER_LAN`, not in Tauri allowlist.
- **Coverage floor Phase 4** ✅.
- **T4 wrap-up — `nimbus query` in CI worked examples** ✅ — `docs/cli/use-in-ci.md`.

### 2026-05-20

- **T2 PR 3 — extension auto-update** ✅ (PR #367) — in-process polling daemon (`ExtensionAutoUpdater`, default 24h), `extension.autoUpdate` / `extension.downgrade` HITL actions, `extension.checkForUpdates` / `extension.update` IPC, `nimbus extension update` / `downgrade` CLI. Composes on I2/I3/I4/I5/I7/I14/I16; bumped Tauri `ALLOWED_METHODS` 60 → 62.
- **Coverage floor Phase 3A + 3B-rest** ✅.

### 2026-05-18

- **T2 PR 2 — verified publisher (I16)** ✅ (PR #343) — Ed25519-signed manifest verification at install and startup, `SignatureDisabledRegistry`, `nimbus extension keygen` / `sign` / `sync` CLI, verified-publisher badges. Composes on I5/I7/I16.
- **Coverage floor Phase 2A** ✅.

### 2026-05-17

- **T2 PR 1 — sandbox (I15)** ✅ — sandbox PAL + 3-OS isolation + `permissions.{network,filesystem}` schema + I15 + static rule `D10` + `@nimbus-dev/sdk` contract tests + pre-T2 extension reinstall flow.
- **Coverage floor Phase 1A** ✅.

### 2026-05-16

- **T6 complete** ✅ — all four PRs landed:
  - PR 1 — I10 timing-safe helper consolidation (`util/timing-safe-compare.ts`).
  - PR 2 — `tool_call_log` V29 audit table (forensic complement to I11).
  - PR 3 — `vec_items_1536` V30 + hybrid embedding routing + `nimbus index reembed` CLI.
  - PR 4 — typed `dbRun` / `dbExec` I14 migration (163 sites) + static rule `D12`.
- **T4 wrap-up — PagerDuty pagination + `severity_p1_aliases`** ✅.

### 2026-05-15

- **T6 PR 2 — `tool_call_log` V29** ✅.
- **T6 PR 3 — `vec_items_1536` V30** ✅.
- **Sub-project A** ✅ (PR #297) — README hero redesign (light/dark asciinema casts), OG social card + deterministic resvg-js renderer + render-and-diff CI gate.
- **Docs site — 29 first-party connector pages** ✅ (PR #243).
- **Roadmap restructured into Shipped / Active / Planned** ✅ (PR #247).

### 2026-05-14

- **T6 sequencing spec** ✅.
- **T4 wrap-up — PagerDuty connector enrichment** ✅ — `pagerduty-sync.ts` writes `opened_at_ms` / `pagerduty_service_id` / `severity`; `initialSyncDepthDays` 14 → 30.

### 2026-05-10

- **Phase 4 complete on `main`; Phase 5 in flight.**
- **T3 (Team Intelligence) epic complete** — `AgentCoordinator.executeAll` parallel sub-agent dispatch + `nimbus expert` (PR 1, 2026-05-09), `nimbus impact` (PR 2, 2026-05-09), `nimbus catchup` (PR 3, 2026-05-10).

### 2026-05-09

- **`v0.1.0` released** — headless Gateway + CLI + VS Code extension. The Tauri desktop UI is code-complete but its release vehicle (signed installers) is deferred to Phase 13 as the separate `desktop-v0.1.0` tag — see [`docs/roadmap.md` § Phase 13](./roadmap.md#desktop-release-vehicle).

---

## Earlier phases

Phases 1 (Foundation), 2 (The Bridge), 3 (Intelligence), 3.5 (Observability & Developer Experience), and 4 (Presence) are summarized with acceptance criteria in [`docs/roadmap.md` § Shipped](./roadmap.md#shipped).
