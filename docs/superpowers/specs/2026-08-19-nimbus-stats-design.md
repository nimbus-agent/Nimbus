# `nimbus stats` — aggregation over time — design

**Date:** 2026-08-19
**Spine slot:** S1 (Local Brain) — "Answer-quality surfaces, remaining", the aggregation half of W6-B
**Status:** design approved, not yet implemented
**Roadmap row:** `docs/roadmap.md` § Phase 7 Wave 6 → "First-class aggregation-over-time queries (W6-B)"

---

## 1. What this is

`nimbus stats <metric> --service <id>` returns a **time series** — one value per bucket —
over the already-indexed graph. It is the counterpart to `nimbus metrics dora`, which
returns a single scalar over a single window.

A2 (agent personas) closed the other half of S1's last open row. This closes the
aggregation half. Negation (`--negate` / `--explain`) remains, and depends on separate
changed-file indexing work.

---

## 2. Findings that shaped this design

Verified against the tree on 2026-08-19, not taken from the roadmap. Two of them contradict
what the roadmap row assumes.

**F1 — `item` has no creation timestamp.** The V3 schema
(`index/unified-item-v3-sql.ts`) carries `modified_at` and `synced_at` only. Bucketing
"throughput by week" on `modified_at` therefore measures *last activity*, not creation or
completion: a PR merged three weeks ago but commented on yesterday lands in yesterday's
bucket. This is the same defect `negotiate` documented, where its window had to be
relabelled "active in" rather than "created in". It is the reason this design refuses to
bucket anything on `modified_at`.

**F2 — merge time exists, but only for GitHub.** `connectors/github-sync.ts`'s
`applyMergeFields` writes `metadata.merged_at` as epoch milliseconds, and only when the PR
actually merged. **No other connector writes it** — `gitlab-sync.ts` and `bitbucket-sync.ts`
contain zero occurrences. So the roadmap's headline example, "PR merge throughput by week",
is a **GitHub-only** metric. Shipping it without saying so would repeat the pattern where a
roadmap row described inputs that did not exist.

**F3 — DORA already computes four metrics, but only as scalars.** `metrics/dora.ts`'s
`deploymentFrequency`, `leadTimeForChanges`, `changeFailureRate` and `mttr` each return one
`DoraMetricValue` over one window. None buckets. So this feature is genuinely the
time-series counterpart rather than a duplicate — and the correct implementation calls those
tested calculators once per bucket instead of writing parallel aggregation SQL.

**F4 — there is an honesty type to inherit, not invent.** `DoraMetricValue` is
`{ value: number | null, unit, sample, gap }` with a named `DoraGap` union. `LOW_SAMPLE_THRESHOLD`
is 3. Reusing this shape gives per-bucket `low_sample` for free and matches how every other
S1 surface reports what it could not compute.

---

## 3. Decisions taken (recorded so they are not relitigated)

**D1 — six metrics; the two NEW counters bucket on a real event timestamp, the four wrapped
DORA metrics inherit `modified_at`.** Four DORA series plus `pr-merges` (on
`metadata.merged_at`) and `incidents-opened` (on `metadata.opened_at_ms`). Rejected
alternative: also shipping *new* `modified_at`-based "activity" series with an
`activity_not_completion` label. A label mitigates a misleading headline number; it does not
remove it, and F1 is exactly the trap that costs credibility.

**Stated precisely, because an earlier draft of this line over-claimed.** Reusing the four
DORA calculators unchanged (§ 4) also reuses their time predicate, which is
`item.modified_at`. For the `ci_run` and `deployment` rows behind `deployment-frequency`
that is effectively event time — `deployment/annotate.ts` binds `started_at_ms` into
`modified_at`, and `connectors/github-actions-sync.ts` binds the run's `created_at` — but for
the `pr` rows `lead-time` reads and the `incident` rows `change-failure-rate` and `mttr`
read, it is genuine last-touch (`connectors/github-sync.ts` binds a PR's `updated_at`;
`connectors/pagerduty-sync.ts` binds an incident's) — the exact F1 timestamp this section
calls disqualifying. `mttr` additionally inherits
`selectResolvedIncidents`' `synced_at` fallback for an incident with no `opened_at_ms`. Both
are the **accepted cost** of calling four tested calculators unchanged rather than
reimplementing them with a different time predicate — a second copy of DORA's arithmetic
would be free to drift from the original, and changing `dora.ts` itself would move
`nimbus metrics dora`'s numbers too. Recorded as a named follow-up (§ 9), not as a property
this feature has. So: the claim "buckets on a real event timestamp" holds for `pr-merges` and
`incidents-opened`, and for no others.

**D2 — disjoint buckets, not rolling windows.** `--window 90d --bucket 1w` means 13
independent weeks, each computed over its own rows. The roadmap's phrase "rolling 7-day MTTR
trend" describes a *rolling* window, which is a different thing: smoother, better per-point
samples, but ~90 evaluations instead of 13 and adjacent points sharing data, so a reader can
over-trust an apparent trend. Disjoint is simpler to explain and each point is genuinely
independent. **Consequence stated plainly:** for a median metric like `mttr`, a single week
often holds one or two incidents, so `low_sample` will fire on most buckets and the series
will contain many nulls. That is the data being thin, not the tool being broken, and the gap
reason says which. Rolling is recorded as a named follow-up (§ 9), not built.

**D3 — every metric is service-scoped through config that already exists.** No new
`nimbus.toml` section. See § 5.

**D4 — no new surfaces.** No HTTP route, no Tauri allowlist entry. See § 7.

---

## 4. The metric registry

`packages/gateway/src/metrics/stats.ts` holds `STATS_METRICS`: a map from metric id to
`{ unit, evaluate(db, cfg, sinceMs, untilMs): DoraMetricValue }`.

| Metric id | Source | Event timestamp | Notes |
| --- | --- | --- | --- |
| `deployment-frequency` | existing calculator | `item.modified_at` — effectively event time for `ci_run`/`deployment` rows | wraps `deploymentFrequency` unchanged |
| `lead-time` | existing calculator | `item.modified_at` — **last touch** for the `pr` rows it reads | wraps `leadTimeForChanges` unchanged |
| `change-failure-rate` | existing calculator | `item.modified_at` — **last touch** for the `incident` rows it reads | wraps `changeFailureRate` unchanged |
| `mttr` | existing calculator | `item.modified_at`, plus DORA's `synced_at` fallback for an incident with no `opened_at_ms` | wraps `mttr` unchanged; see D2 on sparse buckets, and D1 on the inherited timestamps |
| `pr-merges` | `item` where `type = 'pr'` | `json_extract(metadata,'$.merged_at')` | **GitHub only** (F2) |
| `incidents-opened` | the incident rows DORA already reads | `metadata.opened_at_ms` | count, not duration — distinct from `mttr` |

The four DORA entries take the existing calculators' `(db, cfg, nowMs, sinceMs)` signature
with `nowMs` bound to the bucket end, so a bucket is exactly "the DORA value for that
sub-window". No DORA logic is copied or reimplemented.

**The registry must be total over the metric-id union**, so adding an id without an
evaluator is a compile error rather than a runtime miss.

**A guard on `pr-merges`' SQL:** `json_extract` raises on malformed JSON in this codebase,
and the guard is context-dependent — an `OR json_valid(...)` protects a `WHERE` clause but
not a `SELECT` list. The metadata predicate must be written accordingly and tested against a
row with unparseable metadata.

---

## 5. Scoping: no new configuration

Every metric takes `--service <id>` and resolves through the same `ServiceConfig` DORA uses,
loaded from `[metrics.dora.<id>]` / `[ci.service.<id>]`:

- `pr-merges` filters to the service's bound repos.
- `incidents-opened` filters to the service's `pagerdutyServices`.
- The four DORA metrics scope exactly as they already do.

A service with no repos or no PagerDuty mapping yields the gap DORA already defines for that
case (`no_repos`, `no_pagerduty_mapping`) rather than a new one.

---

## 6. Bucketing and output

**Buckets walk backward from the request time, with no calendar alignment.** `--window 90d
--bucket 1w` produces 13 buckets ending at "now".

The reason is **not** that calendar alignment needs a timezone — UTC would be a defensible
fixed choice needing no configuration, and an earlier draft of this spec justified the
decision that way, which was weaker than it sounded. The actual reason is that walking back
from "now" makes the newest bucket end exactly at the request time, so the most recent point
covers data right up to the moment you asked. Calendar alignment would truncate it at the
last boundary, making the freshest bucket systematically short and the newest number
systematically low — the worst place to put an artefact, since it is the number people read
first.

**Accepted cost:** the same query run on different days covers different absolute spans, so
two runs are not directly comparable point-for-point. A `--align` option that snaps to UTC
boundaries is a named follow-up (§ 9) for users who want stable, comparable charts.

The OLDEST bucket — the one at the trailing edge of the lookback, i.e. `points[0]`, never
the newest — may be partial when `window` is not a whole multiple of `bucket`; it is emitted with its true `start_ms`/`end_ms` so a reader can see it is short,
never silently padded or dropped.

### 6.1 Input validation

**Durations are parsed by `cli/src/lib/parse-since.ts`'s `parseSinceDurationToMs`**, which
accepts `w | d | h | m | s | ms`.

Pinning it matters more than it first appeared. There are **three** duration parsers in this
repo, with three different unit sets, and the narrowest one lives in the very file this work
modifies:

| Parser | Units | Note |
| --- | --- | --- |
| `cli/src/lib/parse-since.ts` `parseSinceDurationToMs` | `w d h m s ms` | **use this one** |
| `index/item-list-query.ts` `parseRelativeSinceToWindowMs` | `d h m s` | no `w` |
| `ipc/metrics-rpc.ts` `parseSinceToMs` | `d h` only, capped 1..365 | **in the file gaining `metrics.stats`** |

`--bucket 1w` — this spec's own default — fails against both of the latter two. The third is
the dangerous one: an implementer following the local pattern in `metrics-rpc.ts` would reach
for `parseSinceToMs` by proximity and the documented default would be rejected outright, with
an error that reads like a user typo rather than a wrong import.

Parsing therefore happens **CLI-side, before the IPC call**; `metrics.stats` receives resolved
millisecond integers (`window_ms`, `bucket_ms`) and never re-parses a duration string. That
also keeps `parseSinceToMs` correct for `metrics.dora`, which is unchanged. Unifying the three
parsers is out of scope here and is not silently claimed.

**`bucket > window` is a validation error, not a degenerate single bucket.** `--window 3d
--bucket 1w` asks for weekly granularity across three days, which is unsatisfiable; returning
one honestly-bounded 3-day bucket answers a question the user did not ask. Fail with a
message naming both values.

**The bucket count is clamped**, matching the clamping convention already used by
`index.queryItems` (`Math.min(1000, …)`) and `listAuditWithChain` (`Math.min(10_000, …)`).
Note the reason precisely: this is **not** a denial-of-service control — `metrics.stats` has
no remote caller, since D4 gives it no HTTP route — it is arithmetic footgun protection, so
`--window 10y --bucket 1s` fails fast with a clear message instead of attempting 315 million
evaluations. A window/bucket pair exceeding the cap is rejected, never silently truncated to
the first N buckets.

Response shape:

```json
{
  "metric": "mttr",
  "service": "checkout-web",
  "window": { "since_ms": 0, "until_ms": 0 },
  "bucket_ms": 604800000,
  "points": [
    { "start_ms": 0, "end_ms": 0, "value": null, "unit": "seconds_median", "sample": 0, "gap": "low_sample" }
  ]
}
```

Each point is a `DoraMetricValue` plus its bucket bounds. A bucket with no rows returns
`value: null` with a gap — **never `0`** — matching negotiate's "could not be computed"
discipline: zero incidents and no incident data are different facts.

**Gap type:** `StatsGap = DoraGap | "github_only_merge_data"`. The new value is set by
`pr-merges` when the resolved service binds any non-GitHub repo, so a GitLab or Bitbucket
user sees a named limitation instead of a flat zero line. DORA's own union is left frozen.

---

## 7. Surfaces

**IPC:** a new `metrics.stats` arm in the existing `ipc/metrics-rpc.ts`, mirroring
`metrics.dora`.

**CLI:** `packages/cli/src/commands/stats.ts` —
`nimbus stats <metric> --service <id> [--window 90d] [--bucket 1w] [--json]` — registered in
the CLI command map. Default window 90d, default bucket 1w. Human-readable table by default;
`--json` emits the object above verbatim for piping.

**No HTTP route and no Tauri allowlist entry.** `metrics.dora` has an HTTP route because CI
integrations consume it; nothing consumes stats yet, and `GET /v1/metrics/dora` is a
`{ kind: "public" }` unauthenticated read — a decision worth making deliberately with a real
consumer present rather than by copying. `ALLOWED_METHODS` stays at **105**. When
`nimbus-statuspage` is built it can argue for a route on its own merits.

### 7.1 Egress ledger (I29) — exempt, and why

`metrics.stats` appends **no** `egress_ledger` row, and this is recorded here so it is a
decision rather than an oversight a future audit has to re-derive.

I29's append site is the executor's chokepoint immediately before `connectors.dispatch`.
`metrics.stats` reads local SQLite and dispatches no connector action, exactly like
`metrics.dora` alongside which it sits. It performs no remote model call either, so the
`model` coverage class added for brief synthesis does not apply. Nothing leaves the machine,
so there is nothing to ledger — the same posture as the gate-only executors wired with
`NULL_EGRESS_SINK`.

The claim to hold this to in review: **if a future metric's evaluator ever needs data the
index does not already hold, it must not fetch it here.** That would turn a read into an
egress path, and the append would have to come with it.

---

## 8. Testing

- **Bucket splitter, pure function:** whole-multiple windows; a partial OLDEST bucket
  carrying its true short bounds; `bucket == window` (one bucket); `bucket > window`
  **rejected with an error naming both values**, not silently collapsed; a zero or negative
  duration rejected; a window/bucket pair over the cap rejected rather than truncated.
- **Duration parsing is the CLI's:** `--bucket 1w` resolves, proving the pinned parser is
  `parseSinceDurationToMs` and not the gateway's `w`-less `parseRelativeSinceToWindowMs`
  (§ 6.1). Without this, the spec's own default silently fails against the wrong parser.
- **Registry totality:** every metric id has an evaluator — a compile-time guarantee plus a
  runtime test that iterates the union.
- **Per metric, against a real SQLite fixture:** a populated bucket returns a value and a
  sample; an empty bucket returns `value: null` with a gap and **never `0`**.
- **`github_only_merge_data`** fires for a service binding a GitLab repo, and does not fire
  for a GitHub-only service.
- **Malformed metadata**: a `pr` row whose `metadata` is not valid JSON does not raise.
- **The four DORA wrappers delegate rather than reimplement**: asserted by giving a bucket
  the same bounds as a `metrics.dora` call and checking the values agree.

**Recorded gap:** nothing asserts that a series is *useful* — that a 1-week bucket of MTTR
carries enough incidents to be meaningful. That is a property of the user's data, not of this
code, and D2 states the consequence rather than testing it away.

---

## 9. Out of scope

No schema migration, no new invariant, no new `nimbus.toml` section, no new HTTP route, no
Tauri allowlist change.

**Named follow-ups, not deferred silently:**

- **Rolling windows** (`--rolling`), which is what the roadmap's "rolling 7-day MTTR trend"
  literally describes. Worth building once disjoint buckets exist and the sparse-bucket
  behaviour has been seen against real data.
- **`--align`**, snapping bucket boundaries to UTC day/week starts, for users who want two
  runs on different days to be comparable point-for-point (§ 6). It trades the freshest
  bucket's completeness for stability, which is the right trade for a dashboard and the wrong
  one for an ad-hoc check — hence an option rather than a change of default.
- **`merged_at` for GitLab and Bitbucket**, which would remove `github_only_merge_data`
  entirely. This is connector work and belongs with the changed-file indexing project already
  queued behind this one. **Give it a target shape now so the work has one:** epoch
  milliseconds at `metadata.merged_at`, matching what `github-sync.ts` already writes, so the
  `pr-merges` evaluator keeps one metadata path rather than growing a per-connector branch.
  A connector-specific path is how a single metric quietly becomes three.
- **A real event timestamp for the four wrapped DORA metrics** (D1). They window on
  `item.modified_at`, which is last-touch for the `pr` and `incident` rows three of them
  read, and `mttr` falls back to `synced_at` for an incident with no `opened_at_ms`. Fixing
  it means changing `dora.ts`'s own time predicate, which moves `nimbus metrics dora`'s
  numbers as well as `nimbus stats`' — a deliberate, separately-reviewed change, not a
  side-effect of adding a bucketing layer. Until then this is an accepted cost, stated in
  D1, in `docs/CHANGELOG.md`'s 2026-08-19 entry and in the roadmap row.
- **`pr-opened`**, a PR-creation-rate series. Blocked on data, not effort:
  `extractPrMetadataForIndex` records `number`, `repo`, `state`, `draft`, `merged`, `user`,
  `labels` and the size stats, but **no creation timestamp** — so per F1 there is nothing
  honest to bucket on today. It becomes cheap the moment connectors write a `created_at`
  alongside `merged_at`, and should ship in that same pass.
