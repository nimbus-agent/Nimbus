# Plan Review Response: `nimbus stats`

Response to [`2026-08-19-nimbus-stats-review.md`](./2026-08-19-nimbus-stats-review.md).
Each item was checked against the tree on 2026-08-19 before being accepted.

**Outcome:** all three accepted. The first was the sharpest review item of this project so far
— it pointed at a real defect, and reading the code it named turned up **two more the review
did not mention**, both of which would have shipped a metric bucketed on the wrong timestamp.
Its recommended *fix* is rejected, on the grounds of the plan's own governing rule.

| # | Item | Outcome | Plan change |
| --- | --- | --- | --- |
| 1 | `incidents-opened` and the `synced_at` fallback | **Accepted — fix rejected, third answer implemented** | Task 2 step 3 (a)(b)(c) + 5 tests |
| 2 | IPC error-message quality | **Accepted** | Task 3 step 3 |
| 3 | Sparse series reads as breakage | **Accepted** | Task 4 step 3 |

---

## 1 — `incidents-opened`: right about the defect, wrong about the fix

The review is correct that my plan's instruction — "count incident rows whose
`metadata.opened_at_ms` falls in `[startMs, endMs)`" — silently drops incidents where that
field is absent. Verified: `connectors/pagerduty-sync.ts:90` writes it **conditionally**
(`if (Number.isFinite(openedAtMs))`), and `metrics/dora.ts:310` falls back to `r.synced_at`
precisely because it can be missing. The field is genuinely optional.

**But the recommended fix — `COALESCE(json_extract(metadata,'$.opened_at_ms'), synced_at)` —
is rejected.** `synced_at` is when *we indexed the row*, not when the incident opened.
Bucketing on it violates the rule governing this evaluator, stated in the spec's D1 and
repeated in the plan's Global Constraints: the two NEW counters bucket on a real event
timestamp, because `item` has no creation timestamp and F1's whole point is that indexing time
is not event time. (This sentence originally generalised that rule to all six metrics. It was
false — the four wrapped DORA calculators inherit `dora.ts`'s `item.modified_at` predicate, and
`mttr` its `synced_at` fallback. Corrected 2026-08-19; spec § 3 D1 records why that inheritance
is the accepted cost of not reimplementing them.)
Coalescing would not fix a silent drop; it would replace it with a silent fabrication — an
incident placed in the week we happened to sync it, presented as the week it opened. That is
strictly worse, because a dropped row at least does not lie about *when*.

Neither option on offer is acceptable, so the plan now implements a third: **count only
incidents carrying a real `opened_at_ms`, and report the exclusion through a new
`incidents_missing_opened_at` gap** rather than swallowing it. Nothing is dropped silently and
nothing is invented. This is the same discipline as the rest of the feature — `null` plus a
named reason beats a plausible number.

### Two further defects the code read turned up, which the review did not name

**(a) `dora.ts`'s incident query filters on `modified_at`, not on opened time.**
`selectResolvedIncidents` (`dora.ts:301-302`) windows with
`i.modified_at >= ? AND i.modified_at <= ?` and only *then* uses the opened timestamp for
duration arithmetic — correct for MTTR, wrong for a series of when incidents opened. My plan
told the implementer to scope "exactly as `dora.ts` already scopes them", which read as
license to copy that predicate. It would have bucketed a months-old incident into this week
because somebody touched it — the exact F1 trap the entire spec exists to avoid, reintroduced
by my own instruction. The plan now says explicitly: copy the **service** scoping, replace the
**time** predicate.

**(b) `selectResolvedIncidents` skips anything not `status === "resolved"`.**
Right for MTTR, which needs a resolution time; wrong here. An incident still burning is still
an incident that opened, and filtering by status would undercount exactly the ones a reader
most wants to see. The review raised this as a question to clarify; the answer is do not
filter, and the plan now says so with the reason.

### What changed in the plan

Task 2 step 3 replaces a one-sentence prose description with the full evaluator source and
three explicitly numbered warnings about what not to copy from `dora.ts`. `StatsGap` gains
`incidents_missing_opened_at` in all three places it is written. Five tests were added that
pin each correction — the exclusion-and-flag behaviour, that an old incident touched recently
stays in its original bucket, that an unresolved incident is counted, that a missing mapping
yields `no_pagerduty_mapping` rather than zero, and that another service's incident is not
counted. Without those, the plan would state the rules and nothing would enforce them.

---

## 2 — IPC error-message quality: accepted

Reasonable and cheap. The CLI prints these verbatim, so a bare `-32602` with a generic message
is indistinguishable from a bug at the terminal.

Task 3 step 3 now requires every error to name its offending value: the unknown metric lists
the valid ids, the unknown service names the config table to add, and a bucket error names both
durations. It also states not to discard `StatsBucketError`'s original message when converting
— which is why the plan re-wraps it rather than substituting a generic string.

---

## 3 — a sparse series reading as breakage: accepted

A good catch, and it matters more here than it would for most features. Spec D2 records that
for a median metric like `mttr` a one-week bucket often holds one or two incidents, so
`low_sample` firing on most buckets is the **expected** shape, not a malfunction. A wall of
dashes with no explanation invites the user to conclude the tool is broken and stop using it.

Task 4 step 3 now carries three rendering rules instead of one: `null` still prints `—` and
never `0`; a summary line beneath the table gives how many buckets carried a value out of the
total plus the distinct gap reasons (`4 of 13 buckets had data (9 low_sample)`); and an
all-null series prints one plain sentence naming the dominant gap rather than a full table of
dashes, since that is the case most likely to be misread. `--json` gets no summary — a machine
consumer computes its own.
