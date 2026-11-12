# Phase 10 stretch — FinOps connectors (Vantage, CloudHealth, Spot.io / Flexera, Kubecost, OpenCost)

Status: APPROVED by Antigravity (round 2, 2026-11-12). Owner rulings (§ 2) are binding; do not reopen them.

## 1. Goal

Index cost and cost-attribution data from third-party FinOps platforms into the local index, read-only,
with a stable item and metadata contract, so that a later detector (the roadmap row *Cost anomaly
detection*, not built) can read a per-team / per-tag / per-namespace daily cost series from SQLite
without a network call. The platforms exist to give cleaner attribution than raw cloud billing
exports (the roadmap's words): a team tag rolled up across accounts, a Kubernetes namespace or
controller priced per day, a saved cost report an engineer already curated.

Proposed acceptance criterion (the row has none; this is the one this project must meet):

- (FO) *With a Vantage API token configured, one sync cycle indexes daily cost rows for the last 45
  days grouped by the owner's chosen dimension, plus the active recommendations, and `nimbus query`
  over `cost_allocation` returns a gap-free daily series per `seriesKey` with provisional days marked.
  With a Kubecost or OpenCost URL configured, the same holds per namespace. A second sync with no
  upstream change upserts the same ids and changes no row. The token appears in no log line, IPC reply
  or egress row. A pinned test shows the series reader makes no network call and writes no row.*

## 2. Owner rulings

- **OR-10-8 (carried, from the incident-engine spec of 2026-11-12).** No model step in anything that
  runs unattended. Syncs, the retention pass and the series reader are deterministic and import no
  model code. A model may read the indexed rows only in an owner-run `nimbus ask`, through the normal
  `wrapToolOutput` path (I11); nothing here adds an LLM call.
- **OR-FO-1 (2026-11-12) All five products are in scope**: Vantage, Kubecost, OpenCost, CloudHealth
  and Flexera One / Spot (one vendor since the 2025 acquisition). FO5 (CloudHealth) and FO6
  (Flexera / Spot) are built from vendor documentation; every endpoint, field and auth detail that
  could not be read from a primary source stays marked UNVERIFIED in the code, the docs and the
  connector's README, and the connector's status reads "documented shape, not verified against a
  live account" until an owner with an account confirms it. FO6 starts with an endpoint-verification
  step and stops (recording what is missing) if no cost endpoint can be documented at all.
- **OR-FO-2 (2026-11-12) Owner-stored URL for in-cluster Kubecost and OpenCost.** The owner stores
  `http://localhost:<port>` (their own `kubectl port-forward`) or an `https://` ingress URL; Nimbus
  never starts a forward or spawns `kubectl`. The URL host becomes an owner-configured sandbox entry;
  FO4 includes the Windows loopback probe.
- **OR-FO-3 (2026-11-12) Sustainability connectors are a separate project.** The cost contract keeps
  its reserved `unit` key so a carbon series fits later.
- **OR-FO-4 (2026-11-12) No writes.** Costs, allocations and recommendations are indexed only.
- **OR-FO-5 (2026-11-12) Retention 400 days, at most 500 series per connector.**

Decided by me (recorded so review can challenge them):

- **D-FO-1 Read-only; no cost write row.** Every connector here has `hitlRequired: []`, registers no
  write tool and uses only GET requests (the one Flexera query that takes POST is pinned in § 7).
  Applying a recommendation (Spot, Vantage) would be a connector write row behind HITL, with a typed
  preview and a before-state; none is proposed. See Q4.
- **D-FO-2 Two new item types, one metadata contract.** `cost_allocation` (one row per series per UTC
  day) and `cost_recommendation` (one row per vendor recommendation). Neither is added to
  `ITEM_LINKED_ENTITY_TYPES` (`graph/relationship-graph.ts`): they are not graph entities in this
  project. Linking a namespace or a tag to a `[ci.service.X]` binding is later work (§ 4).
- **D-FO-3 Ids.** The item id is `"<service>:<native_id>"` with service one of `vantage`,
  `cloudhealth`, `flexera`, `kubecost`, `opencost`. For a cost row, `native_id` is
  `<scopeId>:<seriesHash>:<YYYY-MM-DD>` where `seriesHash` is the first 16 hex of SHA-256 over the
  canonical `dimensionKind|dimensionKey|dimensionValue` tuple, so ids are bounded in length and stable
  across syncs. A recommendation's id is the vendor token.
- **D-FO-4 Vendors are separate connectors.** Five ids, not one "finops" connector: auth, hosts, API
  shapes and failure modes share nothing but the output contract. Kubecost and OpenCost are separate
  ids (different path prefix, default port and docs) sharing one code kit in the connectors repo.
- **D-FO-5 Incremental by index watermark, not a stored cursor.** A cost series is restated by the
  vendor for recent days. The gateway's sync reads the highest finalized `periodStartMs` it already
  holds for the service from the index, and asks the connector for `[watermark - 3 days, today]`
  (first sync: 45 days). Ids are stable, so a re-read day is an idempotent upsert. This needs a small
  gateway transport variant that passes `sinceMs` to the list tool (the shared warehouse transport
  `createWarehouseListSyncable` passes only `cursor` and `limit`); it reuses `parseMcpListPage`. The
  3-day restatement window and the 45-day first window are this project's own conservative defaults,
  not vendor-documented numbers.
- **D-FO-6 Provisional days.** A row whose `periodEndMs` is inside the restatement window carries
  `finalized: false`. The detector must not baseline on provisional days. This is our convention; no
  vendor states when a day is final (UNVERIFIED for all five).
- **D-FO-7 Personal credentials only in v1.** These connectors are not added to
  `TEAM_CREDENTIAL_SYNC_CONNECTORS` (I19 team-vault sync). A team FinOps credential is a later slice.
- **D-FO-8 Non-secret configuration follows the Vault-key convention.** Report tokens, group-by and
  zone strings are stored as Vault keys beside the secret (as `sentry.org_slug`, `jira.cloud_id`), so
  `CONNECTOR_VAULT_SECRET_KEYS` stays the single registry the redaction and static vault-key audits
  read. They are not secrets and are not claimed to be. Every non-mandatory key is ALSO listed in
  `OPTIONAL_SECRET_KEYS` (same file, `Partial<Record<ConnectorServiceId, readonly string[]>>`, today
  only `github.api_base`), because `requiredSecretKeysFor` is "all keys minus the optional ones" and
  the configured check requires every remaining key: an unlisted optional key would make
  `vantage.api_token` alone read as unconfigured. The required key is the credential (Vantage
  `api_token`; Kubecost/OpenCost `url`; CloudHealth `api_key`); the rest are optional.
- **D-FO-9 Volume is bounded by construction.** Per source: at most `max_series` series (default 500,
  `[finops] max_series`), chosen by trailing 30-day amount; the remainder is one `__other__` series per
  day. Worst case 500 x 45 = 22,500 rows on first sync, then 500 rows per day. A retention pass deletes
  `cost_allocation` rows older than `[finops] retain_days` (default 400) through the existing delete
  chokepoint (`deleteItemByServiceExternal` in `index/item-store.ts`), after a successful sync only.
- **D-FO-10 Cost rows are not embedded.** A numeric daily row has no prose; embedding thousands of them
  wastes the embedder and pollutes search. Two sites choose items, and FO2 changes both: (1)
  `upsertIndexedItemForSync` in `index/item-store.ts` calls `ctx.scheduleItemEmbedding?.(id)` for every
  row, so it skips the call when `row.type === "cost_allocation"`; (2) `SqliteEmbeddingPipeline.backfillAll`
  in `embedding/pipeline.ts` selects every `item` with no `embedding_chunk` (a COUNT query and a batch
  SELECT), so both gain `AND i.type <> 'cost_allocation'`; the routed backfill (`backfillForRoutingKeys`)
  filters by `service:type` keys and needs the same exclusion. A test writes a cost row, runs the
  backfill and asserts no chunk exists. `cost_recommendation` rows are short prose and are embedded
  with the local model.
- **D-FO-11 No new IPC, CLI command, schema table or invariant.** Credentials go through the existing
  `nimbus connector auth <id>`; reads go through `nimbus query|search|ask`. The only new gateway module
  that reads cost rows is a pure helper (`finops/cost-series.ts`, § 5.1) for the future detector. If
  review wants a new invariant, it is "I5x" with a static rule "D4x" pinning the confinement in § 6;
  this spec does not claim one.
- **D-FO-12 The vendor's saved view defines the attribution; Nimbus does not.** With a Vantage cost
  report token the connector reads that report's saved groupings; without one it falls back to the
  documented default groupings. The owner's saved report in the vendor console, not Nimbus, defines
  the attribution (team, tag, cost category).

## 3. Owner questions (resolved)

All five were answered by the owner on 2026-11-12; see § 2 (OR-FO-1 to OR-FO-5). Q1 took the
all-five option rather than the recommended subset.

## 4. Non-goals

- **The cost anomaly detector.** The roadmap row *Cost anomaly detection* is not built and this project
  does not design it. The incident-engine spec (`2026-11-12-incident-engine.md`, slice IC8) replaces
  `watcher/anomaly-detector.ts` with a persisted rolling baseline over hourly buckets; the future cost
  detector should reuse that baseline and read this contract. Nothing here writes a baseline, a
  finding, a notification or a threshold, and nothing reserves schema or invariant numbers.
- **Raw cloud billing connectors** (AWS Cost Explorer, Azure Cost Management, GCP Billing). None exists
  in `@nimbus-dev/connectors`: the `aws` connector registers only Lambda and ECS tools (read from
  `connectors/aws/src`), and a search of the `azure`, `gcp`, `ramp`, `snowflake`, `databricks` and
  `bigquery` sources for cost tools found none. They belong to the detector row.
- **Data FinOps attribution** (warehouse query cost). The `snowflake` and `databricks` connectors index
  no credit, DBU or query-history data (a search of both `src` trees for credit, metering and
  query_history found nothing), so the roadmap sentence that the same detection window will cover
  Snowflake credits and Databricks DBUs has no source today. Separate row, separate project.
- **Cloud cost garbage collection**, **Sustainability connectors**, **Runbook automation**: other rows.
- **Vendor anomaly feeds and budgets** (Vantage `anomaly_alerts`, `budgets`; Kubecost alerts). Their
  response fields were not verified. Later work.
- **Cost writes** (Q4) and **team-vault credentials** (D-FO-7).
- **A UI page, a `nimbus finops` command, `ask` templates.** The rows are queryable; presentation is
  later.
- **Joining cost to services or incidents** (graph edges from namespace, tag or account to a service).
  Later; it needs a binding convention the owner has not set.
- No LLM in any unattended path (OR-10-8).

## 5. Design

### 5.0 What was verified, per product

Primary sources only; each cell cites where it came from. `UNVERIFIED` means a primary source was not
reachable or did not say.

| | Vantage | Kubecost | OpenCost | CloudHealth | Flexera One / Spot |
| --- | --- | --- | --- | --- | --- |
| Host | `https://api.vantage.sh/v2` [V1] | owner's URL [K1] | owner's URL [O1] | `https://chapi.cloudhealthtech.com` [C1]; regional hosts UNVERIFIED | `https://api.flexera.com` (NAM); EU/APAC API hosts UNVERIFIED; token hosts `login.flexera.com`, `.eu`, `.au` [F1]; Spot host `api.spotinst.io` per a third-party catalog only [S1] |
| Auth | `Authorization: Bearer`, service or personal token, Read/Write scopes chosen at creation [V2] | none documented [K1] | none documented [O1] | `Authorization: Bearer <api_key>` or `api_key` query param; key from My Profile; a new key invalidates the old [C1] | OAuth: refresh-token grant or service-account `client_credentials` at `/oidc/token`; 1 h access token; 50 req/min per refresh token [F1] |
| Cost endpoint | `GET /costs` (`cost_report_token` or VQL `filter`, `start_date`, `end_date`, `groupings`, `date_bin`, `limit` max 5000, `page`) [V3] | `GET /model/allocation` (`window`, `aggregate`, `accumulate`, `step`, `idle`, `shareIdle`) [K1] | `GET /allocation` (`window` required, `aggregate`, `step`, `resolution`, `includeIdle`) [O1] | `GET /olap_reports/cost/history` with `dimensions[]`, `measures[]`, `interval`, `filters[]`; perspectives at `/v1/perspective_schemas` [C1] | `POST /bill-analysis/orgs/{orgId}/costs/select`, community posts only [F2]; UNVERIFIED |
| Recommendations | `GET /recommendations` (`potential_savings`, `provider`, `status`, `min_savings`, `limit` max 1000) [V4] | not researched | not researched | UNVERIFIED | UNVERIFIED |
| Pagination | `page` + `limit`, `links.next` [V3][V4] | none (window-bounded); Aggregator variant `offset`/`limit` [K1] | none documented | `page`, `per_page` default 30, max 100 [C1] | UNVERIFIED |
| Rate limit | 1,000 req/h account-wide; Cost Report endpoints 5 req / 5 s; `429`; `x-rate-limit-{limit,remaining,reset}` [V5] | none documented | none documented | `429` on "post rate limit" only; GET limits UNVERIFIED [C1] | 50 req/min per refresh token (auth only) [F1] |
| Self-hosted | no | yes, in-cluster; `kubectl port-forward deployment/kubecost-cost-analyzer -n kubecost 9090`; querying the cost-model container directly (e.g. 9003) drops the `/model` prefix [K1] | yes; `kubectl -n opencost port-forward deployment/opencost 9003`; default URL `localhost:9003`; a service or ingress may expose it [O1] | no | no |
| Volume | per grouping x day; 5,000 rows per page | per aggregate x day | per aggregate x day | OLAP report rows | UNVERIFIED |

Facts worth stating plainly:

- Kubecost's documentation has moved: `docs.kubecost.com` 301-redirects to `apptio.com`, which
  301-redirects to `ibm.com/docs`. The allocation API text I could read was the IBM-hosted Kubecost
  1.x page (`SSW0JQG_1.x`); the 2.x page returned 404. Field names below are 1.x and must be re-checked
  against the installed version at FO3.
- Kubecost's allocation reply (1.x): `data` holds allocation objects with `name`, `properties`
  (`cluster`, `namespace`, `controller`, `controllerKind`, `pod`, `labels`, ...), `window`, `start`,
  `end`, `minutes`, `cpuCost`, `ramCost`, `gpuCost`, `pvCost`, `networkCost`, `loadBalancerCost`,
  `sharedCost`, `externalCost`, `totalCost`, `totalEfficiency`, with special names `__idle__`,
  `__unallocated__`, `__unmounted__` [K1]. `accumulate=false` returns daily sets. OpenCost's allocation
  reply is expected to match (OpenCost is the upstream of Kubecost's cost model) but I did not read it:
  UNVERIFIED.
- OpenCost is a CNCF Incubating project (accepted 2022-06-17, promoted 2024-10-25) [O2]. Its
  /allocation amounts are on-demand list pricing [O1]: an estimate, not the invoice. The index labels
  them `costKind: "list_estimate"` so the detector never mixes them with billed cost.
- The Vantage OpenAPI file lists `oauth2` with a `read` scope on each operation, and the docs page
  shows a Bearer header. I could not read the file's securitySchemes block (the file is 567 KB and the
  fetch was truncated), so the Bearer form is taken from the docs page [V2].

Sources:
- [V1] https://api.vantage.sh/v2/oas_v3.json (servers)
- [V2] https://docs.vantage.sh/api/authentication
- [V3] https://api.vantage.sh/v2/oas_v3.json (`GET /costs` and the list endpoints)
- [V4] https://docs.vantage.sh/api/recommendations/get-all-recommendations
- [V5] https://docs.vantage.sh/api/rate_limiting
- [K1] https://www.ibm.com/docs/en/SSW0JQG_1.x/apis/apis-overview/api-allocation.html (reached through the docs.kubecost.com redirect chain)
- [O1] https://opencost.io/docs/integrations/api
- [O2] https://www.cncf.io/blog/2024/10/31/opencost-advances-to-the-cncf-incubator/
- [C1] https://apidocs.cloudhealthtech.com/
- [F1] https://developer.flexera.com/docs/page/authentication
- [F2] https://community.flexera.com/t5/Flexera-One-Forum/Bill-Analysis-API-Question/m-p/141307 (a community post, not a reference)
- [S1] https://apis.io/apis/spot-by-netapp/spot-by-netapp-create-an-api-token-api/ (a third-party catalog)
- Flexera acquires Spot: https://flexera.com/about-us/press-center/flexera-to-acquire-finops-business-from-netapp-to-strengthen-portfolio

### 5.1 The contract (both repos agree on it; the gateway owns it)

Defined once in the gateway as a pure module (`packages/gateway/src/connectors/finops/cost-item-contract.ts`)
and mirrored by a fixture in each connector's tests. Mappers live in the gateway: the connector returns
vendor-shaped rows and the gateway maps them, as for Monte Carlo and Ramp.

**`cost_allocation`** (`service` in `vantage|cloudhealth|flexera|kubecost|opencost`):

| Key | Meaning |
| --- | --- |
| `seriesKey` | `<service>\|<scopeId>\|<dimensionKind>\|<dimensionKey>\|<dimensionValue>`; groups the daily rows of one series |
| `scopeId` | Vantage cost-report token or `default`; Kubecost/OpenCost cluster name or `default`; CloudHealth perspective id |
| `dimensionKind` | one of `tag`, `account`, `service`, `provider`, `cost_category`, `namespace`, `controller`, `cluster`, `perspective`, `other` |
| `dimensionKey` | the tag key or label name, else null |
| `dimensionValue` | the value; `__other__` for the max-series remainder; `__idle__`, `__unallocated__`, `__unmounted__` pass through for Kubernetes |
| `periodStartMs`, `periodEndMs` | the UTC day, epoch ms; `granularity` is always `"day"` in v1 |
| `amount`, `currency` | major units as a JSON number; the ISO 4217 code exactly as the vendor states it, else null (Kubernetes replies: UNVERIFIED whether they carry one) |
| `costKind` | `billed`, `amortized`, `list_estimate` (Kubecost, OpenCost) or `unknown` |
| `unit` | `"currency"` in v1; reserved for a carbon series (Q3) |
| `finalized` | boolean, D-FO-6 |
| `provider`, `cloudService` | when the vendor gives them, else null |
| `cpuCost`, `ramCost`, `gpuCost`, `pvCost`, `networkCost`, `sharedCost`, `idleCost` | Kubernetes only; numbers or null |

`title` is `"<dimensionValue> <YYYY-MM-DD> <amount> <currency>"`, `bodyPreview` the same, `url` null,
`modifiedAt` the period end capped at the sync time. Depth is `metadata_only`: no body.

**`cost_recommendation`**: `recommendationType`, `category`, `provider`, `cloudService`,
`providerAccountId`, `estimatedMonthlySavings` (number), `currency`, `resourcesAffected` (number),
`createdAtMs`, `documentationUrl`. Vantage only in v1; the fields are the ones listed in [V4]. `status`
is a query filter there, not a response field, so the connector requests `status=active`; a
recommendation that later archives is not re-upserted and its row is left in place (§ 8, no
upstream-deletion reconcile).

**The reader the detector will use** is `finops/cost-series.ts`:
`readCostSeries(db, { seriesKey, fromMs, toMs, finalizedOnly })` returns
`{ points: { dayMs, amount, finalized }[], gaps: number[] }` using `item` rows and `json_extract` paths
only. It makes no network call, imports no connector, egress or model code, and writes nothing. Its
tests build rows through the real mapper: a fixture must come from the writer, not be hand-built.

### 5.2 Slices (one PR each, in order)

| Slice | Repo | Content | Gate |
| --- | --- | --- | --- |
| FO1 | nimbus-mcp-servers | `connectors/vantage`: `vantage_cost_list`, `vantage_recommendation_list`, `vantage_cost_get`, `vantage_search` (read-only, on `createJsonGetter` from `shared/env-json-api.ts`); manifest `network: ["api.vantage.sh"]`; the pinned connector count in `scripts/connector-gates.test.ts` (94 today) raised to 96; `exports` entry; README; fixtures | merge, then release-please publishes the next minor of `@nimbus-dev/connectors`; FO2's pin bump cannot precede it (`audit:connector-version-skew`) |
| FO2 | Nimbus | Contract module and series reader; Vantage mapper and syncable on a `sinceMs` transport; the registration sites (§ 5.3); retention pass; embedding exclusion (D-FO-10); pin bump; docs; index-lane census | FO1 published |
| FO3 | nimbus-mcp-servers | `connectors/kubecost`, `connectors/opencost` and `shared/allocation-kit.ts`: `*_allocation_list`, `*_allocation_get`, `*_search`, read-only; `network: []` (the URL host is added by the gateway); count pin raised by 2 (to 98) | release |
| FO4 | Nimbus | Kubecost/OpenCost mappers and syncables; URL-and-optional-secret spawn helper (§ 5.4); `nimbus connector auth kubecost --url ... [--token ...]`; Windows loopback probe; pin bump | FO3 published |
| FO5a | nimbus-mcp-servers | CloudHealth connector (OR-FO-1), built from documentation, UNVERIFIED items marked; count pin to 99 | merge, then release publishes |
| FO5b | Nimbus | CloudHealth mapper, syncable, registration sites, pin bump | FO5a published; FO2 |
| FO6a | nimbus-mcp-servers | Flexera One / Spot connector, starting with an endpoint-verification step that stops the slice if no cost endpoint can be documented; count pin to 100 | merge, then release publishes |
| FO6b | Nimbus | Flexera mapper, syncable, registration sites, pin bump | FO6a published; FO2 |

A slice never spans both repos: the connectors PR merges and its release publishes first, then the
gateway PR bumps the pin (`audit:connector-version-skew` fails a pin to an unpublished version). FO1 to
FO4 already alternate this way; FO5 and FO6 are written as pairs for the same reason.

Each slice updates the five core docs and CHANGELOG. No schema migration in any slice: the `item` table
already holds an arbitrary `type` and JSON `metadata`, and no relation type is added. If a slice finds
it needs one, it takes "V9x (next free at merge)"; V94-V96 belong to the incident engine.

### 5.3 FO1 / FO2 — Vantage

**Tools** (connector). `vantage_cost_list` takes `{ sinceMs, cursor, limit }` and returns
`{ items, nextCursor }`, the shape every list tool returns (`parseMcpListPage`). It issues `GET /costs`
with `start_date` from `sinceMs`, `end_date` today, `date_bin=day`, and `groupings` from
`VANTAGE_GROUP_BY` (default: the saved report's groupings when a report token is set, else
`provider,service,account_id`, the documented default [V3]); `limit=5000`, following `links.next`. It
paces `/costs` at no more than one request per 1.2 s (the documented cap for Cost Report endpoints is 5
per 5 s [V5]; whether `/costs` is counted as one is UNVERIFIED) and stops on the first `429`, with an
error naming the `x-rate-limit-reset` time. `vantage_recommendation_list` has the same shape over
`GET /recommendations?status=active&limit=1000`.

**Vault keys** (`CONNECTOR_VAULT_SECRET_KEYS`): `vantage.api_token` (secret; the owner should create a
Read-only token; Nimbus cannot check a token's scope, § 8), `vantage.cost_report_token`,
`vantage.workspace_token` (Vantage requires it when a token spans workspaces [V3]), `vantage.group_by`.
Spawn env: `VANTAGE_API_TOKEN` and the three options, via `extensionProcessEnv` (I1).

**Sandbox.** `FIRST_PARTY_MANIFESTS.vantage = baseManifest("com.nimbus.vantage", { network:
["api.vantage.sh"], filesystem: { read: [], write: [] } })`. A fixed vendor host: no wildcard (I50
unchanged), no owner-configured entry. Spawned through `wrapServerSpec` (I15, static D10);
`audit:connector-hosts` must pass with no `connector-host-gaps.json` entry.

**Gateway registration sites.** Derived from where Monte Carlo appears (a grep of `packages docs
scripts`); a checklist, not a guarantee, and the slice re-derives it:
`connectors/connector-catalog.ts` (id, interval `HOUR6`, auth hint), `catalog/connector-catalog-meta.ts`,
`connectors/connector-secrets-manifest.ts`, `connectors/lazy-mesh/first-party-manifests.ts`,
`connectors/lazy-mesh/mesh.ts` (the listing-adder map) plus a new `phase3AddVantageMcp` in a new
`connectors/lazy-mesh/phase3-finops.ts` (the data-BI file's pattern), imported and called from
`connectors/lazy-mesh/phase3-config.ts` (`buildPhase3Servers`, where an adder actually runs),
`platform/assemble-sync-registrations.ts`, `sync/rate-limiter.ts` (the `Provider` union AND
`DEFAULT_QUOTAS: Record<Provider, ProviderQuota>`, which needs an entry per added provider: Vantage's
documented 1,000/hour is about 16/minute, so `requestsPerMinute: 16, burstSize: 2`; the Kubecost,
OpenCost, CloudHealth and Flexera values are our own conservative choices, 30/minute, burst 2, since no
limit is documented),
`connectors/bundled-connector-registry.ts` (generated by `scripts/gen-bundled-connector-registry.ts`),
`docs/structure-audit/index-lane-census.json`, `docs/cli-reference.md`, `docs/architecture.md`.
`config/nimbus-toml-connectors.ts` is not touched (D-FO-7). No `connector-writes/*` file is touched.

**Sync.** Cadence 6 h (`HOUR6` exists in `connector-catalog.ts`; cost data is daily, and the budget is
1,000 requests/hour shared with the owner's other automation). Per sync at the D-FO-9 worst case:
5 `/costs` pages plus 1 recommendations page. The transport drains before it writes, so a failed drain
indexes nothing. `initialSyncDepthDays` is 45.

### 5.4 FO3 / FO4 — Kubecost and OpenCost

**Tools.** `kubecost_allocation_list` / `opencost_allocation_list` take `{ sinceMs, aggregate, limit,
cursor }` and call `GET <base>/model/allocation` (Kubecost) or `GET <base>/allocation` (OpenCost) with
`window=<start>,<end>`, `aggregate=namespace` by default (owner key `*.aggregate`: `namespace`,
`controller`, `cluster`, `label:<name>`), `accumulate=false`, `step=1d`, `idle=true`. `window` is the
only required parameter [O1]. The `/model` prefix is dropped when the owner's URL points at the
cost-model container directly [K1], so a `*.path_prefix` key defaults to `/model` for Kubecost and to
empty for OpenCost. Each returned allocation set is one day; the connector flattens sets into rows.
Kubecost's Aggregator variant accepts `offset`/`limit` [K1]; the connector uses them only if the first
reply shows them (UNVERIFIED), else it returns everything with `nextCursor: null`, capped at
`max_series` before it returns.

**Credentials and URL.** Kubecost: `kubecost.url` (required), `kubecost.token` (optional). OpenCost:
`opencost.url`, `opencost.token`. Both: `*.aggregate`, `*.path_prefix`, `*.cluster_name` (used as
`scopeId`). Neither product documents authentication, so a token is sent as `Authorization: Bearer`
only when present; whether any real ingress honors it is UNVERIFIED.

**Sandbox and reachability (Q2 (a)).** Static network `[]`. `phase3AddKubecostMcp` reads `kubecost.url`,
calls `storedUrlHosts` (`http://localhost:9090` becomes the entry `localhost:9090`; an
`https://cost.example.com` URL becomes `cost.example.com`) and
`manifestWithExtraNetworkHosts(..., { ownerConfigured })`, exactly as Grafana and dbt do. The existing
`addUrlAndSecretMcp` returns without spawning when the URL or the credential is empty; Kubecost's token
is optional, so FO4 adds a URL-and-optional-secret sibling helper instead of weakening that one. A
stored URL that yields no entry (an IPv6 literal, a hostless value) leaves the connector with no
network and a warning, by service and never by value. On Linux the forwarder lets an owner-trust entry
reach loopback only for the owner's own `localhost` or literal on its declared port
(`platform/sandbox/net-address-rules.ts`, I50); on macOS the profile is ports only; on Windows the
policy is all-or-nothing and loopback reach from an AppContainer is UNVERIFIED (Q2). The auth command
refuses a URL whose host is loopback and whose port is the gateway's own HTTP or LAN port, so a typo
cannot point the connector at the gateway's write surface (I13); that is a check on a value the owner
typed, not a security boundary. The same check runs in the spawn adder (`phase3AddKubecostMcp`), not
only in the auth command, so a URL stored by another route or a changed port fails closed: no spawn,
no network entry. Tests: a stored `http://localhost:<gateway http port>` and a LAN-port URL are each
refused at auth and at spawn, and a different loopback port is accepted.

**Sync.** Cadence 6 h; first sync 45 days, then `watermark - 3 days`. A 45-day, 1-day-step, namespace
aggregate at the default 1-minute Prometheus `resolution` [O1] can be heavy for a large cluster; the
incremental window keeps steady-state load to 3-4 days per sync, and the first sync is the exception. A
first-sync timeout is reported and retried next cycle with a halved window (FO4 test).

### 5.5 FO5 / FO6 — CloudHealth, Flexera One / Spot (in scope, OR-FO-1)

A plan only, because the facts are thin.

- **CloudHealth.** Key `cloudhealth.api_key`, optional `cloudhealth.org_id` (many endpoints take
  `org_id`; omitted means the default org [C1]). Host `chapi.cloudhealthtech.com` fixed; a regional
  host, if one exists, is UNVERIFIED and would become an owner-configured entry. Data from
  `GET /olap_reports/cost/history` with `dimensions[]` set to a perspective and a daily `interval`
  (parameter semantics UNVERIFIED), mapped to `dimensionKind: "perspective"`. Row limits, OLAP response
  shape and GET rate limits are UNVERIFIED. The `api_key` query-parameter form is never used: a key in
  a URL lands in logs. Bearer header only.
- **Flexera One / Spot.** Keys `flexera.org_id`, `flexera.zone` (`NAM|EU|APAC`), and either
  `flexera.refresh_token` or `flexera.client_id` + `flexera.client_secret` (a service account). The
  connector exchanges at the zone's `/oidc/token` host [F1] and keeps the one-hour access token in
  memory only. `api.flexera.com` and `login.flexera.com` are documented for NAM; the EU and APAC API
  hosts are UNVERIFIED and must be confirmed before the zone key is offered. The cost call is
  `POST /bill-analysis/orgs/{orgId}/costs/select` per community posts [F2], UNVERIFIED; it reads
  despite the verb, and the connector's tests pin that it POSTs only to `/costs/select`. Spot-specific
  APIs (Ocean, Eco) are not designed: no primary source for their cost endpoints was found.

## 6. Security analysis

- **Credentials.** Tokens live only in the Vault (non-negotiable 3), reach the connector as spawn env
  through `extensionProcessEnv` (I1), and are listed in `CONNECTOR_VAULT_SECRET_KEYS` so redaction and
  the static vault-key audit cover them. A Vantage token with Write scope is not refused (Nimbus cannot
  read a token's scope); the connector has no code path that sends a non-GET to Vantage, a pinned test
  asserts every handler's HTTP verb, and the README tells the owner to create a Read-only token.
- **Sandbox hosts.** Vantage and CloudHealth: one fixed host each, no wildcard. Flexera: documented
  token and API hosts. Kubecost/OpenCost: `network: []` plus the owner's own URL host, labelled
  `ownerConfiguredNetwork` so the consent surface shows it is the owner's. As for GitHub Enterprise
  Server, a literal host check does not stop DNS rebinding, and an RFC 1918 or loopback target is
  allowed on purpose, because that is what an in-cluster cost service is.
- **Egress (I29).** Scheduled syncs are ledgered by the existing `sync` class; nothing new is added or
  excused. The retention pass and the series reader make no outbound call, and a runtime pin counts
  zero egress rows around them.
- **Untrusted content.** Names, labels, tags and report titles are vendor- or cluster-supplied text (a
  Kubernetes label is attacker-influenceable by anyone with write access to a namespace). They go into
  `title` and metadata as data; they are escaped by `wrapToolOutput` whenever a model reads them (I11),
  and never interpolated into a command, URL or SQL (I9: bound parameters). A label or tag value is
  capped at 256 characters; a longer one is truncated with an ellipsis and a short hash suffix so two
  truncations do not collide.
- **No action surface.** No write row, no HITL type, no model tool: I2, I26 and I53 are untouched. The
  federation gate (I26) has nothing new to refuse because the connectors register no write or prepare
  tool.
- **Unattended means inert (OR-10-8).** Syncs, retention and the reader import no model code. The
  static rule that would pin this is "D4x"; this spec proposes it and does not number it.
- **Data sensitivity.** Spend by team and namespace is commercially sensitive. It is indexed locally
  (non-negotiable 1) and no unattended path sends it to a non-local model. An owner-run `ask` that
  reads it sends it to the model the owner configured, as with any indexed item; there is no per-type
  redaction here (stated bound).
- **Rate limits as availability.** Vantage's 1,000 requests/hour is account-wide [V5]. A 6-hour sync
  uses about six requests per run, but a runaway loop could starve the owner's other automation, so
  the connector stops on the first `429` and does not retry within the run.

## 7. Testing and acceptance

- **Connector tests (nimbus-mcp-servers).** The contract test; a verb pin per handler (GET only for
  Vantage, Kubecost, OpenCost and CloudHealth; Flexera pins `/costs/select` as the only POST);
  fixture replies built from the documented shapes; pagination (`links.next` loop, a 5,000-row page,
  the `max_series` cap and `__other__`); `429` handling with `x-rate-limit-reset`; a token never
  appears in a thrown error.
- **Gateway tests (Nimbus).** Mapper tests per vendor over fixtures taken from the real connector's
  output, not hand-built; an end-to-end test over real SQLite with fake MCP replies (no mock at the DB
  layer) for the § 1 criterion: a first sync (45 days), then a second that re-reads the restatement
  window and changes no row; provisional flags; `max_series` and `__other__`; retention deletes only
  rows past `retain_days`; the series reader reports gaps explicitly; zero egress rows around it.
  `first-party-manifests.test.ts` and `phase3-config.test.ts` rows for the new hosts, including the
  owner-configured `localhost:<port>` entry and a stored URL that yields no entry failing closed with a
  warning and no spawn. The Windows loopback probe (FO4) is a real AppContainer test; per project
  convention it is self-validating (it proves its own positive control) rather than a platform skip
  that hides a silent gap. A unit test also pins the gateway-port refusal described in § 5.4.
- **Audits.** `audit:connector-hosts`, `audit:connector-version-skew`, `audit:tool-names`, the
  index-lane census (`docs/structure-audit/index-lane-census.json`, regenerated; it is known to miss
  accessor-helper reads, so the series reader uses the `json_extract` form it can see),
  `audit:coverage-floor` per new gateway file (85% line, 80% branch), `typecheck:tests`.
- **Live verification.** No test touches a real vendor account. Live reply shapes for all five are
  verified against documentation only; the first credentialed run is the owner's.

## 8. Stated bounds

- Reply shapes, restatement behaviour and the meaning of `amount` (billed or amortized, with or without
  credits, tax and refunds) are as documented, not observed. Vantage `settings[...]` controls credits,
  refunds, discounts, tax and amortization [V3]; v1 sends none and leaves them at the saved report's
  values, so `costKind` is `unknown` unless the owner's report is known to be billed.
- `finalized` is our convention (D-FO-6), not a vendor guarantee.
- Kubecost and OpenCost figures are on-demand list estimates [O1], not invoices. Kubecost field names
  are the 1.x names (§ 5.0).
- No upstream-deletion reconcile: an archived vendor recommendation, or a cost report removed upstream,
  leaves its rows until retention clears them. Every existing connector has this bound.
- The max-series cap hides the long tail inside `__other__`; per-series detection on a tail member is
  not possible from the index.
- Loopback reach from a Windows AppContainer is UNVERIFIED (Q2). The owner must keep a port-forward
  running; Nimbus reports the failure and does not loop on retries.
- Neither Kubecost nor OpenCost documents authentication. An unauthenticated ingress exposes cost data
  to the network, which is the owner's exposure. Nimbus sends a Bearer token if given and cannot tell
  whether the ingress honors it.
- Spend is commercially sensitive and is not redacted in an owner-run `ask`.
- The Vantage rate limit is account-wide and shared with the owner's other tooling.
- CloudHealth, Flexera One and Spot endpoints, regions and limits are mostly UNVERIFIED; FO5 and FO6
  may not begin without a person who can read the vendor's reference or call the API.
- The embedding exclusion (D-FO-10) is a type name in two places; a future item type of the same kind
  must be added to both.

## 9. Review log

### Round 1 (Antigravity, 2026-11-12)

Seven findings, each checked against the spec and the code before acting.

Applied:
- F1 (optional keys): `OPTIONAL_SECRET_KEYS` exists and `requiredSecretKeysFor` subtracts it; D-FO-8
  now requires every non-mandatory key to be listed there. The reviewer's quoted code (a `Set`, a
  different function body) is not what the file contains; the mechanism is real.
- F2 (embedding): `scheduleItemEmbedding` in `upsertIndexedItemForSync` and the `backfillAll` queries
  in `embedding/pipeline.ts` are real; D-FO-10 names both sites and the UNVERIFIED note is gone. The
  reviewer's `input.type` is `row.type` in the code.
- F3 (slices): FO5 and FO6 are now FO5a/FO5b and FO6a/FO6b, connectors first, then the pin.
- F4 (registration): `phase3-config.ts` `buildPhase3Servers` and a new `phase3-finops.ts` are listed.
- F5 (loopback): the gateway-port refusal is also enforced at spawn, with tests at both places.
- F6 (quotas): `DEFAULT_QUOTAS` entries are listed, with the derivation of each value.
- F7 (gate count): the pinned count is stated per slice.

Rejected or corrected:
- F3's quoted slice rows and the quoted CLAUDE.md sentence about `BUNDLED_CONNECTORS` and an explicit
  version do not exist in the spec or in CLAUDE.md; also FO5 is CloudHealth, not Vantage/Kubecost/OpenCost.
- F5's quoted `manifestWithExtraNetworkHosts(manifest, extraHosts)` body and `allowedHosts` field are
  not the real code (it takes a service id, hosts and `ownerConfigured`, and other connectors'
  manifests are untouched); the cross-connector-expansion concern it implies does not arise.
- F7's counts (97 and 99 for "3 and 2" connectors) are wrong: the pin is 94 today, and the five new
  connectors take it to 99 through FO1 (95), FO3 (97), FO5a (98), FO6a (99).

Round 2 (Antigravity, 2026-11-12): APPROVED. Three minor notes carried to the FO plans: (1) pick the `ConnectorCategory` for the five connectors in `catalog/connector-catalog-meta.ts` (an existing `cloud` or `finance`, or a new member); (2) if FO4's Windows loopback probe fails, the docs tell Windows owners to store a non-loopback or ingress URL; (3) Kubecost Aggregator `offset`/`limit` paging stays UNVERIFIED, with window-bounded retrieval capped by the 500-series limit as the fallback.

Correction (2026-11-12, FO1 plan round 1): the connectors repo main (0.13.0) already pins 95 connectors (google-calendar landed after the spec was drafted), so the five new connectors take the pin to 100: FO1 96, FO3 98, FO5a 99, FO6a 100. The round-1 note above that says "the pin is 94 today" is superseded.
