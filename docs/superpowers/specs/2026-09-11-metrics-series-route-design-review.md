# Design Review: `until` on `GET /v1/metrics/dora` — making a disjoint window expressible

**Date:** 2026-09-11  
**Reviewer:** Claude Opus 5 (AI Coding Assistant)  
**Status:** Review Complete — needs changes; the ordering of the ask should be reconsidered. **Addressed:** the spec now leads with the stats route per §2, keeps `until_ms` as its §6 fallback, and was renamed to match.  
**Target Spec:** [`2026-09-11-metrics-series-route-design.md`](./2026-09-11-metrics-series-route-design.md) — reviewed under its original title, *`until` on `GET /v1/metrics/dora` — making a disjoint window expressible*  
**Slot:** HTTP Client Surfaces / Web Clipper (`nimbus-web-clipper` integration)  
**Related Surfaces:** `metrics.dora`, `metrics.stats`, `GET /v1/metrics/dora`, `nimbus metrics dora`, `nimbus stats`  
**Sibling Proposal:** `GET /v1/services` — [#1489](https://github.com/nimbus-agent/Nimbus/pull/1489)

---

> **This is a review note, not guidance. Where it disagrees with the design
> spec, the spec wins.**
>
> One disagreement is deliberate and is the reason this note exists: **§5's
> proposed fix does not close the hole §5 identifies.** Extending the incident
> lookup past the upper bound by `incidentWindowMinutes` is insufficient,
> because `selectResolvedIncidents` windows on *resolution* time, not on the
> `opened` timestamp attribution actually compares. See C3.2.
>
> It is committed because this repo keeps review notes beside their specs, and
> it is pruned when the feature ships — or when the proposal is declined.

## 1. Executive Summary

The spec proposes one optional parameter, `until_ms`, moving the upper bound of the DORA
window off `now` so three calls describe three consecutive periods instead of three nested
ones. It is additive, back-compatible, needs no new route, scope or re-pairing, and the
client ships without it today.

**Verdict: needs changes.** Not because the ask is wrong — the gap is real and precisely
stated — but because of two things:

1. **§5's fix is wrong in a way that matters.** It correctly finds that `until` would ship
   a knowably wrong `change_failure_rate`, then prescribes a widening that does not fix it.
   A maintainer who implements §5 as written would believe the hole is closed. (C3.2.)
2. **The alternative in §7 is probably the better primary ask.** `metrics.stats` already
   computes the series the consumer wants; §2 of this note argues it should lead, with
   `until` as the secondary — and names the one thing that argument must *not* claim.

Claims checked against the branch point. The load-bearing ones hold:

| Claim | Verified |
| --- | --- |
| `handleMetricsDora` reads only `service` and `since`; `requireDoraParams` accepts only those two | `packages/gateway/src/ipc/http-server.ts`, `packages/gateway/src/ipc/metrics-rpc.ts` |
| `parseSinceToMs` yields a **duration**; grammar `\d+(d\|h)`, 1..365; errors are `MetricsRpcError(-32602)` mapped to 400 | `packages/gateway/src/ipc/metrics-rpc.ts` |
| Every calculator is `(db, cfg, nowMs, sinceMs)` and binds `nowMs - sinceMs, nowMs`; queries are two-sided | `packages/gateway/src/metrics/dora.ts` |
| `computeDoraMetrics` derives `computed_at` from the same `nowMs` it binds as the upper bound — the double duty §3 names | `packages/gateway/src/metrics/dora.ts` |
| `computeStatsSeries` calls `splitBuckets(untilMs, windowMs, bucketMs)` and evaluates each bucket against a sub-window ending in the past | `packages/gateway/src/metrics/stats.ts` |
| The comment quoted in §3 ("binding `nowMs` to the bucket's end…") is verbatim | `packages/gateway/src/metrics/stats.ts` |
| `StatsSeries` publishes `window: { since_ms, until_ms }`, both absolute; `DoraMetricsResult.since_ms` is a duration | `packages/gateway/src/metrics/stats.ts`, `packages/gateway/src/metrics/dora.ts` |
| `MAX_BUCKETS = 400` | `packages/gateway/src/metrics/stats-buckets.ts` |
| `metrics.stats` refuses an unconfigured service where `metrics.dora` answers softly — and the dispatcher documents the asymmetry | `packages/gateway/src/ipc/metrics-rpc.ts` |
| `/v1/metrics/dora` is the only `/v1/metrics` route on the HTTP server; `metrics.stats` has none | `packages/gateway/src/ipc/http-server.ts` |
| `/v1/metrics/dora` is `{ kind: "public" }`, is in `HTTP_ROUTES`, and has a `paths:` entry in the schema | `packages/gateway/src/ipc/http-route-auth.ts`, `packages/gateway/src/ipc/http-routes.ts`, `packages/gateway/openapi/v1.yaml` |
| `GET /v1/items` accepts camelCase `sinceMs` / `untilMs` beside a relative `since` | `packages/gateway/src/ipc/http-server.ts` |
| `nimbus metrics dora` takes `--since` and has no `--until` | `packages/cli/src/commands/metrics.ts` |
| The named tests exist and are both in `test:coverage:metrics` | `packages/gateway/test/integration/http/metrics-dora-route.test.ts`, `packages/gateway/test/unit/metrics/` |
| The `modified_at` skew and the dora.ts follow-up are documented for `nimbus stats`, quoted verbatim | `docs/cli-reference.md` |

## 2. Should This Lead With `GET /v1/metrics/stats` Instead?

**Yes — with one correction that the stats argument must not be allowed to make.**

The consumer's actual requirement is a *series*. `computeStatsSeries` produces exactly
that, disjoint, gap-annotated per bucket, capped at 400 buckets, over the same service
config — and `StatsSeries` already carries the absolute `window: { since_ms, until_ms }`
vocabulary the DORA envelope is missing. It has no HTTP route. Three arguments for putting
it first:

- **Round trips.** A twelve-bucket trend is twelve `until` calls. Through a stats route it
  is one call per metric — four, for the four DORA metrics — and the spec's "in **one** call
  instead of N" overstates only by that factor (C3.5), not in direction.
- **Who owns the arithmetic.** With `until`, bucket boundaries are computed in a browser.
  §7's own reason for rejecting a relative `until` — that N calls each anchored to their own
  `Date.now()` do not tile exactly — is evidence *against* client-side series assembly in
  general, not merely against the relative form. `splitBuckets` already solves the tiling
  problem, including the deliberate choice to let the oldest bucket absorb the remainder so
  the freshest one is complete. That decision should not be re-derived per consumer.
- **Vocabulary.** A stats route lands with `window.since_ms` / `until_ms` already absolute
  and already shipped, which dissolves §4's naming collision instead of adding to it.

**The correction.** A stats-first argument must not claim stats avoids §5's accuracy
problem. It does not. `computeStatsSeries` binds `nowMs` to each bucket's end and calls the
same four calculators, so **every bucket has the same upper-edge attribution hole**, and
`nimbus stats` ships it today. That is the unifying point both proposals are circling: the
defect is in `dora.ts`'s window-bounded attribution, not in any wire shape, and it is
already on the wire via the CLI. Whichever route lands, the fix is the same fix.

**Recommended restructure.** Lead with "expose the series the gateway already computes",
keep `until` as the narrower fallback for the scalar question ("the same metric for last
quarter"), and move the honesty section so it governs both — because it does. The spec's
three reasons for ordering it second are all real and all small: a new route is a mount
decision, stats refuses an unconfigured service, and `until` is independently useful. None
of them outweighs "the gateway already computes the thing the consumer is asking to
approximate". The error-story objection in particular is a paragraph of design, not a
reason to reorder a proposal.

This is a judgement call, not a defect. §7 does name stats as "the strongest alternative by
some distance" and offers to close this proposal unbuilt in its favour, which is honest.
The recommendation is to make that the headline rather than the last section.

## 3. Corrections Before This Opens

### C3.1 — "Three of the four metrics window on `item.modified_at`" is wrong (factual)

**All four do.** `selectDeploys`, the PR query inside `leadTimeForChanges`, and
`selectResolvedIncidents` each bind `modified_at >= ? AND modified_at <= ?`, and every DORA
metric is built from those three selections.

The "three" in `docs/cli-reference.md` is counting something else — the metrics that read
**pr and incident** rows, where `modified_at` is a last-touch timestamp rather than an event
time:

> The four wrapped DORA metrics call the existing calculators unchanged, which also inherits
> their `item.modified_at` windowing — last touch, not event time, for the `pr` and
> `incident` rows three of them read

Deployment rows are windowed on `modified_at` too; they simply suffer less from it. Restate
as: all four window on `modified_at`; for the three that read `pr` / `incident` rows, that
is last touch rather than event time. This matters because the sentence is addressed to the
people who own `dora.ts` and will be read as a claim about their code.

### C3.2 — §5's proposed fix does not close §5's hole (material)

The mechanism §5 describes is real, and worse than stated. Verified in
`packages/gateway/src/metrics/dora.ts`:

- `selectResolvedIncidents` selects `pagerduty` / `incident` rows bound by
  `i.modified_at >= ? AND i.modified_at <= ?`, then keeps only rows whose
  `metadata.status === "resolved"`, and sets `resolved: r.modified_at`. So the window is
  applied to the **resolution** time.
- Attribution compares `inc.opened` — taken from `metadata.opened_at_ms`, falling back to
  `synced_at` — against each in-window deploy, looking back `incidentWindowMinutes`.

The consequence: the parameter the window filters on is not the parameter attribution reads.
§5 prescribes extending the incident lookup past the upper bound by `incidentWindowMinutes`.
That is sized against the *opened*-time gap, but the filter is on *resolution* time. An
incident opened one minute before `until` may resolve days later — `mttr` exists precisely
because resolution lag is measured in hours to days — and such an incident falls outside a
lookup widened by sixty minutes, so the deploy is still reported clean.

The fix that actually closes it is to select attribution candidates by
`json_extract(i.metadata, '$.opened_at_ms')` rather than by `modified_at`, over
`[start, until + incidentWindowMinutes]`. A second consequence falls out of the same
reading and should be stated: because `status === "resolved"` is required, an incident that
is **still burning** is invisible at any bound, so a historical `change_failure_rate` under-
reports for that reason as well. (`computeStatsSeries`'s own `discloseUntimedIncidents` seam
exists for a neighbouring version of this problem, which is a useful precedent to cite.)

Also delete, or qualify, the parenthetical "(and deploy)". Widening the **deploy** selection
changes `deploys.length`, which is the denominator. The next clause does say the denominator
stays the requested window, but the parenthetical is what an implementer will copy.

### C3.3 — §5 states the consequence too softly for what it found (judgement)

Asked directly: **no, §5 is not strong enough**, and the reason is structural rather than
rhetorical. Three fixes, in order of value:

1. **Promote it.** It arrives as "a second, sharper edge case" beneath the `modified_at`
   discussion. It is the more serious of the two: the `modified_at` skew is an accepted,
   documented cost inherited from `nimbus stats`, while this is a *new* wrong number that
   the parameter would introduce.
2. **Say what changes about the edge count.** Today there is one upper edge, it is `now`,
   and the incident genuinely has not happened yet — unavoidable, and the spec says so. A
   series has N upper edges and every one of them is in the past, where the incident is
   sitting in the index and is avoidable. The defect rate goes from "one boundary you cannot
   fix" to "every boundary, all fixable". That sentence is missing and it is the whole
   argument.
3. **Make §5 agree with §9.** Open question 3 already takes the position that the widening
   should land with the parameter. §5 says it "belongs with this change, not after it" and
   then hands the decision back. Pick one register. This review's position matches Q3's:
   `until` should not ship without it, and the spec is entitled to say so — a consumer may
   decline to consume a number it knows to be wrong, which is a statement about the client's
   own honesty rules rather than a demand on the gateway.

### C3.4 — `since_ms` is not on the preflight envelope (precision)

§4's parameter-naming paragraph reads "`target_ref`, `max_findings`, `since_ms` on the
sibling preflight route and in this envelope". `target_ref` and `max_findings` are
preflight's; `since_ms` is this envelope's only — the preflight result's required fields are
`service`, `target_ref`, `computed_at`, `verdict`, `checks`. The sentence is defensible if
parsed carefully and misleading if read at speed. Split it.

### C3.5 — "the series in **one** call instead of N" (precision)

`computeStatsSeries` takes a single `metric`. Four DORA metrics is four calls, not one. The
comparison is still decisive — four versus one-per-bucket — so state it as four.

## 4. Endorsements

- **§3's `nowMs` double-duty finding is correct and important.** `computeDoraMetrics` uses
  the same `nowMs` for the query's upper bound and for `computed_at`. Threading `untilMs`
  separately, as the spec insists, is the difference between a cacheable historical answer
  and one indistinguishable from a fresh computation. Keep this paragraph exactly as it is.
- **§4's naming-collision analysis is correct**, and the three options are the three
  options. Recommend option 2 (a nested absolute `window`, top-level `since_ms` left alone),
  for a reason the spec cannot know it has: if a stats route lands, option 2 is the only one
  that leaves the two envelopes speaking the same language.
- **Accepting a future `until_ms`** rather than 400-ing a client whose clock is seconds
  ahead is right, and the justification given (no row has a `modified_at` beyond now) is the
  correct one.
- **§7's rejection of client-side trend arithmetic** is correct and worth keeping verbatim:
  `lead_time_for_changes` and `mttr` are medians, and medians do not decompose across
  subtracted windows.

## 5. Invariants & Gates

1. **I13.** Correct — a query parameter on a public GET does not touch
   `WRITE_ROUTE_ALLOWLIST`.
2. **OpenAPI drift.** Correct and load-bearing: `/v1/metrics/dora` is in both `HTTP_ROUTES`
   and the schema, so the parameter and the new response field must land in
   `packages/gateway/openapi/v1.yaml` in the same commit or `audit:openapi-drift` fails.
3. **`HTTP_ROUTE_AUTH`.** Unchanged, correctly — the route already has its `{ kind: "public" }`
   entry. (Contrast the sibling proposal, which needs a new one under either option.)
4. **Egress / schema.** Correct: local index read, no ledger row, no migration.
5. **A gate the spec does not name.** A malformed `nimbus.toml` throws out of
   `loadNimbusServiceConfigsFromConfigDir`, and `handleMetricsDora` catches only
   `MetricsRpcError` — so that throw is already a 500 on this route today. Not introduced by
   this parameter, but a reviewer touching `handleMetricsDora` will see it, and the sibling
   proposal raises the same seam.

## 6. Read as a Proposal

A maintainer reading cold gets the problem (nested windows cannot express a trend), the
shape (one optional parameter, absent means today), and what happens on a no (§6: the page
ships three nested windows and refuses to draw a line between them). Nothing is asked for
that the client does not need — `until_ms` on the request and `until_ms` on the response,
where the second exists so a cached answer can say which window it describes.

Tone is peer throughout, and §5 is the strongest evidence of it: the spec spends its longest
section arguing against its own parameter's readiness. That is the right instinct and the
reason C3.2 and C3.3 are framed as making that section *do its job*, not as softening it.

The one structural weakness is §7. Burying the alternative the gateway may well prefer at
the end of the document is not dishonest — it is argued fairly and the offer to close this
proposal unbuilt is explicit — but it asks the reviewer to read to the end to find the
question they most need to answer. See §2.

## 7. Testing Strategy, If It Is Built

- **The parameter is wired, not accepted and dropped.** A historical window whose result
  differs from the same-length window ending now — the spec names this and it is the right
  assertion.
- **Absent means today.** The existing route test's expectations must pass unchanged with no
  `until_ms`, byte for byte.
- **`computed_at` is not `until_ms`.** A response for a window ending a month ago carries a
  `computed_at` of wall-clock now. This is the test that proves §3's separation held.
- **The attribution edge (C3.2).** A fixture with a deploy five minutes before `until_ms`
  and an incident opened ten minutes after it, resolved three days later: the deploy counts
  as failed. This single case is what distinguishes the correct fix from the widening §5
  currently prescribes, which would still report it clean.
- **Bounds.** Non-integer and non-positive `until_ms` are 400s; a future `until_ms` is a 200
  equivalent to the no-parameter answer.
- **Schema.** `audit:openapi-drift` green with the parameter and the new field documented.
