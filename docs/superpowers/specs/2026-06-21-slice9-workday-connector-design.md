# Phase 6 Slice 9 — Workday Connector (read-only) — Design

**Date:** 2026-06-21
**Slice:** Phase 6 Slice 9 (Deferred from Phase 5), sub-project **B** — Workday
**Status:** Design (approved in brainstorm; pending spec review)
**Branch:** `dev/asafgolombek/phase6-slice9-workday`
**Roadmap row:** `docs/roadmap.md` → Phase 6 → "Deferred from Phase 5" → Workday
**Related:** sub-project A (Mendeley, PR #631) established the read-only OAuth connector pattern this reuses.

---

## 1. Summary

A new **read-only** first-party MCP connector, `workday`, that indexes a tenant's HR data
into the local SQLite + embedding index: org chart / workers, time-off / absence, job
postings, and admin-configured RaaS reports (headcount). It follows the proven
Mendeley/Notion OAuth lazy-mesh spawn pattern — the engine never calls Workday directly
(non-negotiable #4 / I15). It is the **most PII-sensitive connector Nimbus ships**, so a
directory-safe **field allowlist** plus an **enforcing contract test** is the central
safety mechanism.

**No new security invariant. No schema migration** (item types are free per-connector
strings). **No HITL** (read-only). **No team-credential rail** (read-only → no write).

### Decisions locked in brainstorm
- **Access model:** Hybrid — REST + OAuth 2.0 for the well-known worker/time-off/job-posting
  endpoints, plus an **optional** list of RaaS (Report-as-a-Service) report URLs as an
  escape hatch. Both paths use the **same `workday.oauth` bearer token** (ISU basic-auth
  deferred).
- **Scope (v1):** workers, time-off, job postings (REST) + generic reports incl. headcount (RaaS).
- **PII boundary:** mappers emit only a directory-safe field allowlist; a contract test fails
  CI if a forbidden field is ever mapped.
- **Worker model:** standalone `workday:worker` items only — **no** coupling to
  `people/person-store.ts` (people-graph enrichment deferred to a later slice).
- **RaaS shape:** each report row → a generic `workday:report` item tagged with the report label.
- **Delivery:** single connector, all four domains in one PR (Approach A).

---

## 2. Architecture & package layout

```
packages/mcp-connectors/workday/src/
  server.ts          # stdio MCP entry; registers read tools behind an import.meta.main guard
  tools.ts           # workday_list / workday_get / workday_search (coverage-floor excluded)
  search-filter.ts   # local in-memory filter helper (mirrors mendeley/search-filter.ts)
  mappers.ts         # mapWorkerToItem / mapTimeOffToItem / mapJobPostingToItem / mapReportRowToItem
  field-allowlist.ts # directory-safe allowlist + RaaS PII denylist heuristic (single source of truth)
```

Gateway-side wiring reuses the existing connector subsystem:
- **Sync handler** (`packages/gateway/src/connectors/...`) — the `MappedRow`-returning sync
  function that fetches REST endpoints + configured RaaS reports and maps to items.
- **Lazy-mesh spawn** — `phase<…>AddWorkdayMcp` / `ensureWorkdayMcp` + `ensureWorkdayRunning`,
  routed through `wrapServerSpec()` → sandbox (I15). Tenant host is added to the sandbox
  network allowlist at spawn via `manifestWithExtraNetworkHosts` (the argocd/mlflow/Grafana
  self-hosted-host pattern).
- **Credential orchestration** — `CredentialSpawners` slot; `getValidWorkdayAccessToken`
  wraps the shared `getValidVaultAccessToken` (in-flight refresh dedup).

**Item types (4, all new, Workday-namespaced):**
`workday:worker`, `workday:time_off`, `workday:job_posting`, `workday:report`.

> `workday:job_posting` is deliberately distinct from the existing `greenhouse`/`lever`
> `job_posting`-class data to avoid collisions; the overlap is acknowledged and accepted
> (the same requisition may appear in both an ATS and Workday Recruiting).

---

## 3. Configuration & credentials

### Vault (secret)
- `workday.oauth` — the OAuth access/refresh token bundle (the **only** Workday vault key).
  Added to `CONNECTOR_VAULT_SECRET_KEYS.workday` + `connector-secrets-manifest.ts`.
- Confidential OAuth client credentials are **user-supplied env vars**, never in Vault and
  never proxied: `NIMBUS_OAUTH_WORKDAY_CLIENT_ID`, `NIMBUS_OAUTH_WORKDAY_CLIENT_SECRET`.
- Registered on the OAuth path: added to the `oauthProfileForService` switch (NOT
  `OAUTH_UNSUPPORTED_DETAILS`, which throws for OAuth services).

#### Tenant-specific OAuth endpoints (review point 1)

Unlike every existing OAuth connector, **Workday's authorize/token endpoints are
tenant-specific** — they embed the tenant host and tenant name:
`https://{tenant_host}/ccx/oauth2/{tenant}/authorize` and `.../ccx/oauth2/{tenant}/token`.
This is **different from Salesforce**, whose token endpoint is static (`login.salesforce.com`)
and which only discovers a per-tenant *API host* (`instance_url`) at OAuth time. Workday's
*token endpoint itself* varies, so the static-URL `OAUTH_PROVIDERS` descriptor model cannot
express it.

**Mechanism (verified feasible against `auth/oauth-registry.ts`):** the registry's core
functions — `buildAuthorizeUrl`, `exchangeAuthorizationCode`, `refreshViaRegistry`,
`getValidVaultAccessToken` — all accept the `OAuthProviderDescriptor` as a **parameter**
(they never look it up internally). So Workday adds a **descriptor factory**:

```ts
makeWorkdayDescriptor({ tenantHost, tenant }): OAuthProviderDescriptor
// authorizeUrl = `${tenantHost}/ccx/oauth2/${tenant}/authorize`
// tokenUrl     = `${tenantHost}/ccx/oauth2/${tenant}/token`
// vaultKey = "workday.oauth"; standard authorization-code parse; client secret in body
```

`getValidWorkdayAccessToken(vault, cfg)` builds the descriptor from `[connectors.workday]`
config and passes it to `getValidVaultAccessToken`. The authorize + code-exchange RPC paths
(`auth/pkce.ts`, `auth/oauth-vault-tokens.ts`) currently resolve the descriptor via
`OAUTH_PROVIDERS[provider]`; they gain a thin **descriptor-resolution indirection** that
returns the static map entry for every existing provider and `makeWorkdayDescriptor(cfg)` for
`workday`. Blast radius is limited to that one resolution point — no change to the core
exchange/refresh logic. Because `tenant_host` is configured directly, Workday needs **no**
`instance_url` discovery (the REST/RaaS API host is already known).

### Non-secret config (`nimbus.toml`)
```toml
[connectors.workday]
tenant_host          = "https://wd5-services1.workday.com"  # per-tenant API host (sandbox-allowlisted)
tenant               = "acme"                                # Workday tenant name (URL path segment)
time_off_history_days = 365                                  # optional; default 365 (review point 5)

# optional RaaS reports — each row becomes a workday:report item; same OAuth bearer:
[[connectors.workday.reports]]
label     = "headcount"
url       = "https://wd5-services1.workday.com/ccx/service/customreport2/acme/ISU/Headcount?format=json"
key_field = "employee_id"            # optional natural key for stable external_id (review point 2)
fields    = ["employee_id", "org", "headcount"]  # optional allowlist; only these emit (review point 4)
[[connectors.workday.reports]]
label = "open-positions"
url   = "https://wd5-services1.workday.com/ccx/service/customreport2/acme/ISU/OpenPositions?format=json"
```

- `tenant_host` is validated (https URL) and added to the sandbox network allowlist per-tenant.
- **RaaS URL same-host enforcement (review point 3):** each report `url`'s host MUST equal the
  `tenant_host` host. Validated at config-parse time AND re-checked before each fetch; a
  mismatch is **rejected** (config error / skipped at sync) — report hosts are **never**
  dynamically added to the sandbox allowlist, so a report URL can never open an egress hole to
  a third-party server.
- `time_off_history_days` (review point 5) bounds the absence backfill window; defaults to 365
  when omitted.
- Per-report `key_field` and `fields` are **optional** (review points 2 + 4): `key_field`
  designates the row's natural key for a stable `external_id`; `fields` is a per-report
  allowlist — when present, only those keys are emitted.
- `reports` is **optional**; when absent, the RaaS path is a no-op. Headcount is just one
  configured entry — there is no headcount-specific code path.
- RaaS URLs are fetched with the same `workday.oauth` bearer token. If a report returns 401
  (not OAuth-enabled), it is logged and skipped (the report-level failure does not abort the
  whole sync).

---

## 4. Item types, mappers & the directory-safe allowlist

`field-allowlist.ts` is the single source of truth for what may leave the mappers. Any field
not in the allowlist is dropped before reaching the index or embeddings.

### `workday:worker` (REST — Staffing/Workers)
- **Allowed:** `external_id` (worker id) · `name` (preferred/display) · `title` ·
  `manager` (name + id) · `team`/`supervisory_org` · `department` · `location` ·
  `work_email` · `work_phone` · `hire_date` · `employment_status` · `canonical_url`.
- **Forbidden (never mapped):** compensation/salary, SSN/national ID, home address,
  personal email/phone, date of birth, gender/ethnicity, performance ratings, photo.

### `workday:time_off` (REST — Absence)
- **Allowed:** `external_id` · `worker` (name + id) · `type` (category label only) ·
  `start_date` · `end_date` · `units` (days/hours) · `status` · `canonical_url`.
- **Forbidden:** free-text leave reason, medical/FMLA detail, comments.

### `workday:job_posting` (REST — Recruiting)
- **Allowed:** `external_id` (requisition id) · `title` · `team`/`dept` · `location` ·
  `status` · `posted_date` · `canonical_url`.
- **Note (review point 6):** the job *description / qualifications / responsibilities body is
  intentionally NOT in the allowlist* — job postings are indexed as short structured records,
  so 384-dim MiniLM routing (§4.5) is correct. If a future wave adds the description body,
  re-route `workday:job_posting` to 1536-dim per `nimbus-embedding-routing` at that time.

### `workday:report` (RaaS — generic)
- **`external_id` (review point 2 — stable, never the array index):** resolved as
  `<report_label>:<key>` where `key` is, in order: (1) the value of the configured per-report
  `key_field`; else (2) a **BLAKE3 content hash** of the row's sorted key/value pairs (reusing
  the existing `db/audit-chain.ts` BLAKE3 helper). The array index is **never** used — an
  insert/delete/reorder at the source must not shift every downstream id. (Trade-off: with no
  natural key, an edited row hashes to a new id → delete+recreate rather than in-place update;
  acceptable, since a keyless row is untrackable across edits by definition.)
- **Allowed fields:** `report_label` + the row's fields as generic metadata, subject to the
  two PII controls below.
- **PII controls (review point 4):**
  - *Optional per-report allowlist* — when `[[connectors.workday.reports]].fields` is set, only
    those keys are emitted (everything else dropped). This is the precise control.
  - *Denylist heuristic (defense-in-depth, always on)* — drops any row key whose name matches
    (case-insensitive substring/regex): `ssn`, `national_id`, `tax_id`, `passport`, `salary`,
    `comp`/`remuneration`, `dob`/`birth`, `home_address`/`address`, `medical`/`fmla`,
    `bank`/`account_number`/`routing`/`iban`, `gender`, `ethnicity`. The admin still owns the
    report design; this is a backstop, not the primary boundary.

### Embedding routing
Workers, time-off, job-postings, and reports are short structured records → MiniLM (384-dim).
None are added to `PROSE_HEAVY_TYPES` (no 1536-dim OpenAI routing). To be confirmed against
`nimbus-embedding-routing` during planning.

---

## 5. Sync flow, pagination & cursors

The sync handler runs each enabled domain sequentially and concatenates `MappedRow`s:

1. **Workers** — walk the Workers REST collection, page-cursored on the API's paging token
   (`offset`/`limit` or `next`), page-capped (`MAX_PAGES`).
2. **Time-off** — walk the Absence collection, same paging discipline; bounded to the
   `time_off_history_days` window (config, default 365) to avoid unbounded history.
3. **Job postings** — walk the Recruiting job-requisition collection.
4. **RaaS reports** — for each configured report, fetch the JSON array and map each row.

- **Cursor:** an opaque base64url JSON cursor (`encodeNimbusJsonCursor` ↔
  `decodeNimbusJsonCursorPayload` — a proper inverse pair; never a raw `JSON.parse`, which
  silently disables incremental sync) recording per-domain progress.
- **Page caps** on every walk to bound a runaway tenant.
- **Per-domain isolation:** a failure in one domain (e.g. Recruiting not licensed → 404, or a
  RaaS report 401) is logged and skipped; it does not abort the other domains.

### Error handling
- Token refresh handled by `getValidWorkdayAccessToken` (shared dedup wrapper).
- 401 after refresh → surfaced as an auth error for that domain.
- 403/404 for an unlicensed module → treated as "domain unavailable", logged, skipped
  (honors the roadmap's "read-only where API access allows").

---

## 6. Read tools (MCP surface)

Three read tools, `hitlRequired: []` (read-only), registered via an exported
`registerWorkdayTools(reg: ZodToolRegistrar)` with an `import.meta.main` guard running the
stdio server (the registrar-extraction pattern; keeps tools unit-testable via `captureTools()`):

- `workday_list` — list indexed Workday items, optionally filtered by item type/domain.
- `workday_get` — fetch one item by `external_id`.
- `workday_search` — local search over indexed Workday items (uses `search-filter.ts`).

All LLM-facing tool output flows through `wrapToolOutput` (I11) at the engine boundary (the
connector returns structured results; the envelope is applied gateway-side as for every
connector).

**No write tools** — read-only connector. A `no-write-tools` contract test asserts the tool
set never gains a write/mutate tool (mirrors the warehouse `assertNoRowDataTools` pattern).

---

## 7. Security & invariants

- **No new invariant.** Read-only → no HITL action types, no `HITL_REQUIRED_BACKING` entry,
  not enrolled in `TEAM_CREDENTIAL_CONNECTORS`/`TEAM_SECRET_ANYOF_GROUPS` (no team-write rail).
- **I15** — spawned only via `wrapServerSpec()` → sandbox; tenant host added to the network
  allowlist, nothing else reachable.
- **I3/I4/non-negotiable #4** — engine never calls Workday; all access via the MCP connector.
- **No plaintext credentials** (non-negotiable #3) — only `workday.oauth` in Vault; client
  id/secret are env vars; tenant host/name are non-secret config.
- **PII contract test** (the central safety net): asserts that
  `mapWorkerToItem`/`mapTimeOffToItem`, given a fixture containing every forbidden field,
  emit **none** of them — and that the worker mapper's emitted key set is a subset of the
  allowlist. Fails CI if a future change adds a forbidden field. The RaaS denylist heuristic
  has its own unit test.

---

## 8. Registration sites (type-coupled — must all be touched)

Mirrors the Mendeley sub-project A checklist:
1. `packages/mcp-connectors/workday/` — new connector package.
2. Root `package.json` `workspaces` — add `packages/mcp-connectors/workday` (individual,
   no glob) **before** `bun install`.
3. `CONNECTOR_VAULT_SECRET_KEYS.workday = ["workday.oauth"]` + `connector-secrets-manifest.ts`.
4. OAuth registration (review point 1): add `workday` to the `OAuthProvider` union; add
   `makeWorkdayDescriptor({tenantHost, tenant})` to `auth/oauth-registry.ts`; add the thin
   descriptor-resolution indirection in `auth/pkce.ts` + `auth/oauth-vault-tokens.ts` (static
   map for existing providers, factory for `workday`); add `auth/workday-access-token.ts`
   (`getValidWorkdayAccessToken(vault, cfg)`); add the `workday` case to the
   `oauthProfileForService` switch (NOT `OAUTH_UNSUPPORTED_DETAILS`).
5. Lazy-mesh spawn registry — `ensureWorkdayMcp`/`ensureWorkdayRunning` + the spawner bundle
   + `CredentialSpawners` slot.
6. Sync-handler registration + the connector's item-type registration (no migration).
7. `[connectors.workday]` config schema in `nimbus-toml.ts` (tenant_host, tenant, reports[]).
8. Docs: `docs/CHANGELOG.md` (connector-delivery convention — NOT the CLAUDE.md/GEMINI.md
   status line), roadmap row checkbox, connector README with the public-tier H2 sections
   (`audit:package-readmes`).

Exact call sites + signatures verified against 2–3 real connectors during the writing-plans
phase (per the plan-template-codebase-verification rule).

---

## 9. Testing & coverage

- **Unit:** mappers (allowlist-subset + forbidden-field assertions), search-filter, cursor
  encode/decode inverse, tool registration via `captureTools()`, RaaS denylist heuristic
  (expanded patterns), per-report `fields` allowlist, **RaaS row-id stability**
  (`key_field` → content-hash, never the array index, and reorder-invariance), **same-host
  URL validation** (report host == tenant_host; mismatch rejected), `makeWorkdayDescriptor`
  URL interpolation (`/ccx/oauth2/{tenant}/token`).
- **Contract:** PII allowlist test (§7) + `no-write-tools` test.
- **Sync:** fetch-faked at the HTTP boundary (the correct unit pattern); per-domain
  isolation (one domain 404 → others still map); RaaS report 401 skip.
- **Coverage floor (≥80% line+branch):** `server.ts` + `tools.ts` are auto-excluded by
  pathRegex; `mappers.ts`, `search-filter.ts`, `field-allowlist.ts`, and the gateway-side
  sync handler are NOT excluded and need ≥80%. Baseline is `{}` → every new non-excluded
  file must clear the floor. Authoritative env is Docker `oven/bun:latest` (local Windows
  `build-lcov.sh` under-reports subprocess/integration files).
- **jscpd:** keep a zotero/mendeley-clone shape to stay under the global 5% duplication gate.

---

## 10. Non-goals / deferred

- **People-graph enrichment** (feeding `person-store.ts` with authoritative Workday org data) —
  deferred to a later slice.
- **Writes** of any kind (time-off request/approval, worker edits) — out of scope; read-only.
- **ISU basic-auth for RaaS** — deferred; v1 uses the same OAuth bearer for REST + RaaS.
- **SOAP Web Services API** — not used.
- **Compensation, benefits, performance, payroll, personal-contact** data — permanently
  excluded by the allowlist, not deferred.
- **macOS Apple Mail / Calendar (sub-project E)** — separate spec, not this one.

---

## 11. Acceptance criteria

1. `nimbus index sync` populates `workday:worker`, `workday:time_off`, `workday:job_posting`
   items from REST and `workday:report` items from each configured RaaS report.
2. No forbidden PII field appears in any indexed item (proven by the contract test).
3. A domain that returns 403/404 (unlicensed module) is skipped without aborting the sync.
4. The three read tools list/get/search indexed Workday items; no write tool exists.
5. Full preflight green (typecheck, biome, tests, coverage-floor, static invariants,
   doc-refs, README audit) — verified Docker-Linux before the first push.

---

## 12. Review resolutions (2026-06-21)

Responses to `2026-06-21-slice9-workday-connector-design-review.md`:

| # | Topic | Resolution |
| --- | --- | --- |
| 1 | Tenant-specific OAuth endpoints | **Fixed** — `makeWorkdayDescriptor` factory + descriptor-resolution indirection (§3, §8). Verified feasible: registry core fns take the descriptor as a parameter. |
| 2 | Stable RaaS row IDs | **Fixed** — `key_field` else BLAKE3 content hash; array index never used (§4 `workday:report`). |
| 3 | RaaS egress / arbitrary URLs | **Fixed** — report host must equal `tenant_host`; validated at parse + before fetch; no dynamic host allowlisting (§3). |
| 4 | RaaS PII denylist weak | **Fixed** — expanded denylist patterns + optional per-report `fields` allowlist (§3, §4). |
| 5 | Time-off window not configurable | **Fixed** — `time_off_history_days` config, default 365 (§3, §5). |
| 6 | Job-posting embedding routing | **Declined w/ clarification** — description body is intentionally excluded from the allowlist, so 384/MiniLM is correct; documented a future-wave trigger to re-route to 1536 if the body is ever added (§4). |
