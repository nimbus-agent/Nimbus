# Plan — Incident engine IC2: alert sources and service bindings (JSM alerts, PagerDuty resolution time, bindings, graph routing)

Status: DRAFT for Antigravity review (round 1 pending).
Spec: `docs/superpowers/specs/2026-11-12-incident-engine.md` (approved, Antigravity round 3): § 2 (OR-10-8, OR-10-17,
OR-10-19), § 4 (the IC2 row), § 5.2 (IC2's design), § 7 (acceptance: tests driven by the real populators and
syncables, no hand-seeded edges), § 8 (stated bounds), § 9 (review log: round 2 added the graph routing for
alert, error-issue and data-quality triggers, the `occurredAtForItem` anchor change and the resolver bindings).
Builds on IC1 (PR #1981, branch `origin/dev/asaf/p10-ic1`, not yet merged): every code citation below is
`file:line` on that branch. IC2 starts from `main` AFTER IC1 merges (Task 0).
IC2 adds no HITL type, no invariant (the engine invariant is I57 and arrives in IC3), no static rule (see
"Static rules" below), no egress class, no model step, no IPC method, no `ALLOWED_METHODS` entry, no connectors
release. It adds one migration (the next free number at merge, provisionally V96).

After IC2: the `jira` sync indexes JSM Operations alerts as `jira:alert` items (open ones plus those closed in the
last 7 days, refreshed at most every 5 minutes, only where MB3's cloud-id rule lets the on-call pass run);
PagerDuty incidents carry `resolved_at_ms` and every consumer that used `modified_at` as a resolution time reads
it instead; `[ci.service.<id>]` and `[metrics.dora.<id>]` accept `jsm_alert_tags`, `sentry_projects`,
`data_models` and `depends_on`; `buildServiceIdentityResolver` resolves a bound `jira:alert`, `sentry:error_issue`
and `montecarlo`/`bigeye` `data_quality_test` to its Nimbus service; the graph correlates all four trigger kinds
(`incident`, `alert`, `error_issue`, `data_quality_test`) with deployments of the same service, anchored on each
source's real open time; deployments gain `deployed` (to the commit) and `built_by` (to the CI run) edges; CI-annotated
deployments finally reach the graph at annotation time; and a one-shot re-graph repairs existing data after the
upgrade.

## Spec deviations (checked against the code; each has its evidence and the correction this plan makes)

Where the spec is right, the plan follows it. Where the code disagrees, the correction below is binding for IC2,
and the later slices it touches are named. Items 1-9 would have broken the slice or its acceptance test if
implemented as the spec's prose reads.

1. **CI-annotated deployments never reach the graph, so the spec's `correlates_with` for them cannot happen.**
   `annotateDeployment` (`deployment/annotate.ts:161`) inserts its own `item` row (`:200-218`) and
   `deployment_items` row and returns; it never calls `syncGraphFromIndexedItem`. The only callers of the
   populator are `upsertIndexedItem` (`index/item-store.ts:180`) and `nimbus index regraph`
   (`graph/regraph.ts:217`). `docs/CHANGELOG.md:6165-6170` and `docs/architecture.md:938` already record "no
   `deployment` graph entity until `nimbus index regraph` runs". The P10 acceptance ("deploy before the alert
   assembled within 30 s") and every `correlates_with` edge the spec relies on need the deployment entity at
   annotation time. Correction: Task 9 graphs the annotated deployment right after the annotate transaction
   (a `graphDeployment` seam on the HTTP route and RPC context, wired in `ipc/http-server.ts`), failing soft.
2. **`ci_run_external_id` is always NULL, so `deployment --built_by--> ci_run` "via `ci_run_external_id`" finds
   nothing.** `annotate.ts:226-249` writes the literal `null` for that column; `CHANGELOG.md:2689` records the
   consequence (the oncall brief's CI lane is empty for annotated deploys). Correction: the edge is resolved from
   what the deployment does carry: its provider, its optional `run_id` and its sha, joined to a `ci_run` row of
   the mapped CI service whose external id ends with the provider's run token and whose `head_sha` equals the
   deployed sha (design D). Jenkins, Bitbucket and `other` have no usable key and get no `built_by`.
3. **`metadata.opened_at_ms` exists for PagerDuty (and the new alert) only.** Sentry writes `firstSeen`
   (`connectors/sentry-issue-mapping.ts`, metadata block), Monte Carlo `firstSeenAt` (ISO), and Bigeye writes
   no open time at all, with `modified_at = ctx.syncedAt` on every upsert (`bigeye-dq-mapping.ts`). Reading
   `opened_at_ms` with a `modified_at` fallback, as § 5.2 says, would anchor Sentry on `lastSeen` (it moves on
   every event, so edges would flap) and Bigeye on the sync time. Correction: the anchor comes from IC1's `born`
   definition per `(service, type)` (`index/item-history-keys.ts:62-149`: PD `opened_at_ms`, Sentry `firstSeen`,
   Monte Carlo `firstSeenAt`), read from the in-memory `row.metadata` (no `json_extract`, so no malformed-JSON
   hazard; a regraph parses with `parseMetadata`, `graph/regraph.ts:35-44`), and for a source with no open time
   (Bigeye) the entity's existing `occurredAt` is kept once set, else `modified_at` the first time (design D).
4. **Calling `syncTimelineEventGraph` from the error-issue and data-quality handlers, as § 5.2 words it,
   destroys their own edges.** `syncTimelineEventGraph` (`graph/graph-populator.ts:840`) upserts the entity with
   `metadata: { occurredAt, affectedService }` and runs `clearRelationsTouchingEntity` (`:176`), which deletes
   every non-cross-item edge: the `monitors` edges `syncDataQualityTestGraph` (`:674`) and the `belongs_to`/
   `assigned` edges `syncErrorIssueGraph` (`:945`) just wrote, and it overwrites the error-issue entity's
   `project` metadata. Correction: split the function. The entity upsert plus person edges stay with the incident
   path; a new `correlateTrigger` (clear incoming `correlates_with`, bail on no service, emit) is what the four
   kinds share, and the two existing handlers merge `occurredAt`/`affectedService` into the metadata they already
   write and call only `correlateTrigger` (design D).
5. **The one-shot re-graph "of incidents" is not enough.** The new edges and the corrected anchors touch
   deployments (never graphed when annotated, item 1), error issues and data-quality tests as well. Correction:
   `regraphAllItems` gains an optional `types` slice list and the one-shot runs `deployment`, `incident`,
   `error_issue` and `data_quality_test` (design F). It runs from a `_meta` marker the migration inserts, because
   a migration is SQL and cannot build the service resolver.
6. **"A meta version bump, so the next sync re-writes the rows" is false for PagerDuty.** The cursor
   (`pagerduty-sync.ts:17-39`) only moves forward (`since = lastUpdated`, `:318`); a bumped
   `PAGERDUTY_INCIDENT_META_VERSION` (`pagerduty-attribution.ts:11`) only makes `nimbus index rebody` eligible
   (`ipc/index-rebody-rpc.ts:153`). Correction: bump the version to 2 AND the cursor prefix to `nimbus-pd2:`
   (the old prefix decodes to null, so the next sync is a cold start over the 30-day floor and rewrites every
   incident created in that window). Older resolved rows stay without `resolved_at_ms` until `rebody`/another
   update; the consumers say so (design B).
7. **`buildServiceIdentityResolver` is in `metrics/service-identity.ts:271`, not `platform/assemble.ts`.**
   `assemble.ts:3923` only calls it (once, at boot, so a binding edit needs a restart plus `nimbus index regraph`,
   or the one-shot after this upgrade). `graph/` must stay free of a `metrics/` import (comment at
   `graph-populator.ts:22-33`), which is why the resolver type is declared twice; IC2 keeps that.
8. **"Only when a cloud id is stored" misdescribes MB3.** `resolveCloudId` (`connectors/jsm-oncall.ts:135-164`)
   uses the stored `jira.cloud_id`, else the cursor's cached `cid` for the same site, else (only on an
   `*.atlassian.net` site) a `tenant_info` lookup, else skips. The alert pass reuses that function unchanged, so
   its gating is exactly the shift pass's.
9. **The alert pass cannot "call `jira_ops_alert_list`".** The gateway's Jira sync does not use the MCP child;
   MB3 reaches the Operations API directly with `fetch` at one pinned host, `redirect: "manual"`, the Vault
   credential, and `ctx.rateLimiter` (`jsm-oncall.ts:21`, `:73-102`), and a source test pins exactly ONE
   `https://` literal and ONE `fetch(` in that file (`security-invariants.test.ts:878-890`). The tools'
   `GET /alerts` and `GET /alerts/{id}` (`@nimbus-dev/connectors` 0.13.0 `connectors/jira/src/tools.ts`
   `jira_ops_alert_list` and `jira_ops_alert_get`; 0.14.0 is byte-identical for `connectors/jira`) return the raw
   API body, so they are the SHAPE reference only. Correction: the pass reuses MB3's request function through an
   export, adds no `fetch(` and no `https://` of its own, and builds every URL itself (never follows a URL from a
   reply). No connectors release; the pin stays at the version `main` has (`^0.13.0`, `packages/gateway/package.json:21`).
10. **`closed_at_ms` is not in the list reply.** The documented alert carries `createdAt`, `updatedAt` and a `report`
    object whose `ackTime` and `closeTime` are durations from creation (Opsgenie lineage; UNVERIFIED against a live
    site). Correction: `closed_at_ms = opened_at_ms + report.closeTime` only when `report.closeTime` is a finite
    number and the alert is closed; otherwise the key is absent (consumers print "closed, time not recorded").
    `updatedAt` is never used as a close time (a note added after closing moves it). `acknowledged_at_ms` likewise.
11. **`repos` is a required key of both tables** (`service-config-toml.ts:96-99`), so a service reached only by
    alert tags still needs a `repos` entry. Unchanged; documented. The spec's "unknown keys stay an error" holds
    (`:164-166`): the four new keys join `SERVICE_CONFIG_KNOWN_KEYS` (`:22-29`), nothing else.
12. **Widening the correlation changes two existing readers.** (a) `buildNoDownstreamIncidentSql`
    (`index/negation-predicates.ts:213`) counts ANY outgoing `correlates_with` edge as "a downstream incident"; with
    Sentry/data-quality triggers a deploy followed by a noisy error group would stop being listed. Correction: the
    predicate counts only edges to `incident` and `alert` entities (what pages someone), keeping its meaning.
    (b) The `alert_fired` watcher kind (`automation/watcher-condition-kinds.ts:56-68`) has "no connector indexes
    `item.type = 'alert'` today"; `jira:alert` makes it live, and its note that the populator has no `alert`
    branch becomes false. Correction: update the note, scope the kind to `status != 'closed'`, and leave
    `affectedServiceEntityType` for a reviewer decision (Risks).
13. **IC1's plan left two registrations for IC2** (IC1 plan, Risks): `jira:alert` in `ITEM_HISTORY_SPECS`, and
    PagerDuty's resolution time as a `source_at` source. Both are in Task 3 and Task 2 (design G). IC1's `status`
    key for PagerDuty is `always: true`, so rewriting rows at the upgrade (new metadata keys only) writes no history
    rows.
14. **The spec's `jira:alert` metadata list omits what the registrations need.** Adds `alert_id`, `updated_at_ms`
    (not tracked), `acknowledged_at_ms`, `meta_v`. `owner_team` is the id of the first `responders[]` entry whose
    `type` is `team` (the documented alert has `responders: [{id, type}]`; there is no single owner-team field in
    the shape I can cite), else null.

Spec claims verified correct (no deviation): `jira_ops_alert_list`/`_get` exist in 0.13.0 with the input shapes
used below; the MB3 pass is the right model (cursor-paced, six-hour backoff on 401/403/404, 60 s step budget); the
next free migration after IC1's V94 is a free number at merge (FS1 holds V95); `GRAPH_SYNC_BY_TYPE` has no `alert`
entry and `error_issue`/`data_quality_test` handlers never correlate (`graph-populator.ts:1015-1048`);
`ITEM_LINKED_ENTITY_TYPES` already lists `alert` and `ci_run` (`graph/relationship-graph.ts:6-24`) with no handler
(`regraph.ts:96-103` says so).

## Static rules, invariants

IC2 needs no new static rule and adds no invariant. Checked: D24 (syncables reach the index only through
capabilities) is satisfied because `jsm-alerts.ts` uses `ctx.upsertItem`, `ctx.writeBatch`, `ctx.rateLimiter`,
`ctx.getSecret` only; D46(b) (`item_history` has one writer) is untouched because IC2 only READS the table's
`born` definition in code and registers keys; the host/redirect pin is a source test, extended in Task 4 rather
than a new rule; D45 (incident confinement) and D46(a) arrive with IC3. The engine invariant stays I57 (FS1 took
I56) and is IC3's. If review wants the "one `fetch(`" pin generalised across `jsm-oncall.ts` and `jsm-alerts.ts`,
that is a test, not a D-rule.

## Design decisions

### A. The JSM Operations alert pass (`connectors/jsm-alerts.ts`, `connectors/jsm-alert-mapping.ts`)

**Placement.** A second pass inside the `jira` sync run, after the issue sync, the snapshot and the on-call pass
(`jira-sync.ts:812-888`), exactly as `jiraOncallIfDue` (`:793`) sits there. It never throws into the sync
(`try/catch`, a warn, `alAt = now`), so the issue sync that already ran is not failed.

**Gating, cadence, cursor (mirrors MB3).**
- Credentials: the same `JiraVaultCreds` (`jira-sync.ts:132-153`).
- Cloud id: MB3's `resolveCloudId` (`jsm-oncall.ts:135`), exported unchanged; its `stop: "none"` skips the pass
  (the attempt is still recorded, so a site that cannot run it is retried once per interval, not per sync).
- Cursor: `JiraSyncCursorV1` (`jira-sync.ts:42`, prefix `nimbus-jra1:` at `:31`) gains `alAt` (last ATTEMPT, ms),
  `alUntil` (backoff) and `alOpen` (ids seen open at the last complete pass, at most 200). `decodeOncallFields`
  (`:73`) gets a sibling `decodeAlertFields`; both are merged when the cursor is rewritten (`:880-886`), alert
  fields owning only their keys. `cid`/`cidSite` stay shared: the alert pass runs with `{ ...prev, ...oncall }` so
  a cloud id resolved by the shift pass in the same run is reused, and it writes `cid`/`cidSite` only if it
  resolved them itself. No cursor prefix bump (old cursors decode; absent keys mean "never attempted").
- Due: `snapshotDue(prev.alAt, now, JSM_ALERT_REFRESH_INTERVAL_MS)` (`_lib/work-snapshot-run.ts:39`), 5 minutes; not
  inside an `alUntil` backoff (`<= 6 h`, a larger value is a corrupt cursor and ignored, as `:799-801`). A 401, 403
  or 404 on the first list sets `alUntil = now + 6 h` (`JSM_UNAVAILABLE_BACKOFF_MS`, `jsm-oncall.ts:25`): JSM
  Operations is not licensed or not permitted for this account.
- Budget: one 60 s step budget (`JSM_STEP_BUDGET_MS`, `jsm-oncall.ts:24`) through MB3's `Remaining` closure and
  `acquireWithin(ctx, remaining)` (`:65`), `ctx.rateLimiter` key `"jira"`.

**Requests (all through MB3's exported `jsmGet`, `jsm-oncall.ts:73`).** `root = ${JSM_OPS_ROOT}/${cid}/v1`
(`:21`, `:456`). Open pass: `GET ${root}/alerts?size=100&offset=N&sort=updatedAt&order=desc&query=status%3Aopen`
for at most 5 pages (500 alerts). Closed pass: the same with `status%3Aclosed`; stop at the first page whose last
alert has `updatedAt < now - 7 d` or after 5 pages; alerts older than the cutoff on the final page are dropped
client-side. `offset + size` stays far under the API's 20,000 bound. If the first open request answers 400 (the
documented query syntax is UNVERIFIED on a live site), the pass falls back ONCE to an unfiltered list sorted by
`updatedAt` descending, 5 pages, keeping every open alert and the closed ones inside the window, and logs it.
Alert ids are validated with MB3's `SAFE_ID` (`jsm-oncall.ts:28`, exported) before they enter a path.
**Stale-open reconcile:** ids in `prev.alOpen` that the current COMPLETE open listing no longer returns are fetched
one by one (`GET ${root}/alerts/{id}`, at most 20 per pass, the same budget), so an alert closed while the gateway
was offline is refreshed to `closed` instead of staying open forever. `alOpen` for the next pass is this pass's
open ids (cap 200); when the open listing was incomplete (page cap, failure, budget) it is the union with the
previous set, capped.

**Reply parsing (documented shapes, UNVERIFIED live; stated bound).** List: an array at `values`, else at
`alerts`, else the body itself if it is an array; each element a record. Single get: the record at the root, else
under `data`, else `result` (`jsm-oncall.ts:113-122` `bodyWith` is the model). Entries without a usable id are
skipped and counted; a non-list reply is a failed page (partial, never a throw).

**Mapping (`mapJsmAlertToItem`, pure, exported for the history test).** Item `service: "jira"`, `type: "alert"`,
`externalId = alert id`, so the item id is `jira:<alertId>` (no collision with `jira:KEY-1` issues). `title =
flatten(message)` capped at 512 (`flattenOncallText`, `connectors/oncall-shift-items.ts:36`); `bodyPreview = status`
(as PagerDuty, `pagerduty-sync.ts:97-116`: no description text is indexed); `url: null` (an alert URL is not in the
documented reply and is not invented); `modifiedAt = updatedAt` (the provider's change clock; `authorId: null`);
not in `PROSE_HEAVY_TYPES` (`embedding/routing.ts:9-60`: stays on local MiniLM, like `sentry:error_issue`). Metadata:

| key | source | notes |
| --- | --- | --- |
| `alert_id` | `id` | always |
| `status` | `status`, lower-cased | always (`open`, `closed`); anything else stored as lower-cased text |
| `priority` | `priority` when `/^P[1-5]$/` | always (null when absent or malformed) |
| `acknowledged` | `acknowledged === true` | always (boolean) |
| `opened_at_ms` | `createdAt` (ISO string, or epoch number) | when parseable |
| `updated_at_ms` | `updatedAt` | when parseable |
| `closed_at_ms` | `opened_at_ms + report.closeTime` | only when closed and the sum is finite (deviation 10) |
| `acknowledged_at_ms` | `opened_at_ms + report.ackTime` | only when acknowledged and finite |
| `tags` | `tags`, strings only, flattened, 100 chars each, at most 20 | always (array) |
| `entity`, `source` | `entity`, `source` strings, flattened, 200 chars | when present |
| `owner_team` | first `responders[].id` with `type` `team` | when present (deviation 14) |
| `meta_v` | `JSM_ALERT_META_VERSION = 1` | always |

Responders' individual ids, the owner user, description, details and the integration are NOT stored (free text
and people). A mapper never defaults a timestamp (a defaulted time corrupts anchors): absent stays absent.
Writes happen inside `ctx.writeBatch` per page (`sync-capabilities.ts:177`).

**History registration (IC1's allowlist).** `ITEM_HISTORY_SPECS` (`index/item-history-keys.ts:62`) gains
`"jira:alert"`: keys `status` (always), `priority` (always), `acknowledged` (always); `born: { opened_at_ms, ms }`;
`modifiedAtTracksChange: true` (`updatedAt` moves with every acknowledgement, close and note); `sourceAt`:
`status -> closed` from `closed_at_ms`, `acknowledged -> true` from `acknowledged_at_ms`. The writer-derived pin
test (`item-history-keys.test.ts:218-243`) gains the matching `WRITERS` fixture (its first test requires the two
key sets to be equal, `:219-224`).

### B. PagerDuty resolution time

`buildPagerdutyMetadata` (`pagerduty-sync.ts:66-95`) writes two keys from `last_status_change_at` (ISO; the PD
incident object's own field): `status_changed_at_ms` when the string parses, and `resolved_at_ms` (the same
value) only when `status === "resolved"`. Both are conditional keys (set with `if`, like `opened_at_ms`), so a
reply without the field writes neither and consumers see "absent". `status_changed_at_ms` is an extension beyond
the spec, for the timeline's acknowledged/triggered times (one line, drop if the reviewer objects).
`PAGERDUTY_INCIDENT_META_VERSION` 1 -> 2 (the docstring line gains "2 - `resolved_at_ms` / `status_changed_at_ms`");
`CURSOR_PREFIX` `nimbus-pd1:` -> `nimbus-pd2:` (deviation 6). History: `ITEM_HISTORY_SPECS["pagerduty:incident"]`
(`item-history-keys.ts:64-76`) gains `sourceAt` rules `status -> resolved` (from `resolved_at_ms`) and
`status -> acknowledged`/`triggered` (from `status_changed_at_ms`); `resolved_at_ms` is NOT a tracked key (a rewrite
at the upgrade would otherwise log a spurious change). The demo corpus (`demo/corpus/acme.ts:331-358`) writes a
resolved incident without it; it gains `resolved_at_ms` (a duration parameter on the `incident` helper) so the demo
MTTR stays measured.

**Every consumer that used `modified_at` as a resolution stand-in** (found by grepping `modified_at` with
`resolved`/`status` over `metrics/`, `agents/`, `graph/`; the first two are the spec's, the third is an additional
one of the same defect, the fourth is deliberately left):
1. `metrics/dora.ts:384` `selectResolvedIncidents`: windowed on `i.modified_at` (`:399-400`) and `resolved:
   r.modified_at` (`:411`). New: select on `json_extract(metadata, '$.resolved_at_ms')` (guarded by `json_valid`
   and `json_type IN ('integer','real')`) inside the window, `status = 'resolved'`. A resolved row WITHOUT the key
   is dropped from the sample and counted: the result carries the new gap `incomplete_resolution_data` (precedent:
   `incomplete_merge_data`, `dora.ts:17-19`). That value joins `DoraGap` (`dora.ts:6-24`), `StatsGap` where it
   forwards, `openapi/v1.yaml:420-430` and `:470-480`, and the CLI gap text; `audit:openapi-drift` checks it.
2. `agents/_lib/oncall-queries.ts:478` `selectPriorIncidents`: `resolvedAtMs` (`:517`) is `resolved_at_ms` or null.
   `OncallPriorIncident` (`agents/_lib/oncall-types.ts:164-179`) gains `closed: boolean` so "closed, time not
   recorded" is distinguishable from "still open"; `priorIncidentClosure` (`agents/_lib/render.ts:1634`) renders it;
   the two docstrings that call `modified_at` "the closest thing the index holds" are rewritten.
3. `agents/changelog-queries.ts:286` `selectIncidentsResolved` and `agents/_lib/changelog-event-time.ts:49-51`
   `incidentResolved`: today `selectByModifiedAt` + the `modified_at` extractor. New: rows WITH `resolved_at_ms`
   are windowed on it (`selectByEventField`, `:109`, `timeSource: "event"`); resolved rows WITHOUT it keep the old
   `modified_at` window and are labelled `timeSource: "index"` (a list, unlike a statistic, is better with a labelled
   legacy row than without it).
4. NOT changed: `agents/standup-queries.ts:306-337` (`selectIncidentsResponded`) windows on `modified_at` as
   `last_touch` on purpose and discloses it ("there is no per-response timestamp"); resolution time is not what it
   answers.

### C. Bindings: parser, `ServiceConfig`, resolver

**Parser** (`config/service-config-toml.ts`). `SERVICE_CONFIG_KNOWN_KEYS` (`:22-29`) gains `jsm_alert_tags`,
`sentry_projects`, `data_models`, `depends_on`; `materializeOneServiceConfig` (`:91-114`) builds them with
`parseStringArray` (`toml-primitives`), each default `[]`. Validation (each failure throws with the
`[<block>.<id>].<key>` prefix, like `:44-88`): every entry a non-empty trimmed string; `jsm_alert_tags` at most 50
entries of at most 128 characters; `sentry_projects` at most 50 entries matching `/^[a-z0-9][a-z0-9_-]{0,99}$/`
(Sentry slugs); `data_models` at most 50 globs of at most 200 characters with no whitespace, lower-cased at parse
time and checked to contain at least one non-`*` character; `depends_on` at most 50 entries, none equal to the
service itself. Dangling `depends_on` targets are NOT a parse error (the two tables are merged later): the merge in
`loadNimbusServiceConfigsFromConfigDir` (`config/nimbus-toml.ts:2996-3020`) writes one stderr warning per dangling
target, in the style of its duplicate-id line (`:3009-3013`). `depends_on` is a direct edge list; the cascade
(IC4) interprets it, IC2 only stores it.

**`ServiceConfig`** (`metrics/dora-config.ts:8-17`) gains `jsmAlertTags`, `sentryProjects`, `dataModels`,
`dependsOn` (all `readonly string[]`, required). To keep literals in tests and fixtures cheap, the module exports
`NO_INCIDENT_BINDINGS` (four empty arrays) to spread; the production literal sites are
`service-config-toml.ts:100`, `agents/changelog.ts:280` and `demo/seed.ts` (its `pagerduty_services` mention is a
TOML string). About twenty test/fixture files build `ServiceConfig` objects (grep `severityP1Aliases`: the list is
in the File map); `bun run typecheck:tests` finds the rest.

**Resolver** (`metrics/service-identity.ts:271-324`). A fourth step, after the existing three (so no existing
resolution changes), keyed on `(item.service, item.type)` and returning `unknown` when nothing matches (the
populator then falls back to `metadata.service`, which these items do not carry, so they correlate with nothing):
- `jira:alert`: any entry of `metadata.tags` equals (lower-cased, trimmed) any `jsmAlertTags` entry of a config.
- `sentry:error_issue`: `metadata.project` (a slug, `sentry-issue-mapping.ts` metadata) equals a `sentryProjects`
  entry. Project slugs are unique per organisation only; two organisations with the same slug bind together (stated
  bound; `metadata.org` exists if review wants it in the key).
- `montecarlo:data_quality_test` and `bigeye:data_quality_test`: any key of `metadata.monitoredDataModelKeys`
  (already `normalizeDataModelKey`ed, `connectors/data-model-key.ts`) matches any `dataModels` glob. The matcher
  (`metrics/data-model-glob.ts`, pure) supports `*` only, matching any run of characters including `.`; it splits
  the glob on `*` and compares literal segments with `startsWith`/`indexOf`/`endsWith` (no `RegExp`, so no ReDoS and
  no Sonar S5852).
- First claimant by config order wins (as `:296-309`); a type that is not deployment never goes through
  `deploymentBindingResolution`'s environment gate (`:144-158` only gates `deployment`). Ambiguity: tags and slugs
  are exact keys, so they join `indexAmbiguousBindings` (`:186`) with new `bindingKind`s (`jsm_alert_tag`,
  `sentry_project`); a glob overlap cannot be precomputed, so it warns once per matched model key per resolver
  lifetime. `AmbiguousBindingWarning.bindingKind` (`:41`) widens accordingly; `assemble.ts:3923-3929` already logs
  any warning.

### D. Graph (`graph/graph-populator.ts`)

**Anchor.** `occurredAtForItem(db, itemId)` (`:991-1003`) becomes `occurredAtFor(db, row, kind)`:
- `deployment`: unchanged (`modified_at`, which `annotate.ts:201` sets to `started_at_ms`).
- a trigger kind: the source's `born` (from `specFor(service, type)?.born`, `index/item-history-keys.ts:153`) read
  from `row.metadata` (`ms` as a finite number, `iso` through `Date.parse`); if the spec has no `born` (Bigeye), the
  existing entity's `metadata.occurredAt` when it is a finite number (the anchor is stable once set); else
  `modified_at` (the throw on a missing row stays, `:996-1000`). `graph/` importing `index/item-history-keys.ts`
  is allowed (it already imports `index/item-key`, `index/migrations/runner`); the pin test in Task 7 asserts the
  graph's anchor and IC1's `born` are the same definition for the four tracked trigger types.

**Split of `syncTimelineEventGraph`.** Today (`:840-905`) it: resolves the service, upserts the entity with
`{ occurredAt, affectedService }`, clears non-cross edges, clears the side's `correlates_with` direction, adds person
edges (incident only), bails on no service, then emits. New shape, in order, as named steps:
1. `TriggerKind = "incident" | "alert" | "error_issue" | "data_quality_test"`; `TimelineKind = TriggerKind | "deployment"`.
2. `correlateTrigger(db, entityId, occurredAt, affectedService | undefined, now)`: clear INCOMING `correlates_with`
   (`clearIncomingRelationsOfType`, `:204`), return if no service, else for each deployment counterpart in
   `[occurredAt - CORRELATION_WINDOW_MS, occurredAt]` (nearest first) `upsertGraphRelation(dep, entity,
   "correlates_with")`. The "clear BEFORE the service bail-out" rule (`:864-872`) is preserved inside it.
3. `timelineCounterparts` (`:722`) takes `counterpartTypes: readonly TimelineKind[]` and uses `type IN (...)`
   (bound parameters); the deployment side asks for the four trigger kinds.
4. `syncTimelineEventGraph` (incident, alert, deployment): upsert, `clearRelationsTouchingEntity`, then
   `correlateTrigger` for triggers, or for a deployment `clearOutgoingRelationsOfType("correlates_with")`, forward
   correlation, then `linkDeploymentToChange` (design E). Person edges stay `incident`-only (`syncIncidentPersonEdges`,
   `:820`).
5. `syncErrorIssueGraph` (`:945`) and `syncDataQualityTestGraph` (`:674`) take the resolver; compute the anchor and
   service FIRST, write them into the entity metadata they already upsert (`{ project, occurredAt, affectedService }`
   for error issues, `{ occurredAt, affectedService }` for data-quality tests, which had `null`), do their existing
   clear and edges unchanged, and end with `correlateTrigger`. Readers of the old metadata: none read
   `error_issue.project` (grep: only the populator writes it).
6. `GRAPH_SYNC_BY_TYPE` (`:1015`) gains `alert` (through `syncTimelineEventGraph`), `ci_run` (design E), and passes
   `resolveServiceId` to the two handlers above. The doc comments at `graph/regraph.ts:96-103` and
   `automation/watcher-condition-kinds.ts:56-62`, which say `alert`/`ci_run` have no branch, are corrected.
No new `CROSS_ITEM_RELATION_TYPES` entry: `correlates_with` is already there (`:168-174`), and the new `deployed`/
`built_by` edges are owned by the deployment's own sync, which clears and re-emits them (they are NOT cross-item).

### E. Deployment edges (`graph/deployment-edges.ts`, new)

Relation types `deployed` and `built_by` must exist in `graph_relation_type` first: `graph_relation.type` is an FK to
it (`index/graph-v7-sql.ts:21`), the seed pattern is `INSERT OR IGNORE INTO graph_relation_type` (V12, V27, V40).
Neither name exists today (grepped). The migration seeds them (Task 1).

- **Forward** (`linkDeploymentToChange`, called by the deployment arm of `syncTimelineEventGraph` after its clears):
  `sha` = `metadata.sha` (annotated deploy) else `metadata.commit_sha` (Vercel, `vercel-deployment-mapping.ts`);
  none, no edges. Commit entities are the `commit` type with external id `<service>:<sha>` (written by
  `syncPrGraph` `:324-353` from `merge_commit_sha`, and `syncGitCommitGraph` `:425-437`); a deployed sha is 7..64
  hex (`annotate.ts:24`, `:139-146`), so the match is the prefix rule `findCommitEntityIds` already uses (`:577`), but
  collecting ALL matches: link only when exactly one distinct full sha matches (a short ambiguous prefix gets no
  edge). `deployed`: deployment -> commit entity. `built_by`: deployment -> `ci_run` entity, found by SQL over
  `item` (`type = 'ci_run'`, `service` = the mapped CI service of the deployment's provider, `external_id` ending
  with the provider's run token for `metadata.run_id`, `json_extract(metadata, '$.head_sha')` equal to the sha,
  `json_valid` guarded, newest first, LIMIT 1): `github-actions` -> `github_actions` + `#run-<run_id>`
  (`github-actions-sync.ts:152`), `gitlab` -> `gitlab` + `#pipeline-<run_id>` (`_lib/gitlab/pipelines.ts:62`),
  `circleci` -> `circleci` + `#p<run_id>` (`circleci-sync.ts:135`, assumes `run_id` is the pipeline number;
  UNVERIFIED, the `head_sha` equality makes a wrong guess produce no edge, never a wrong one). The `ci_run` entity is
  created with `ensureGraphEntity` keyed by the item id (`ITEM_LINKED_ENTITY_TYPES` includes `ci_run`, so
  `deleteGraphEntitiesForItemKeys` cleans it).
- **Reverse (order independence).** A CI run usually syncs AFTER the deploy step that annotated it, and a PR can sync
  after a deployment, so forward-only linking would miss the common order. `relinkDeploymentsForCommit` (called right
  after `syncPrGraph`'s `merged_as` upsert and after `syncGitCommitGraph`'s clear) and `relinkDeploymentsForCiRun`
  (a new `ci_run` handler, `syncCiRunGraph`: upsert the `ci_run` entity, then relink) find deployments through
  `deployment_items` by `sha IN (prefixes 7..len of the full sha)` (an equality probe on the new index) and emit the
  same edges. Cost: one entity upsert and one indexed select per `ci_run` item written (30 per repo per pass); the PR
  records a measurement on a seeded index. `syncGitCommitGraph` clears non-cross edges on its commit entity
  (`:437`), which would drop incoming `deployed`; the relink call is the line right after that clear.
- Bounds, stated: Vercel deployments are not in `deployment_items`, so they link forward only; Jenkins/Bitbucket/
  `other` get `deployed` but not `built_by`; a deployment sha shorter than 12 characters with two matching commits
  gets no edge; run-token formats are from the three sync writers, not a live account.
- `traverseGraph` (`relationship-graph.ts:278`) and `nimbus impact`/`why` walks now reach commits and CI runs from a
  deployment (intended; their lane tests are re-run, Task 12).

### F. Migration (V9x, provisional V96) and the one-shot re-graph

"V9x (next free at merge, likely V96)": IC1 is V94 (`index/local-index.ts:307`), FS1 (branch `dev/asaf/p10-fs1`, not
pushed yet) V95, FO2 is in flight. Every place that names the number, to renumber if merge order changes: the new
`index/<name>-v96-sql.ts`; `index/migrations/runner.ts` (import next to `:69`, `simpleStep(95, 96, ...)` after
`:786`); `CURRENT_SCHEMA_VERSION` (`index/local-index.ts:307`); `index/migrations/runner.test.ts`; the new
`runner-v96.test.ts`; `CLAUDE.md` and `GEMINI.md` ("schema V9x" appears twice each); `docs/schema-reference.md`
(a new entry above the V94 one at `:1339`); `docs/architecture.md` (the table pointer; the stale "Latest applied
migration: V85" paragraph at `:4170` is NOT rewritten, as IC1 decided); `.claude/commands/nimbus-db-migrations.md`
(its "Newest" line); `.claude/commands/nimbus-file-map.md`; run `bun run audit:status-drift`, which compares the
prose with `CURRENT_SCHEMA_VERSION`. Content (SQL, one statement per array element, all idempotent):
1. `INSERT OR IGNORE INTO graph_relation_type (name, directed) VALUES ('deployed', 1), ('built_by', 1)`.
2. `CREATE INDEX IF NOT EXISTS idx_deployment_items_sha ON deployment_items (sha)`
   (`idx_deployment_items_provider_sha` leads with `provider`, `index/deployment-v28-sql.ts:18-19`, so a bare-sha
   probe cannot use it).
3. `INSERT OR IGNORE INTO _meta (key, value) VALUES ('regraph_pending_ic2', '1')` (`_meta` exists since V18,
   `index/audit-chain-v18-sql.ts:5`). Written by raw SQL, read by raw SQL: `ALLOWED_META_KEYS`
   (`index/local-index.ts:311`) guards only `getMeta`/`setMeta`, which are IPC-reachable, so the marker is
   deliberately not whitelisted.

**One-shot re-graph (`graph/regraph-once.ts`).** `runPendingRegraph(db, { configDir, logger })`: read the marker
(return if absent); build the resolver from the STRICT loader (`loadNimbusServiceConfigsFromConfigDir`); if that
throws, log and return WITHOUT clearing the marker (a regraph with a missing resolver would clear and not re-emit
resolver-bound edges, `graph/regraph.ts:16-28`; fail toward preserving edges, as `ipc/index-regraph-rpc.ts:36-46`
does); otherwise run `regraphAllItems(db, { types: [t], resolveServiceId, logger })` once per type in the order
`deployment`, `incident`, `error_issue`, `data_quality_test`, awaiting `Bun.sleep(0)` between types so the event loop
breathes; delete the marker only when no slice threw (per-row failures are counted in `skipped` and logged, as
`regraph.ts:152-163` does). `regraphAllItems` gains `types?: readonly string[]` (only those slices, in
`REGRAPH_TYPE_ORDER` order, no remainder slice). Wiring: `platform/assemble.ts`, after `resolveServiceId` is built
(`:3923`) and the DB is open (`:533`), fire-and-forget with a caught rejection and a sidecar stop. A fresh install
runs it on an empty index and clears the marker. `index.regraph` (the owner's command) is unchanged.

### G. History and `born` registrations summary

`ITEM_HISTORY_SPECS`: `jira:alert` added (A); `pagerduty:incident` gains `sourceAt` rules (B). No key list changes
for PD. IC3 must treat an item's `__created` row as an observation time (IC1 Risks, unchanged).

## File map

New:
- `packages/gateway/src/connectors/jsm-alert-mapping.ts` (+ `.test.ts`) - `mapJsmAlertToItem`, list/get reply parsers
- `packages/gateway/src/connectors/jsm-alerts.ts` (+ `.test.ts`) - `runJsmAlerts`, constants, cursor fields
- `packages/gateway/src/index/<name>-v96-sql.ts` and `packages/gateway/src/index/migrations/runner-v96.test.ts`
- `packages/gateway/src/metrics/data-model-glob.ts` (+ `.test.ts`)
- `packages/gateway/src/graph/deployment-edges.ts` (+ `.test.ts`)
- `packages/gateway/src/graph/regraph-once.ts` (+ `.test.ts`)
- `packages/gateway/src/graph/graph-populator-triggers.test.ts`
- `packages/gateway/src/deployment/graph-annotated.ts` (+ `.test.ts`)

Modified: `connectors/jsm-oncall.ts` (exports only), `connectors/jira-sync.ts`, `connectors/pagerduty-sync.ts`,
`connectors/pagerduty-attribution.ts`, `connectors/pagerduty-sync.test.ts` (`nimbus-pd1:` strings at `:374-776`),
`index/item-history-keys.ts` (+ test), `config/service-config-toml.ts` (+ tests `service-config-toml.coverage.test.ts`,
`service-configs.test.ts`, `test/unit/config/ci-service-toml.test.ts`), `config/nimbus-toml.ts`,
`metrics/dora-config.ts` (+ `test/unit/metrics/dora-config.test.ts`), `metrics/service-identity.ts` (+ test),
`metrics/dora.ts` (+ tests `dora.test.ts`, `dora.coverage.test.ts`, `test/unit/metrics/dora.test.ts`), `metrics/stats.ts`
(gap forwarding), `graph/graph-populator.ts`, `graph/regraph.ts`, `graph/relationship-graph.ts` (comment only if
needed), `deployment/annotate.ts` (options type), `ipc/deployment-rpc.ts`, `ipc/http-write-routes.ts`,
`ipc/http-server.ts`, `platform/assemble.ts`, `index/migrations/runner.ts`, `index/local-index.ts`,
`index/negation-predicates.ts` (+ test), `automation/watcher-condition-kinds.ts`, `agents/_lib/oncall-queries.ts`,
`agents/_lib/oncall-types.ts`, `agents/_lib/render.ts`, `agents/_lib/brief-contract.coverage.test.ts`,
`agents/changelog-queries.ts`, `agents/_lib/changelog-event-time.ts`, `agents/changelog.ts` (literal),
`demo/corpus/acme.ts`, `packages/gateway/openapi/v1.yaml`, `security-invariants.test.ts`,
`test/e2e/scenarios/incident-correlation-indexed.e2e.test.ts` (replaced), every test/fixture file that builds a
`ServiceConfig` (`agents/{changelog,oncall,why}.test.ts`, `config/nimbus-toml-{pagerduty,service-configs}.test.ts`,
`graph/{graph-populator-incidents,regraph}.test.ts`, `ipc/{index-regraph-rpc,metrics-rpc,metrics-rpc.params}.test.ts`,
`metrics/{dora.coverage,service-identity,stats}.test.ts`, `preflight/preflight.test.ts`, `test/fixtures/{dora,
preflight}/payment-service/seed.ts`, `test/integration/{changelog-queries,changelog-queries.coverage,config/
layer-read-error,metrics/dora-deployment-source}.test.ts`, `test/unit/{metrics/dora,preflight/preflight}.test.ts`),
and the docs listed in Task 14.

## Tasks (test first; red-prove every guard by reverting the production line and watching the test fail)

### Task 0 - Preconditions

1. Wait for IC1 (#1981) to merge, then create the worktree from current `main` at an ABSOLUTE path:
   `git -C C:\gitrep\Nimbus worktree add C:\gitrep\Nimbus\.claude\worktrees\p10-ic2 -b dev/asaf/p10-ic2 main`
   (never nested; verify `git rev-parse --abbrev-ref HEAD` before every commit). If IC1 is not merged yet, branch from
   `origin/dev/asaf/p10-ic1` and rebase onto `main` when it lands. The spec and this plan are STRIPPED from the branch
   before the PR (plans never land on main).
2. `bun install`; on Windows `pwsh -NoProfile -File ./scripts/build-sandbox-helper-win32.ps1`. Editor diagnostics in a
   fresh worktree are stale: trust `bun run typecheck`.
3. Re-read `CURRENT_SCHEMA_VERSION` (`index/local-index.ts:307`) and the latest `simpleStep` in `runner.ts`; pick the
   next free number (this plan says V96) and rename every occurrence before writing code. Re-run
   `git grep -n "'deployed'\|'built_by'" -- packages` (expected: nothing) and `git grep -n "regraph_pending" -- packages`
   (nothing). Confirm `packages/gateway/package.json` still pins `@nimbus-dev/connectors` at a version with
   `jira_ops_alert_list` (>= 0.13.0); no bump.

### Task 1 - Migration `V96`

Files: `index/<name>-v96-sql.ts` (new), `index/migrations/runner.ts`, `index/local-index.ts`,
`index/migrations/runner.test.ts`, `index/migrations/runner-v96.test.ts` (new).
1. `runner-v96.test.ts` first (model: `runner-v94.test.ts`): a database migrated to `CURRENT_SCHEMA_VERSION - 1` then to
   current has both relation types (`SELECT name FROM graph_relation_type`), `idx_deployment_items_sha` (`PRAGMA
   index_list(deployment_items)`), and `_meta` holds `regraph_pending_ic2 = '1'`; `user_version` equals
   `CURRENT_SCHEMA_VERSION`, which equals `maxRegisteredIndexedSchemaVersion()` and is `>= 96`; re-running the step is
   idempotent and does NOT re-insert a deleted marker's value over an existing row (`INSERT OR IGNORE`); an
   `upsertGraphRelation(..., "deployed", ...)` succeeds only after the step (the FK, red-proved by running it on a
   V95 database); `EXPLAIN QUERY PLAN SELECT id FROM deployment_items WHERE sha IN (?, ?)` names
   `idx_deployment_items_sha`. Run: RED.
2. The SQL module exports one statement per element, as V94's. 3. Register: import and `simpleStep(95, 96, "incident
   alert sources: deploy edge types, deployment sha index, one-shot regraph marker (Phase 10 IC2)", ...)`; bump
   `CURRENT_SCHEMA_VERSION`; fix `runner.test.ts`'s count. Run: GREEN.

### Task 2 - PagerDuty resolution time

Files: `pagerduty-sync.ts`, `pagerduty-attribution.ts`, `item-history-keys.ts`, `demo/corpus/acme.ts`,
`pagerduty-sync.test.ts`, `item-history-keys.test.ts`.
1. Tests first. `pagerduty-sync.test.ts`: a resolved incident with `last_status_change_at` writes `resolved_at_ms` and
   `status_changed_at_ms` equal to its parsed value; an acknowledged one writes only `status_changed_at_ms`; a
   resolved one WITHOUT the field writes neither (the keys are absent, not null); an unparseable string writes
   neither; `meta_v` is 2; a stored `nimbus-pd1:` cursor now decodes to null (cold start over the floor, the request
   carries the cold `since`), a `nimbus-pd2:` cursor round-trips, and the existing `nimbus-pd1:` literals in the file
   (`:374-776`) become `nimbus-pd2:`. `item-history-keys.test.ts`: the `pagerduty:incident` WRITERS fixture
   (`:218-243` loop) now builds a RESOLVED incident with `last_status_change_at`, and the existing sourceAt-key check
   (`:236-241`) demands `resolved_at_ms` and `status_changed_at_ms` exist; `sourceAtFor` returns the resolved time for
   `status -> resolved` and the change time for `acknowledged`. Run: RED.
2. Implement: the metadata keys, the version, the cursor prefix, the spec's `sourceAt` rules, the demo corpus key.
   Run: GREEN. Red-prove: revert the prefix bump and watch the cold-start test fail.
3. Consumers (each its own red/green pair, using seeded `item` rows built from the REAL mapper output):
   - `dora.test.ts`/`dora.coverage.test.ts`: MTTR uses `resolved_at_ms` (an incident resolved long after its last
     touch measures the real duration; `modified_at` far from `resolved_at_ms` proves the column is not read); a
     resolved row without the key is excluded and the result's gap is `incomplete_resolution_data`; malformed
     metadata JSON does not raise (the `json_valid` guard); the window bounds apply to `resolved_at_ms`.
   - `oncall-queries.test.ts`: `resolvedAtMs` is the key; resolved-without-key gives `closed: true`,
     `resolvedAtMs: null`; an open incident gives `closed: false`. `oncall-render.test.ts`: the three renderings.
   - `changelog-queries` tests: a resolved row with the key is listed at that time with `timeSource: "event"`; a
     legacy resolved row is listed at `modified_at` with `"index"`; a window excluding the event time excludes the row
     even when `modified_at` falls inside it.
   - `openapi/v1.yaml` enums gain `incomplete_resolution_data`; `bun run audit:openapi-drift`.

### Task 3 - JSM alert mapper and history registration

Files: `connectors/jsm-alert-mapping.ts` (new), `item-history-keys.ts`, tests.
1. `jsm-alert-mapping.test.ts` first, from documented-shape fixtures (an open P1 with tags and a team responder, an
   acknowledged one with `report.ackTime`, a closed one with `report.closeTime`, one with numeric epoch
   `createdAt`, one with no id, one with garbage `priority`/`tags`): every metadata row of the table in design A;
   absent timestamps stay absent; `closed_at_ms` only when closed AND `closeTime` finite; tags flattened and capped
   (20 x 100); a control-character message is flattened; `title` capped at 512; `bodyPreview` is the status; no
   `description`, `owner`, `responders[].id` or `details` ever reaches the metadata (assert on `JSON.stringify`);
   the list parser accepts `values`, `alerts` and a bare array, rejects a non-list, counts skipped entries; the get
   parser accepts root, `data` and `result`.
2. `item-history-keys.test.ts`: `ITEM_HISTORY_SPECS` gains `"jira:alert"` and the fixtures table gains a `WRITERS`
   entry built with `mapJsmAlertToItem` (its first test, `:219-224`, fails until both exist). Run: RED. Implement
   the mapper and the spec (design A, G). Run: GREEN.

### Task 4 - The alert pass in the `jira` sync

Files: `connectors/jsm-oncall.ts` (export `jsmGet`, `resolveCloudId`, `acquireWithin`, `SAFE_ID`, `Remaining` type, no
other change), `connectors/jsm-alerts.ts` (new), `connectors/jira-sync.ts`, `security-invariants.test.ts`.
1. `jsm-alerts.test.ts` and `jira-sync.alerts.test.ts` first (model: `jira-sync.oncall.test.ts:1-80`: `ctxFor`,
   a `stub()` that answers by URL, `describeWithFetchRestore`):
   - first sync: items upserted for open and recently closed alerts; cursor holds `alAt`, `alOpen`, shares `cid`
     with the shift pass; a second sync inside 5 minutes makes NO alert request (`urls` filter on `/alerts`); after
     the interval it runs again; `alAt` is an attempt (a failing provider is retried once per interval);
   - gating: no stored cloud id and a non-`atlassian.net` site -> no request, no throw; `atlassian.net` with no
     stored id -> `tenant_info` is fetched once and cached in the cursor; a malformed stored id is ignored
     (`isAtlassianCloudId`);
   - 401/403/404 on the first list -> `alUntil` six hours out and no request during it; a corrupt `alUntil` beyond
     six hours is ignored;
   - the 7-day window: a closed alert whose `updatedAt` is 8 days old is not written and stops the closed pass
     (page 2 is not requested); an open alert older than 7 days is written;
   - pagination: 5 pages per status at most; every request URL starts with `https://api.atlassian.com/jsm/ops/api/`
     + the cloud id + `/v1/alerts`; a `links.next` in a reply is never followed;
   - the 400 fallback: one unfiltered request, then normal handling, logged;
   - stale-open reconcile: an id in the previous `alOpen` missing from the next complete listing is fetched via
     `/alerts/{id}` (cap 20) and updated to closed; a failed get leaves the row; an incomplete open listing does NOT
     trigger reconciliation and keeps the union in `alOpen`;
   - the pass never throws into the sync (a `fetch` that rejects still returns the issue sync's result with
     `alAt` set); a 60 s budget expiry (injected clock) ends it partial;
   - both passes in one run: the shift pass's cursor fields and the alert pass's survive together (the cursor is
     rebuilt from both, `jira-sync.ts:880-886`).
   Run: RED.
2. Implement `runJsmAlerts(ctx, creds, prev, nowMs, clock)` and `jiraAlertsIfDue`; wire it after `jiraOncallIfDue`
   (`jira-sync.ts:879`); add `decodeAlertFields`. Run: GREEN.
3. `security-invariants.test.ts:878-890` is extended, not loosened: `jsm-oncall.ts` still has exactly one `https://`
   and one `fetch(` (the exports add neither); a new test over `jsm-alerts.ts` and `jsm-alert-mapping.ts` asserts
   ZERO `fetch(`, ZERO `https://` literals and no `redirect:` of their own, and that `jsm-alerts.ts` imports
   `jsmGet` and `resolveCloudId` from `./jsm-oncall.ts`. Red-prove: add a stray `fetch(` and watch it fail.

### Task 5 - Binding keys: parser and `ServiceConfig`

Files: `config/service-config-toml.ts`, `metrics/dora-config.ts`, `config/nimbus-toml.ts`, tests.
1. Tests first: a table with the four keys parses to the four fields in BOTH `[ci.service.x]` and `[metrics.dora.x]`;
   defaults are `[]`; each validation failure (empty entry, a Sentry slug with a space or capital, a glob that is
   only `*`, a glob with whitespace, `depends_on` naming itself, more than 50 entries) throws with the
   `[block.id].key` prefix; an unknown key still throws (`:164-166`); a quoted value with a comma and the TOML
   array forms `parseStringArray` accepts; `depends_on` naming a service that is not configured prints exactly one
   stderr warning from the merged loader and does not throw; the merged loader keeps the fields when `[ci.service]`
   overrides `[metrics.dora]`. Run: RED.
2. Implement; add `NO_INCIDENT_BINDINGS` and spread it at `agents/changelog.ts:280`; fix every test literal until
   `bun run typecheck` and `bun run typecheck:tests` are clean (the baseline must not grow).

### Task 6 - The resolver rules

Files: `metrics/service-identity.ts`, `metrics/data-model-glob.ts` (new), tests.
1. `data-model-glob.test.ts`: `*` matches any run including dots and the empty run; literal segments in order;
   anchored at both ends; `a.*` vs `a` (no match), `*.orders` vs `x.y.orders`; adversarial inputs (10,000 `*`,
   a long key) finish in linear time (no regexp is built). `service-identity.test.ts`: a `jira:alert` with a tag of
   a different case binds; a `jira:alert` whose only tag is unclaimed resolves `unknown`; a `sentry:error_issue`
   binds by `project`; a Monte Carlo and a Bigeye item bind through `monitoredDataModelKeys` against a glob, a
   non-matching key does not; an item of any other `(service, type)` carrying a `tags` or `project` key is NOT
   bound (the (service, type) guard: Prefect deployments carry `tags`); existing resolutions are byte-identical
   (the old suite passes unmodified); two configs claiming one tag/slug resolve to the first and warn once; a glob
   overlap warns once per key. Run: RED. Implement (design C). GREEN.

### Task 7 - Graph: anchor, split, widen, alert handler

Files: `graph/graph-populator.ts` (+ `graph-populator-triggers.test.ts`, existing `graph-populator-incidents.test.ts`
and `graph-populator-error-issue.test.ts` updated), `automation/watcher-condition-kinds.ts`.
1. Tests first, real rows through `upsertIndexedItem` (so the populator runs as in production) with a resolver built
   from a `ServiceConfig` map:
   - anchor per source: a PD incident anchors on `opened_at_ms` not `updated_at`; a Sentry issue on `firstSeen` (a
     later `lastSeen` re-sync does not move `occurredAt`); a Monte Carlo test on `firstSeenAt`; a Bigeye test keeps
     its first `occurredAt` across re-syncs (stable once set) and uses `modified_at` the first time; a `jira:alert` on
     `opened_at_ms`; malformed or absent metadata falls to the next rule and never throws (also through
     `regraphAllItems`, whose `parseMetadata` returns `{}`); a pin test: for the four tracked trigger types the
     graph anchor key equals `specFor(...).born.key`;
   - edges: for each of the four kinds, a deployment of the same service inside `[open - 2 h, open]` produces
     `deployment --correlates_with--> trigger`; outside the window it does not; the trigger synced BEFORE the
     deployment and AFTER it both produce the edge (order independence); an unbound trigger (`unknown`) produces no
     edge and keeps `affectedService: null`; a gate-`excluded` deployment (preview environment) binds nothing;
     re-syncing a trigger with a different service retires the old incoming edge;
   - the destruction regression (deviation 4): a Monte Carlo test keeps its `monitors` edges and a Sentry issue keeps
     its `belongs_to` service edge and its `assigned` edge after `correlateTrigger` ran; the error issue's
     `project` metadata survives alongside `occurredAt`/`affectedService`; red-prove by calling the old
     `syncTimelineEventGraph` shape and watching these fail;
   - `GRAPH_SYNC_BY_TYPE.alert` exists; `Object.hasOwn` still protects `constructor`; person edges remain
     incident-only (an alert gets none);
   - `timelineCounterparts` returns all four kinds for a deployment, nearest first, with a deterministic `id`
     tie-break.
   Run: RED. Implement design D (named steps in order; keep every function under cognitive complexity 15 by
   splitting by phase, not by hiding a check).
2. `watcher-condition-kinds.ts`: the stale note is rewritten; `alert_fired` gains the `extraSql`
   `AND json_valid(metadata) AND json_extract(metadata, '$.status') != 'closed'` (a test: closing an alert does not
   fire it; a new open `jira:alert` does). `affectedServiceEntityType` stays `null` pending review (Risks).

### Task 8 - Deployment edges and reverse relinking

Files: `graph/deployment-edges.ts` (new), `graph/graph-populator.ts` (deployment arm, `syncPrGraph`,
`syncGitCommitGraph`, new `syncCiRunGraph`), `graph/relationship-graph.ts` (none expected), tests.
1. Tests first (real `annotateDeployment`-shaped rows via Task 9's helper, real `syncPrGraph` rows with
   `merge_commit_sha`, a real `ci_run` row from a mapper fixture with `head_sha`): forward link emits `deployed` to
   the one commit entity whose sha matches and `built_by` to the CI run whose suffix and `head_sha` match; a 7-char
   deployed sha matching one commit links, matching two links none; no `run_id` -> `deployed` only; Jenkins/Bitbucket/
   `other` -> `deployed` only; the SAME edges appear when the order is reversed (deployment first, then PR, then CI
   run) - the reverse hooks; re-syncing the commit (`syncGitCommitGraph` clears its edges) restores `deployed`;
   re-syncing the deployment retires a `deployed` edge whose sha changed; a wrong `head_sha` yields no `built_by`;
   a Vercel deployment (`commit_sha`, not in `deployment_items`) links forward only; the reverse query uses
   `idx_deployment_items_sha` (`EXPLAIN QUERY PLAN` test). Run: RED.
2. Implement design E. The `ci_run` handler is registered in `GRAPH_SYNC_BY_TYPE`; `regraph.ts:96-103`'s comment is
   corrected. Measure the added per-`ci_run` cost on a seeded index (30 runs x 200 repos) and record it for the PR.

### Task 9 - Graph the CI-annotated deployment at annotation time

Files: `deployment/graph-annotated.ts` (new), `deployment/annotate.ts` (`AnnotateOptions`), `ipc/deployment-rpc.ts`,
`ipc/http-write-routes.ts` (`WriteRouteContext`, `runDeploymentRoute` at `:808-823`), `ipc/http-server.ts`
(`resolveWriteRouteDeps` at `:1361-1387`).
1. Tests first: `graphAnnotatedDeployment(db, itemId, resolveServiceId?)` reads the item row, calls
   `syncGraphFromIndexedItem`, and a `deployment` entity with `affectedService` appears (resolver bound through the
   metadata's `nimbus_service_id`); an `excluded` environment binds nothing; a populator throw is swallowed by the
   route seam and the annotation still answers 200 with the same body (the HTTP response schema is unchanged); a
   re-annotation is idempotent; `POST /v1/deployments` end to end (the route test pattern in
   `test/integration/http/deployments-post-route.test.ts`) leaves a graph entity and, with a seeded incident, the
   `correlates_with` edge; with no `configDir` the entity exists with a null service (regraph repairs it). Run: RED.
2. Implement. The seam is optional everywhere (`demo/seed.ts` and tests that call `annotateDeployment` directly are
   unchanged); the HTTP server builds it from `opts.configDir` lazily per call (`loadServiceConfigs`,
   `http-server.ts:373-377`), degrading to no resolver on a malformed config. `deployment-rpc.ts` is the only caller of
   the seam, after the annotate transaction commits. No change to the OpenAPI request/response.

### Task 10 - The one-shot re-graph

Files: `graph/regraph.ts` (`types` option), `graph/regraph-once.ts` (new), `platform/assemble.ts`, tests.
1. Tests first: `regraphAllItems(db, { types: ["deployment"] })` visits only that slice and no remainder slice;
   `runPendingRegraph` with the marker present re-grafts the four types (a seeded annotated deployment with no entity
   gains one, a seeded incident gains the corrected `occurredAt`) and deletes the marker; with no marker it does
   nothing (spy); with a malformed `nimbus.toml` it does nothing and KEEPS the marker; a throwing slice keeps the
   marker; a per-row failure is counted and the marker is deleted; it yields between types; running it twice is
   idempotent. An `assemble` wiring test (or the existing assemble sidecar pattern) proves it is started once and
   stopped on shutdown. Run: RED. Implement (design F).

### Task 11 - Readers of `correlates_with`

Files: `index/negation-predicates.ts` (+ test), docs strings.
1. `buildNoDownstreamIncidentSql` (`:213-230`): the `NOT EXISTS` joins `graph_entity t ON t.id = r.to_id` and
   restricts `t.type IN ('incident','alert')`. Test first with a deployment correlated only to a Sentry issue (still
   listed as "no downstream incident") and one correlated to a PD incident or a JSM alert (not listed). Also grep the
   other readers found above (`premortem.ts:436`, `why.ts:834`, `catchup`/`negotiate` entity-type joins): each already
   pins `ie.type = 'incident'`; add a one-line test per reader that an alert/error-issue neighbour does not change its
   output.

### Task 12 - Replace the e2e test

File: `packages/gateway/test/e2e/scenarios/incident-correlation-indexed.e2e.test.ts` (rewritten in place).
The old test hand-seeds a `pagerduty:alert` item (no connector writes that: `watcher-condition-kinds.ts:56-58` says no
connector indexes `alert` items), an `aws:alert`, and four hand-written `correlates_with` edges
(`upsertGraphRelation` calls), so it proves nothing about the populators. The new test, over a real `LocalIndex`
(`ensureSchema`), a `ServiceConfig` map for `payment-service` (repo `github:acme/payment-service`, PagerDuty `PSVC1`,
`jsm_alert_tags ["payments"]`, `sentry_projects ["payments-api"]`, `data_models ["analytics.payments.*"]`) and a
second service `checkout` with `depends_on ["payment-service"]`, and the resolver built from it:
1. Drives the REAL writers with fake replies, no edge written by the test: `annotateDeployment` through
   `graphAnnotatedDeployment` (provider `github-actions`, `run_id`, sha S, env `prod`); a merged GitHub PR with
   `merge_commit_sha = S` through the real PR writer used by `item-history-keys.test.ts`'s `github:pr` fixture
   (`processEvent`/`extractPrMetadataForIndex`); a `github_actions` run with `head_sha = S` through
   `createGithubActionsSyncable` with a stubbed fetch (pattern: its sync tests); a PagerDuty P1 through
   `syncPagerdutyIncidentItems`; a JSM alert through `createJiraSyncable` (stub as `jira-sync.oncall.test.ts`); a
   Sentry issue through `mapSentryIssueToItem` + `ctx.upsertItem`; a Monte Carlo and a Bigeye incident through their
   mappers; a Slack message through its mapper naming the service. Items use `syncTestContext(db, vault, service,
   "full", resolver)` so the populator runs on each write.
2. Asserts on the graph: each of the five triggers has an incoming `correlates_with` from the deployment entity; the
   deployment has `deployed` to a commit entity that the PR reaches with `merged_as`, and `built_by` to the CI run;
   `traverseGraph` from the PD incident (depth 4) reaches the PR, the CI run and the deployment; an alert tagged for
   no service and a deployment in `staging` correlate with nothing; the three-way ordering (all items written in
   reverse order) yields the identical edge set; after `runPendingRegraph` on a copy of the database with the
   pre-IC2 shape (entities deleted, marker set) the same edges exist.
3. Keeps the old test's search assertion over real data: `idx.searchRanked({ name: "payment-service incident" })`
   returns rows from `pagerduty`, `jira`, `sentry` and `slack` that the real writers produced (drop the fictional
   AWS and Jenkins items).
The `why`, `impact`, `catchup`, `negotiate`, `premortem` and `standup` suites are run once with the new edge types
present (they assert on entity types and ids, so none is expected to change; any that does is a finding to fix, not
a baseline).

### Task 13 - Coverage and cleanup

- The floor is 85 % line and 80 % branch PER NEW FILE (`audit:coverage-floor`, Linux-authoritative; the
  `test:coverage:*` scripts are not the gate). New files: `jsm-alert-mapping.ts`, `jsm-alerts.ts`, `data-model-glob.ts`,
  `deployment-edges.ts`, `regraph-once.ts`, `graph-annotated.ts`. For each, before pushing, list every `?:`, `??`,
  `&&`/`||` and early return and name the test that takes each arm. Do not write a `??` default that cannot be reached
  (a typed record field already known to be defined) and do not write `err instanceof Error ? err.message :
  String(err)` (an unreachable branch under test): throw fixed messages or use the existing `fallbackMessage`
  (`config/layered-config.ts`). The mapper's many optional fields each need a fixture row with and without them.
- Changed large files (`graph-populator.ts`, `service-identity.ts`, `jira-sync.ts`, `dora.ts`) keep their per-file
  numbers: run `bun run audit:coverage-floor` against the Docker lcov (`audit:coverage-floor:build-lcov`) once.
- `bun run audit:lane-census -- --check` (the index lane contract): the new reads (`$.resolved_at_ms`, `$.tags`,
  `$.project`, `$.monitoredDataModelKeys`, `$.head_sha`) must match a writer or carry a
  `// lane-census: scope=...` annotation; `connectors/jsm-alert-mapping.ts` is a writer literal (it carries
  `service:` and `type:`), `agents/` and `demo/` are excluded from the writer corpus on purpose
  (`lane-census/writer-emissions.ts`), so the PD `resolved_at_ms` writer must be the connector literal, not the demo.
- Biome (`preflight:fast`), no `any`, no bare `.sort()` (comparators), every new function under cognitive complexity
  15, `dbRun`/`dbExec` only for writes (I14), identifiers never interpolated into SQL (I9; the `IN (...)` lists are
  `?` placeholders), `redirect: "manual"` untouched, no new `fetch(`.
- `bun run audit:boundaries` (`graph/` -> `index/item-history-keys.ts` is allowed; `graph/` must not import `metrics/`
  or `deployment/`; `deployment/graph-annotated.ts` imports `graph/`, which is allowed), `bun run audit:cross-platform`
  (no path separators are built here; the tests pass `nowMs` and a stub fetch), `bun run audit:openapi-drift`.
- If Docker is available run `bun run verify:docker --changed`; otherwise say so in the PR.

### Task 14 - Docs (the five core docs, every PR) and CHANGELOG

- `CLAUDE.md` and `GEMINI.md` (identical edits): the status paragraph gains one "Phase 10 IC2" sentence (JSM
  Operations alerts as `jira:alert` from the existing cloud-id gating every 5 minutes, open plus 7 days closed;
  PagerDuty `resolved_at_ms` and the consumers that read it; the four binding keys; the graph correlating alert,
  error-issue and data-quality triggers anchored on their open time; `deployed`/`built_by` edges; CI-annotated
  deployments graphed at annotation time; the one-shot re-graph; schema V96; no new invariant, rule, HITL type or
  egress class; stated bounds in short); both "schema V94" mentions become the new number (`audit:status-drift`
  compares them with `CURRENT_SCHEMA_VERSION`, run it and fix every surface it names). The static-rule ceiling
  "D10-D46" and the invariant ceiling do not change.
- `docs/roadmap.md`: the IC2 row of the incident-engine rows becomes `[x]` with a dated sub-note and the numbered
  deviations in short; the `Carried`/Phase 10 "alert sources" wording gets the JSM alert item; the `alert_fired`
  watcher note is updated. IC3-IC10 stay `[ ]`.
- `docs/architecture.md`: a `Table`-level pointer for the V96 changes; a short "Alert sources and bindings" subsection
  (the alert pass and its cursor fields, the binding keys and the resolver's per-source rules, the anchor definition,
  the `correlateTrigger` split, the deployment edges and the reverse relinking, the one-shot re-graph); the
  `:1544` paragraph (`filter.affectedService`... "for `incident` and `deployment` graph entities") gains the new
  entity types; the `:938` sentence "creates no `deployment` graph entity" is corrected; the `:639` on-call reader
  paragraph is untouched; the D-rules mention is unchanged.
- `docs/README.md`: the Phase 10 status paragraph gains the IC2 sentence.
- `docs/cli-reference.md`: the `[ci.service.<id>]`/`[metrics.dora.<id>]` key tables (grep `pagerduty_services`; add the
  four keys, their validation and "`repos` is still required"), `nimbus metrics dora` gap list (`incomplete_resolution_data`),
  `nimbus index regraph` (the one-shot after the upgrade), and `nimbus changelog` (resolved incidents' time basis).
- `docs/CHANGELOG.md`: a dated entry in the existing style at the top of "Post-Phase-6 deliveries": what the owner
  gets, schema V96, no new invariant or rule, the stated bounds, and the 14 deviations in short.
- `docs/schema-reference.md`: the V96 statements with a dated header comment (model: the V94 entry at `:1339`).
- `.claude/commands/nimbus-cicd-data-layer.md` (the `[metrics.dora.<id>]` + `[ci.service.<id>]` schema, the resolver
  and `ServiceConfig`), `.claude/commands/nimbus-db-migrations.md` ("Newest"), `.claude/commands/nimbus-file-map.md`
  (rows for the new files; gated by `audit:doc-refs`, which resolves every cited path).

### Task 15 - Final verification (run sequentially, never beside each other; a failing step hides later ones, so run each)

1. `bun run preflight:fast` (types, Biome, static rules incl. `audit:invariants`, `audit:status-drift`,
   `audit:doc-refs`, `audit:lane-census`, `audit:openapi-drift`).
2. `bun test packages/gateway/src`
3. `bun test packages/gateway/test packages/cli` (a `src` run does not load `test/`; the e2e replacement lives there).
4. `bun test scripts`
5. `bun run typecheck` and `bun run typecheck:tests` (the baseline must not grow).
6. `bun test scripts/structure-audit/check-nimbus-invariants.test.ts` and `bun run audit:invariants` once more after
   any later edit (expected: no rule added, the existing ones green).
7. `bun run preflight` if time allows (full CI parity); `bun run verify:docker --changed` if Docker is available (its
   one known red exec-e2e is the harness).
8. Known LOCAL baselines (not this branch): six migration e2e tests fail when run alongside `packages/cli/src` in one
   process; five `install.ps1`/gpg tests fail on this machine; one trust-store test is flaky on a timeout (re-run it
   alone); on Windows the sandbox helper must be built first. Do not run the sandbox tests beside a background
   `preflight` (shared ACL ledger). Anything else red is this branch.
9. Before opening the PR re-check `git rev-parse --abbrev-ref HEAD`, then strip `docs/superpowers/**` from the branch.

## Spec coverage (spec § 5.2 and the IC2 row of § 4, mapped to a task STEP)

| Requirement | Where implemented |
| --- | --- |
| `jira` syncable gains an alert pass, only with a cloud id as MB3's shift pass | Task 4 step 2 (`jiraAlertsIfDue` after `jiraOncallIfDue`; MB3's `resolveCloudId`, deviation 8) |
| `jira_ops_alert_list` for open alerts plus those closed in the last 7 days | Task 4 step 1 (window, pagination, fallback tests); design A (requests; deviation 9) |
| Items `jira:alert` with `status`, `priority` (P1-P5), `opened_at_ms`, `closed_at_ms`, `tags`, `entity`, `source`, `owner_team`, `acknowledged` | Task 3 step 1/2 (mapper and the metadata table; deviations 10, 14) |
| External id is the alert id | Task 3 (`externalId`); id format `jira:<alertId>` |
| Refreshed at most every 5 minutes | Task 4 step 1 (cadence tests), step 2 (`JSM_ALERT_REFRESH_INTERVAL_MS`) |
| IC1 `item_history` allowlist must cover the new type | Task 3 step 2 (`ITEM_HISTORY_SPECS["jira:alert"]`, writer-pin fixture), design G |
| PD mapper records `resolved_at_ms` from `last_status_change_at` when resolved, with a meta-version bump so rows are rewritten | Task 2 steps 1-2 (keys, `meta_v` 2, cursor prefix `nimbus-pd2:`; deviation 6) |
| MTTR and prior-incident code stop using `modified_at` for resolution | Task 2 step 3 (`dora.ts`, `oncall-queries.ts`, plus `changelog` as the third consumer; `standup` deliberately left, design B) |
| `jsm_alert_tags`, `sentry_projects`, `data_models`, `depends_on` in `[ci.service.<id>]` and `[metrics.dora.<id>]`; unknown keys stay an error | Task 5 (parser, `ServiceConfig`, merged loader; deviation 11) |
| `buildServiceIdentityResolver` and its graph use gain matching rules for `jira:alert`, `sentry:error_issue`, `montecarlo`/`bigeye` `data_quality_test`; an unbound one correlates with nothing | Task 6 (rules), Task 7 step 1 (edges, unbound case); deviation 7 |
| `occurredAtForItem` anchors on the open time with a guarded fallback; one-shot re-graph after the migration | Task 7 step 1/design D (deviation 3), Task 10 (deviation 5) |
| Widen `syncTimelineEventGraph`'s `entityType` to the four trigger kinds | Task 7 (the split into `correlateTrigger`, deviation 4) |
| Register `alert` in `GRAPH_SYNC_BY_TYPE` | Task 7 step 1 (handler and test) |
| Error-issue and data-quality handlers also call the correlation after their existing edges | Task 7 step 1 (edge-preservation regression) |
| Counterpart queries match a trigger of any of the four kinds against deployments of the same resolved service | Task 7 (`timelineCounterparts` with `type IN`) |
| `deployment --deployed--> git_commit` | Task 1 (relation type), Task 8 (forward + reverse; the entity type is `commit`) |
| `deployment --built_by--> ci_run` via `ci_run_external_id` | Task 8 (resolved from provider, run token, `head_sha`; deviation 2) |
| New relation types in `graph_relation_type` | Task 1 step 1-3 (FK-proved) |
| Replace `incident-correlation-indexed.e2e.test.ts` with one driven by the real populators | Task 12 |
| (not in the spec, required by it) annotated deployments reach the graph | Task 9 (deviation 1) |
| IC2 updates the five core docs and CHANGELOG | Task 14 |

## Risks / open questions

- **Owner / reviewer decisions to look at:** (1) the new `DoraGap` value `incomplete_resolution_data` (touches
  `openapi/v1.yaml` and the CLI); the alternative is silent exclusion or a labelled `modified_at` fallback; (2) the
  `changelog` consumer keeps a labelled legacy row where MTTR drops it; (3) `status_changed_at_ms` is an extension
  beyond the spec; (4) the negation predicate counts only `incident`/`alert` targets (deviation 12a); (5) the
  `alert_fired` watcher now matches `jira:alert` (it was dead), scoped to non-closed; whether
  `affectedServiceEntityType` should become `"alert"` (the entity now carries `affectedService`) is left for
  review because it makes `filter.affectedService` valid for that kind; (6) Task 9 changes the behaviour of
  `POST /v1/deployments` (a graph write on the CI path, failing soft); (7) adding a `ci_run` graph handler writes one
  entity per CI run item; (8) the cursor prefix bump re-walks 30 days of PagerDuty once.
- **Live reply shapes are documented, not verified.** The Operations alert list/get (`values`, `status`,
  `createdAt`, `report.closeTime`, `responders[].type`) and the `query=status:open` syntax are from the documented
  API and the connector's tool descriptions; the 400 fallback and the tolerant parsers exist because of this. A
  site where the shape differs yields zero or partial items and a log line, never a throw.
- **PagerDuty `since` semantics (UNVERIFIED here).** The list call filters on `since` with `sort_by=updated_at`
  (`pagerduty-sync.ts:334-335`). If PagerDuty's `since` filters on creation time, an incident created before the
  cursor and resolved later is not re-listed, so its row would stay `triggered` and never gain `resolved_at_ms`. This
  predates IC2 (the `dora.ts:455` docblock already worries about stale `triggered` rows). The cold start after the
  prefix bump covers only incidents created in the last 30 days. Verify with a live account before IC3 relies on
  resolution times; the cheap fix, if confirmed, is a periodic re-list of open incidents.
- **Alert retention.** Closed alerts older than 7 days stay in the index (they are only not fetched). Volume is small
  and bounded by the account; pruning would extend `REPLACE_ITEM_SET_TYPES` (`index/item-set-store.ts:14-15`) and is
  not in IC2.
- **Slug and tag collisions.** Sentry project slugs are unique per organisation, tags per account; two organisations
  or teams with the same slug/tag bind together (first claimant, warned).
- **Edge semantics widen.** `correlates_with` now points at four entity types. `traverseGraph` consumers see more
  neighbours; every reader found pins `ie.type = 'incident'` or is covered in Task 11, but a future reader that does
  not will mix kinds.
- **Reverse relinking cost** (Task 8) and the **one-shot regraph duration** (Task 10) are measured once on a seeded
  index and recorded in the PR; the one-shot yields between types but each type slice is synchronous.
- **Binding edits need a restart** (the boot resolver, `assemble.ts:3923`); after editing bindings the owner runs
  `nimbus index regraph`. Documented in the CLI reference.
- **The `deployed` edge links an existing commit entity only.** A deployment whose commit is neither merged by an
  indexed PR nor in a local repo gets no `deployed` edge; IC3's lane 2 therefore keeps its SQL path through
  `deployment_items.sha` and uses the edges as the extra route, not the only one.
- **IC3 dependencies recorded:** IC3 reads `jira:alert` `status`/`priority` and the source-specific severity keys
  (PD `severity`, Sentry `level`, Monte Carlo `severity`, Bigeye `slaStatus`/`anomaly`), `resolved_at_ms` /
  `closed_at_ms`, and the anchors above; it must treat `__created` as an observation time (IC1 Risks).

## PR

Title (conventional commit, no `!`; nothing here requires a user to act):

`feat(gateway): index JSM Operations alerts, record PagerDuty resolution times and correlate alert, Sentry and data-quality triggers with deployments`

Description: the data added, the 14 deviations (short), the stated bounds, the verification output, the measured
costs (reverse relink, one-shot regraph), and the dependencies: IC3 builds the trigger and lanes on this. End with
the attribution lines from the session. No `Release-As:` trailer.

## Review log

(Round 1 pending.)
