# `GET /v1/metrics/stats` — putting the series the gateway already computes on the wire

> **Status: ANSWERED — the §4 route shipped 2026-09-11, together with §5's
> correction.** This document is kept as the argument, not as a description of
> the surface; where it and the code disagree, the code is right and
> `docs/CHANGELOG.md` records why. What landed: `GET /v1/metrics/stats`, PUBLIC
> in `dispatchReadOnlyDataGet` (§4's "Mount and scope" answered as it
> recommended), returning `StatsSeries` unchanged; and §5's attribution fix, as
> `selectAttributionIncidents` in `metrics/dora.ts`.
>
> **The disclosure question §5 left open was answered by documentation, not by
> the wire.** No new `DoraGap`/`StatsGap` member was added — the union is
> consumed by two other repos, and the residual it would announce (a
> still-burning incident is invisible because `status = 'resolved'` is required)
> is recorded in `selectAttributionIncidents`' own comment and in the CHANGELOG
> instead. That residual is NOT fixed; only the window-column defect is.
>
> **§6's `until_ms` fallback did NOT ship** and was not needed, since §4 landed.
> It stays as a live alternative if the anchor ever has to move.
>
> Originally filed as: proposal, no code in the branch — the contract argued
> before it is built, per the satellite-repo convention that the gateway owns
> the wire and consumers propose against it (#1464 established the shape).
>
> **Proposed by:** the browser client (`nimbus-web-clipper`), whose DORA page is
> designed and ships either way — without this it shows three nested windows and
> deliberately refuses to draw a line between them.
>
> **Not a blocker.** The primary ask adds no computation: `computeStatsSeries`
> already exists, is already shipped behind `nimbus stats`, and has no HTTP
> route.
>
> **Supersedes an earlier draft** that led with an `until_ms` parameter on
> `GET /v1/metrics/dora`. That parameter survives here as §6, the fallback, for
> the reason §5 gives.

## 1. What this is

The consumer wants a **time series**: one value per period, periods disjoint, so
a line between them means something. The gateway already computes exactly that,
for exactly the four DORA metrics, over exactly the same service config — and
the only way to reach it is the CLI.

```text
GET /v1/metrics/stats?service=payment-service&metric=mttr&window_ms=7776000000&bucket_ms=604800000
```

```json
{
  "metric": "mttr",
  "service": "payment-service",
  "window": { "since_ms": 1749081600000, "until_ms": 1756857600000 },
  "bucket_ms": 604800000,
  "points": [
    { "start_ms": 1749081600000, "end_ms": 1749686400000,
      "value": 5400, "unit": "seconds_median", "sample": 4, "gap": null }
  ]
}
```

That is `StatsSeries` (`packages/gateway/src/metrics/stats.ts`) verbatim. The
ask is a route, not a computation.

## 2. The concrete gap

`GET /v1/metrics/dora` takes `service` and `since` and nothing else.
`handleMetricsDora` (`packages/gateway/src/ipc/http-server.ts`) reads exactly
those two; `requireDoraParams` (`packages/gateway/src/ipc/metrics-rpc.ts`)
accepts exactly those two. `parseSinceToMs` turns `since` into a **duration**,
and every calculator in `packages/gateway/src/metrics/dora.ts` is
`(db, cfg, nowMs, sinceMs)` binding the pair `nowMs - sinceMs, nowMs`.

So every window ends at the same instant. `7d`, `30d` and `90d` are **nested** —
the first is a subset of the second, which is a subset of the third. Disjoint
periods are not expressible at any combination of parameters, and a client that
plots three nested windows as a line draws a slope that means nothing.

Meanwhile:

- `computeStatsSeries` produces disjoint buckets, each one gap-annotated,
  wrapping the same four DORA calculators plus two event-timed counters.
- `splitBuckets` (`packages/gateway/src/metrics/stats-buckets.ts`) owns the
  tiling, including `MAX_BUCKETS = 400` and a decision a consumer should not be
  re-deriving: the **first** bucket absorbs the remainder so the **last** one
  ends exactly at `untilMs`, because "the freshest point must be complete, and a
  short bucket is honest only if it is the oldest one".
- `StatsSeries` already publishes `window: { since_ms, until_ms }`, **both
  absolute**, which is the vocabulary the DORA envelope lacks.
- `metrics.stats` is an IPC method with a CLI (`nimbus stats <metric>
  --service <id> [--window 90d] [--bucket 1w]`) and **no HTTP route**.
  `/v1/metrics/dora` is the only `/v1/metrics` route the server serves.

The gap is therefore not "the gateway cannot answer this". It is "the answer is
reachable from a terminal and not from a browser".

## 3. Why this is the right ask, and the earlier draft was not

An earlier version of this document asked for an `until_ms` parameter on
`GET /v1/metrics/dora` so a client could issue N calls and assemble a series
itself. That is asking for the wrong thing, for three reasons.

**Round trips.** A twelve-bucket trend is twelve `until_ms` calls per metric.
Through a stats route it is **one call per metric — four**, for the four DORA
metrics, because `computeStatsSeries` takes a single `metric`. Four versus
forty-eight is decisive; four versus one is the honest way to state it.

**Who owns the tiling.** With `until_ms`, bucket boundaries are computed in a
browser. The argument the earlier draft used to reject a *relative* `until` —
that N calls each anchored to their own `Date.now()` on the gateway do not tile
exactly — is evidence against client-side series assembly in general, not merely
against one spelling of the parameter. `splitBuckets` already solved this,
remainder decision and all. A second consumer re-deriving it will get the
remainder on the wrong end.

**Vocabulary.** A stats route arrives with `window.since_ms` / `until_ms`
already absolute and already shipped. The `until_ms` route adds an absolute
field next to a `since_ms` that is a duration (§6), which is a naming problem
this proposal would rather not create.

## 4. Proposed contract

### Request

`GET /v1/metrics/stats`, mirroring the IPC params one-for-one.

| parameter | required | notes |
| --- | --- | --- |
| `service` | yes | 1..64 chars, as `metrics.dora` already enforces |
| `metric` | yes | one of `STATS_METRIC_IDS` |
| `window_ms` | yes | integer ms — `requireStatsParams`'s own name |
| `bucket_ms` | yes | integer ms |

Snake_case matches both the IPC params and the response fields, and
`StatsPoint`'s own comment is explicit that one method must not mix conventions.

The consumer would rather send `window_ms` / `bucket_ms` as integers than a
`90d` / `1w` duration string: the CLI parses durations at its own edge
(`nimbus stats --window 90d`) and the IPC layer takes milliseconds, so
millisecond params keep the HTTP route on the same side of that line as the IPC
it wraps. If the gateway prefers duration strings for symmetry with `since`,
the client will send either.

### Response

`StatsSeries`, unchanged, field for field. No new type, no projection decision,
and the consumer already has a parser shape for `value` / `unit` / `sample` /
`gap` because `DoraMetricValue` carries the same four.

`StatsGap` is `DoraGap` plus `github_only_merge_data` and
`incidents_missing_opened_at`. The client renders whatever gap it is handed and
prints an unrecognised one rather than dropping the point.

### The error story is the one real design question

`metrics.stats` **refuses** an unconfigured service:

```text
-32602  unknown service 'payments' — add [metrics.dora.payments] or
        [ci.service.payments] to nimbus.toml
```

`metrics.dora` **answers softly** with `unconfiguredEnvelope` and
`gap: "unknown_service"`. The dispatcher documents the asymmetry deliberately:
`dora` has four fixed slots it can place-hold, `stats` has a series whose bucket
count and unit depend on config it does not have, so there is nothing honest to
place-hold and a typo'd service must say so rather than render 13 empty buckets
that look like thin data.

That reasoning is right and this proposal does not ask to change it. It does
have to name two consequences:

1. **The consumer's service-binding validation leans on the soft answer.** It
   validates a typed service id by calling `GET /v1/preflight/deploy` and
   refusing an id that reports `unknown_service`. It will keep using preflight
   for that; it does not need stats to be soft. No change requested.
2. **Under a public mount, that refusal message is a disclosure channel.** It
   embeds the service id the caller supplied — which is their own input, so it
   discloses nothing — but the same handler must also decide what it says when
   `nimbus.toml` fails to *parse*, where the messages embed the owner's config
   values. The sibling proposal
   (`GET /v1/services`, proposed in [#1489](https://github.com/nimbus-agent/Nimbus/pull/1489))
   raises the identical seam in its §7, and both routes should answer it the
   same way.

### Bucket-shape errors

`splitBuckets` throws `StatsBucketError` for a non-positive `window_ms` /
`bucket_ms`, for `bucket_ms > window_ms`, and for more than `MAX_BUCKETS = 400`
buckets. `dispatchMetricsRpc` already maps that to `MetricsRpcError(-32602)`,
which `handleMetricsDora`'s existing pattern turns into a 400 with the message
intact. The messages are actionable ("widen the bucket or narrow the window")
and should reach the client verbatim. This is the whole error surface; nothing
new is needed.

### Mount and scope — the gateway's call

The consistent answer is **public, in `dispatchReadOnlyDataGet`**, beside
`/v1/metrics/dora` and `/v1/preflight/deploy`: it is the same data, over the
same config, for the same service, at a different resolution. Scoping the series
while the scalar stays public would be a strange seam.

That answer is not this document's to give. It carries the same costs the
sibling spec spells out — an `HTTP_ROUTE_AUTH` entry (the table is **total**
over the surface, so a public route needs `{ kind: "public" }` there or the
completeness test fails), an `HTTP_ROUTES` entry, and a `paths:` entry in
`packages/gateway/openapi/v1.yaml`, which `audit:openapi-drift` enforces as a
pair. The OpenAPI entry means the public mount also publishes the route in a
schema other tools generate clients from; that is a longer-lived commitment than
a handler.

### The series still ends at now, and that is correct

`dispatchMetricsRpc` binds `computeStatsSeries`'s `untilMs` to `nowMs`. This
proposal does not ask to change that. A trend that ends at the present is what a
trend is for, and leaving the anchor alone keeps the route's surface to four
parameters.

## 5. The accuracy defect — live today, and not introduced by either ask

This section governs both §4 and §6, because the defect is in `dora.ts`'s
window-bounded attribution rather than in any wire shape. It is stated here in
full because it is the most useful thing in this document for the people who own
that code, and because a consumer asking for a series should say plainly what
the series will and will not be worth.

### All four metrics window on `item.modified_at`

Not three. `selectDeploys`, the PR query inside `leadTimeForChanges`, and
`selectResolvedIncidents` each bind `modified_at >= ? AND modified_at <= ?`, and
every DORA metric is built from those three selections.

The "three" in `docs/cli-reference.md` is counting something narrower — the
metrics that read `pr` and `incident` rows, where `modified_at` is a *last
touch* timestamp rather than an event time:

> The four wrapped DORA metrics call the existing calculators unchanged, which
> also inherits their `item.modified_at` windowing — last touch, not event time,
> for the `pr` and `incident` rows three of them read

Deployment rows are windowed on `modified_at` too; they simply suffer less from
it. Stated precisely because the sentence is addressed to the people who own
`dora.ts` and will be read as a claim about their code.

For a window ending at *now*, last-touch windowing inflates the recent window.
For a series it does worse: a recently-touched old row is pulled out of the
period it belongs to and into the present one, which is the shape of a fake
trend. This is a documented, accepted cost that `nimbus stats` already carries.

### The attribution hole, and why the obvious fix does not close it

`changeFailureRate` attributes an incident to a deploy only when both fall
inside the window, then looks back `incidentWindowMinutes`. A deploy near the
window's upper edge whose incident opens after that edge is counted as a
**success**.

The obvious fix — widen the incident lookup past the upper bound by
`incidentWindowMinutes` — **does not work**, and an implementer who applied it
would believe the hole was closed. The reason is that the column the window
filters on is not the column attribution reads:

- `selectResolvedIncidents` bounds on `i.modified_at`, keeps only rows whose
  `metadata.status === "resolved"`, and sets `resolved: r.modified_at`. The
  window is applied to **resolution** time.
- The attribution loop compares `inc.opened` — `metadata.opened_at_ms`, falling
  back to `synced_at` — against each in-window deploy.

An incident opened one minute before the upper bound may resolve days later;
`mttr` exists precisely because resolution lag is measured in hours to days. A
lookup widened by sixty minutes of *resolution* time does not reach it, and the
deploy is still reported clean.

**The fix that closes it** is to select attribution candidates by
`json_extract(i.metadata, '$.opened_at_ms')` rather than by `modified_at`, over
`[start, until + incidentWindowMinutes]`.

Two riders:

- **Do not widen the deploy selection.** `deploys.length` is the denominator;
  widening it changes the number the metric reports. Only the incident lookup
  moves.
- **A still-burning incident is invisible at any bound**, because
  `status === "resolved"` is required. So a historical `change_failure_rate`
  under-reports for a second, independent reason. `computeStatsSeries`'s
  `discloseUntimedIncidents` seam exists for a neighbouring version of this
  problem — a series-level probe that reports what the buckets could not see —
  and is the precedent for disclosing this one.

### What changes when a series goes on the wire

**Nothing about the defect. Everything about how often it fires.**

Today `GET /v1/metrics/dora` has exactly one upper edge, it is `now`, and the
incident genuinely has not happened yet. That is unavoidable and no reasonable
contract avoids it.

A series has N upper edges and **every one of them is in the past**, where the
incident is sitting in the index, readable, and being ignored. The defect rate
goes from "one boundary nobody can fix" to "every boundary, all fixable".

And this is not hypothetical or future: `computeStatsSeries` binds `nowMs` to
each bucket's end and calls the same four calculators, so **every bucket
`nimbus stats` prints today already has this hole**. Putting the series on HTTP
does not introduce the defect. It widens its audience.

### The consumer's position

The correction should land with whichever route lands. This is a statement about
the client's own honesty rules rather than a demand: a page that refuses to draw
a slope between overlapping windows is not going to draw a
`change_failure_rate` line it knows to be systematically low. Without the
correction the consumer would ship the series with that metric suppressed or
caveated, which is a worse outcome than shipping it correct.

Whether the disclosure belongs on the wire — a new `DoraGap` member, additive to
a closed union two repos consume — or only in documentation is the gateway's
call. The client prints whatever gap it is handed, so either works.

## 6. The fallback: `until_ms` on `GET /v1/metrics/dora`

If a new route is not wanted, one optional parameter on the existing public one
makes disjoint windows expressible, and the client assembles the series itself.
This is the narrower ask and it remains independently useful — "the same metric
for last quarter" is a scalar question, not a series one.

### Shape

`until_ms` — optional, absolute epoch milliseconds. Absent means `now`, which is
today's behaviour exactly, so every existing caller is unaffected. `since` keeps
its grammar (`\d+(d|h)`, 1..365) and its meaning as a **duration**, now measured
back from `until_ms`.

The response gains `until_ms` so a cached answer can say which window it
describes.

### `nowMs` is doing double duty and must be split

`computeDoraMetrics` derives `computed_at` from the same `nowMs` it binds as the
query's upper bound. Threading `untilMs` separately is not tidiness: it is the
difference between a historical answer that is cacheable and one
indistinguishable from a fresh computation. `computed_at` stays wall-clock now.

### The naming collision, which is why this is the fallback

`DoraMetricsResult.since_ms` is a **duration** (it is `sinceMs`, the parsed
window length). `StatsSeries.window.since_ms` is an **absolute timestamp**.
Adding an absolute `until_ms` beside a duration `since_ms` puts two meanings
behind one `_ms` suffix, in an envelope whose sibling already uses the other
meaning. Three ways out:

1. Add `until_ms` and leave `since_ms` alone. Smallest change, permanent
   oddity.
2. Add a nested `window: { since_ms, until_ms }`, both absolute, mirroring
   `StatsSeries`, leaving the top-level `since_ms` as the duration it has always
   been. Redundant, but every field is unambiguous — and if the §4 route ever
   lands, this is the only option that leaves the two envelopes speaking the
   same language. **Recommended.**
3. Rename `since_ms`. Breaking; not worth a major.

For the record on naming precedent: `target_ref` and `max_findings` are the
*preflight* route's parameters; `since_ms` is this envelope's own field and is
not on the preflight result at all, whose fields are `service`, `target_ref`,
`computed_at`, `verdict` and `checks`. Snake_case is still the recommendation —
`StatsSeries` uses it — but the surface is already mixed: `GET /v1/items` takes
camelCase `sinceMs` / `untilMs` beside a relative `since`.

### Validation

| condition | status | body |
| --- | --- | --- |
| `until_ms` not an integer | 400 | `{ "error": "until_ms must be integer milliseconds" }` |
| `until_ms` <= 0 | 400 | same shape |

A **future** `until_ms` is accepted, not refused: it degrades to today's
behaviour (no row has a `modified_at` beyond now), and a client whose clock runs
a few seconds ahead of the gateway's should not get a 400 for it. Errors stay
`MetricsRpcError(-32602)` mapped to 400, as `since` already does.

### Costs

No new route, no new scope, no re-pairing — `/v1/metrics/dora` is already
`{ kind: "public" }` and this does not ask to change that, so its
`HTTP_ROUTE_AUTH` entry is unchanged (the one place this ask is cheaper than
§4). The parameter and the response field must land in
`packages/gateway/openapi/v1.yaml` in the same commit or `audit:openapi-drift`
fails.

And §5 applies here too — more sharply, because a client assembling N windows
hits N upper edges with no `splitBuckets` to at least make them consistent.

### Does the IPC verb move too?

`metrics.dora` is an IPC method before it is an HTTP route, and `nimbus metrics
dora` takes `--since` with no `--until`. Adding the parameter on HTTP only would
make the CLI the weaker surface for the first time; `docs/cli-reference.md`
would need the flag in the same change. The consumer has no stake. Recorded
because a reviewer will ask.

## 7. What the client does without either

Ships, and says less.

The DORA page renders the four metrics across three nested windows (7d / 30d /
90d) side by side, each column labelled as a window **ending now**, as three
independent concurrent GETs through `Promise.allSettled` so one slow or failing
window does not discard two good answers. It deliberately **does not draw a
line** between them, because a slope between overlapping windows would assert
change over time that the data does not contain.

That is still directional and still useful — a change-failure rate worse over 7
days than over 90 is a real statement about the recent past. It is simply not a
series. The day either ask lands, the page draws one, the same way the client
adopted `resolve-file` (#1447) and `resolve-ids` (#1465): probe, and use it if
it answers.

## 8. Alternatives considered

**Have the client compute a trend from nested windows.** Subtracting a 30-day
window from a 90-day one to recover days 31–90 is arithmetic that works for a
count and fails for a median or a ratio — `lead_time_for_changes` and `mttr` are
medians, and medians do not decompose across subtracted windows. It would also
invent a `sample` the gateway never reported. Rejected: a metrics page whose
numbers are derived rather than measured is exactly the failure mode the
consumer's honesty rules exist to prevent.

**Express the fallback's `until` as a relative age (`until=30d`).** Keeps the
route in one vocabulary and avoids the client computing epochs at all. Rejected
as the primary spelling because a series built from N concurrent calls, each
anchored to its own `Date.now()` on the gateway, does not tile exactly. An
absolute `until_ms` makes window *k*'s end and window *k+1*'s start the same
integer by construction. Both could be accepted, as `GET /v1/items` already
accepts both forms for `since`.

**Expose `metrics.stats` only over the existing IPC/Tauri surface and let the
browser go without.** Coherent, and it is the status quo. Rejected as the thing
being proposed against: the browser speaks HTTP and not IPC, which is the same
reason the egress reads needed routes (#1319) over primitives that had shipped
as IPC verbs.

**Add `until_ms` to the stats route too**, so a series can end in the past.
Deliberately not asked for. It is a fifth parameter for a case no consumer has,
and §5 means a past-anchored series compounds the attribution hole rather than
merely inheriting it.

## 9. Compliance checklist

- **No new computation.** `computeStatsSeries`, `splitBuckets` and the four
  calculators are untouched by §4. The route is the ask.
- **Route auth table.** `HTTP_ROUTE_AUTH` is total over the surface; §4 needs an
  entry whichever mount is chosen. §6 needs none — the route already has one.
- **OpenAPI.** §4 adds `HTTP_ROUTES` + a `paths:` entry; §6 adds a parameter and
  a response field to the existing entry. `audit:openapi-drift` enforces both.
- **Not a write.** I13 governs HTTP write routes via `WRITE_ROUTE_ALLOWLIST`;
  a GET stays off it. Named because "new HTTP route" is the trigger a reviewer
  reaches for I13 on.
- **Not egress.** Local index read, no provider request, no ledger row.
- **No schema change, no migration.** The columns and indexes already carry both
  bounds.
- **Tests.** `packages/gateway/test/integration/http/metrics-dora-route.test.ts`
  and `packages/gateway/test/unit/metrics/` are both in the
  `test:coverage:metrics` gate; a stats route test belongs beside the first as
  `metrics-stats-route.test.ts`. Three assertions carry the weight:
  - **Absent means today.** The existing dora route test passes unchanged with
    no `until_ms`, byte for byte.
  - **`computed_at` is not `until_ms`.** A response for a window ending a month
    ago carries a wall-clock-now `computed_at` — the test that proves §6's
    separation held.
  - **The attribution edge (§5).** A deploy five minutes before a bucket's end,
    an incident opened ten minutes after it and resolved three days later: the
    deploy counts as **failed**. This single fixture distinguishes the correct
    fix from the widening that does not work, which would still report it clean.

## 10. Open questions for the gateway

1. The series route (§4), the `until_ms` parameter (§6), both, or neither? The
   consumer's order of preference is as written.
2. Mount and scope for §4 — public beside `/v1/metrics/dora` is the consistent
   answer, but it is the gateway's to give, and it publishes the route in
   `openapi/v1.yaml`.
3. `window_ms` / `bucket_ms` as integers, or duration strings like `since`? §4.
4. **Does §5's correction land with whichever route lands?** The consumer's
   position is yes — and note the defect is live in `nimbus stats` today, so
   this question outlives this proposal either way.
5. Should the still-burning-incident and `modified_at` caveats be disclosed on
   the wire (a new `DoraGap` / `StatsGap` member), or only in documentation? §5.
6. If §6: which of the three answers to the `since_ms` collision? Option 2 is
   recommended, and is the only one that survives §4 landing later.
7. If §6: does `metrics.dora` the IPC verb, and `nimbus metrics dora --until`,
   move in the same change?
