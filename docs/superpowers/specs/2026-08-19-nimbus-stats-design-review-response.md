# Design Review Response: `nimbus stats`

Response to [`2026-08-19-nimbus-stats-design-review.md`](./2026-08-19-nimbus-stats-design-review.md).
Each item was checked against the tree on 2026-08-19 before being accepted.

**Outcome:** all seven accepted — four as asked, three with the reasoning corrected. Nothing
rejected. One of them exposed a defect in the spec's own default.

| # | Item | Outcome | Spec change |
| --- | --- | --- | --- |
| Q1a | `window < bucket` validation | **Accepted** | § 6.1 |
| Q1b | Which duration parser | **Accepted — and it found a real trap** | § 6.1, § 8 |
| Q2 | Bucket cap | **Accepted, reasoning corrected** | § 6.1 |
| Q3 | Record the I29 exemption | **Accepted** | § 7.1 |
| S1 | Calendar alignment | **Accepted as follow-up — and my justification was wrong** | § 6, § 9 |
| S2 | Standardize `merged_at` shape | **Accepted** | § 9 |
| S3 | `pr-opened` later | **Accepted, with its blocker named** | § 9 |

---

## Q1b — which duration parser: the sharpest item, and it broke the spec's own default

Asked as a consistency question. Checking it turned up a live defect.

There are **two** duration parsers in this repo with **different unit sets**:

- `cli/src/lib/parse-since.ts`'s `parseSinceDurationToMs` — `/^(\d+)\s*(w|d|h|m|s|ms)$/i`
- `index/item-list-query.ts`'s `parseRelativeSinceToWindowMs` — `/^(\d+)\s*([dhms])$/i`

The gateway-side one has **no `w`**. This spec's default bucket is `1w`. Had the
implementation reached for the gateway parser — the natural instinct, since the value is
consumed gateway-side — the documented default would have failed to parse, and the failure
would have looked like a user typo rather than a wrong import.

§ 6.1 now pins `parseSinceDurationToMs` explicitly, states that parsing happens CLI-side and
the gateway receives resolved integers, and names the other parser as the one not to use.
§ 8 adds a test that `--bucket 1w` resolves, so the pin is enforced rather than merely
written down. Unifying the two parsers is named as out of scope rather than quietly implied.

---

## Q1a — `window < bucket`: accepted

The spec previously listed `bucket > window` as a test case expecting "one bucket". That was
a decision made by omission.

Erroring is right. `--window 3d --bucket 1w` asks for weekly granularity across three days,
which is unsatisfiable; returning a single honestly-bounded 3-day bucket answers a question
the user did not ask. § 6.1 makes it a validation error naming both values, and § 8's test
now asserts rejection rather than collapse.

---

## Q2 — bucket cap: accepted, reasoning corrected

A cap is right, but not for the reason given. The review raises "DOS-like behavior";
`metrics.stats` has **no remote caller** — D4 gives it no HTTP route, and it is not on the
Tauri allowlist — so denial of service is not the threat model.

What it actually protects against is an arithmetic footgun: `--window 10y --bucket 1s` is
315 million evaluations from a plausible typo. § 6.1 accepts the cap on those grounds, states
the non-reason explicitly so nobody later "hardens" it as a security control, and requires
rejection over silent truncation — a truncated series that looks complete is worse than an
error.

Clamping matches convention already in the tree: `index.queryItems` uses `Math.min(1000, …)`
and `listAuditWithChain` uses `Math.min(10_000, …)`.

---

## Q3 — record the I29 exemption: accepted

Cheap and correct. This repo's culture is to record why a defense does not apply, so the next
audit reads a decision instead of re-deriving one.

Verified before writing it: I29's append site is the executor's chokepoint immediately before
`connectors.dispatch`. `metrics.stats` reads local SQLite, dispatches no connector action, and
makes no remote model call, so neither the connector nor the `model` coverage class applies.

§ 7.1 records this **with a condition attached**, which is the part worth keeping: if a future
metric's evaluator ever needs data the index does not already hold, it must not fetch it
there — that would convert a read into an egress path, and the append would have to come with
it. An exemption without the condition that voids it is how a stale exemption survives.

---

## S1 — calendar alignment: accepted as a follow-up, and my justification was wrong

The spec said calendar alignment "would need a timezone, and this product has no timezone
configuration." That is weaker than it sounded — **UTC is a defensible fixed choice needing
no configuration at all**, so the stated reason did not support the decision.

The decision still stands, on a better reason now written into § 6: walking back from "now"
makes the newest bucket end exactly at the request time, so the freshest point covers data up
to the moment of asking. Calendar alignment truncates it at the last boundary, making the
newest bucket systematically short and its number systematically low — the worst place to put
an artefact, because it is the number people read first.

The review's cost is real and is now stated as accepted rather than unmentioned: two runs on
different days cover different absolute spans and are not comparable point-for-point. `--align`
is a named follow-up in § 9, framed as the right trade for a dashboard and the wrong one for
an ad-hoc check — which is why it is an option and not a change of default.

---

## S2 — standardize `merged_at` across forges: accepted

Already a follow-up in § 9; the review is right that it needs a **target shape** or the future
work has nothing to aim at. § 9 now specifies epoch milliseconds at `metadata.merged_at`,
matching what `github-sync.ts` already writes, so the `pr-merges` evaluator keeps one metadata
path instead of growing a per-connector branch. A connector-specific path is how one metric
quietly becomes three.

---

## S3 — `pr-opened`: accepted, with its blocker named

Worth having, and the review correctly conditions it on capturing a creation timestamp.
Verified: `extractPrMetadataForIndex` records `number`, `repo`, `state`, `draft`, `merged`,
`user`, `labels` and the size statistics — and **no creation timestamp**. So per F1 there is
nothing honest to bucket on today; a `pr-opened` built now would silently measure last
activity, which is precisely what D1 refuses.

§ 9 records it as blocked on data rather than effort, and pairs it with the S2 connector pass
so both land together.
