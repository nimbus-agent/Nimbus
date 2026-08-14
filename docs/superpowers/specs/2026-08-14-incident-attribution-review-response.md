# Incident attribution — review response

**Date:** 2026-08-14
**Reviews:** [2026-08-14-incident-attribution-review.md](./2026-08-14-incident-attribution-review.md)
**Target:** [2026-08-14-incident-attribution-design.md](./2026-08-14-incident-attribution-design.md)

**Outcome: 3 accepted (2 widened beyond what was asked), 1 deferred with the interaction
documented.** Every claim below was checked against the tree at `a68945e5` before the
verdict was written.

---

## 1. Rate limiting + failure isolation for the `/users/{id}` fallback — ACCEPTED

**Verified.** `pagerduty-sync.ts:162` already calls `await
ctx.rateLimiter.acquire("pagerduty")` before every list request. The spec introduced a
second network call and said nothing about the limiter, which would have left the new
path as the only unlimited request in the connector.

Fixed in § 5.3, with two additions the review did not ask for:

- **Sequential, never `Promise.all`.** The 25-lookup cap bounds total requests but not
  their burst rate; fanning 25 concurrent requests at a shared limiter is the exact spike
  the limiter exists to smooth. A cap alone reads like a solution and isn't one.
- **The 403 case named explicitly.** The review listed 403 among generic errors. It is
  not generic — it is the *expected steady state* for any PagerDuty token scoped before
  this feature existed, which is every existing installation. It now has its own row in
  the § 7 failure table and its own risk entry, because an upgrade path where `resolves`
  is silently always-empty is the most likely real-world outcome of this spec.

Failed lookups are memoized as failed (not retried within the run), counted, and never
abort the sync.

## 2. Offset-pagination same-timestamp stall — DEFERRED, documented

**Verified as a real defect**, and the mechanism is worse than the review stated.

`maxUpdated` is seeded from `since` (`:157`) and advances only on strict `updated >
maxUpdated` (`:121-123`); offset derives from `pagesFetched` and resets to 0 each run
(`:167`). A fully truncated run (2000 rows) whose `updated_at` all equal the incoming
cursor re-encodes the cursor unchanged. Because `hasMore` is `true` in that state, the
scheduler re-runs immediately — a no-progress spin, not just a wasted page.

Two corrections to the review's framing:

- PagerDuty's `updated_at` is **second**-resolution, not millisecond. The collision
  window is 1000× wider than the review assumed, which makes this more likely, not less.
- The comparison is string-lexicographic on the raw ISO value, not numeric.

**Not fixed here.** It is a pagination-cursor defect with no relationship to attribution,
it needs its own test, and it is a `PdCursorV1` → `V2` change. Folding it into an
attribution PR is the cross-concern seam that has repeatedly produced blocking findings
in this repo.

**But not silently deferred either.** § 5.6's `historyFloorMs` opt-in makes a truncated
first run — the stall's precondition — substantially more likely. This spec does not
create the bug, but it is the reason the precondition gets hit more often, so § 5.6.1
records the mechanism, the exposure change, and the mitigation shape so the follow-up is
a small fix rather than a re-investigation. It is also listed in § 6 as explicitly not
done and in § 10 as a knowingly accepted risk.

Worth filing as an issue — say the word and I will.

## 3. `person.id` (UUID) vs `graph_entity.id` (SHA-256) — ACCEPTED as a clarity fix

**Partially pre-existing.** § 5.4's closing paragraph already specified
`upsertGraphEntity({ type: "person", externalId: <person.id>, … })`, so the design was
not wrong. But the shorthand bullets above it read `upsertGraphRelation(person, incident,
…)`, and a reader who stopped there would implement the conflation — which is exactly
what happened here. A design that requires reading to the end of the section to avoid a
wrong implementation is a defective design document.

Rewritten in § 5.4 as explicit code, with the two id spaces named, plus a detail the
review did not include: the conflation **fails at insert** rather than corrupting
silently, because `graph_relation.from_id` is `REFERENCES graph_entity(id)` and
`PRAGMA foreign_keys = ON` on the production path (`index/local-index.ts:279`). That
changes the severity — it is a loud bug, not a data-integrity one — and the redundant
trailing paragraph was deleted.

Also recorded: `external_id = person.id` is not a free choice. `catchup.ts:324` matches
`pe.external_id = ?` against a person id, so any other encoding breaks a reader that is
already written.

## 4. Sentry `assignedTo` email validation — ACCEPTED, widened to both connectors

Split into three claims, which do not share a verdict:

| Claim | Verdict |
| --- | --- |
| Guard against a missing/`undefined` email | **Already specified** — § 5.5 required `type === "user"` with a non-empty `email`; a team actor or missing email emits nothing |
| Handle case-insensitivity | **No change needed** — `resolvePersonForSync` already lowercases via `normalizeEmail` (`people/linker.ts:44`). Adding a second lowercasing at the call site is duplicated logic that can drift |
| Validate the format | **Real gap, fixed** |

`normalizeEmail` (`people/person-store.ts:6-8`) is `raw.trim().toLowerCase()` — no
validation. `resolvePersonForSync` *creates a person row* for whatever it is handed, so
an actor payload carrying `"unknown"`, `"n/a"`, or a display name would mint a junk
person that pollutes every people-based brief and cannot be merged away. That is a
durable data defect, not a transient parse failure.

Two deliberate widenings beyond the review:

- **Applied to PagerDuty too, not just Sentry.** The review scoped this to
  `syncErrorIssueGraph` in PR 2. PagerDuty resolves emails on the identical path with
  identical exposure; guarding one connector and not the other would leave the same
  failure mode live. The guard lands in PR 1 and PR 2 reuses it.
- **Bounded quantifiers plus a pre-regex length check**, matching the house style at
  `updater/manifest-fetcher.ts:3` (`{1,256}`, not `+`). Grepped first — no existing email
  validator to reuse.

The § 8 test for it asserts on the **`person` table**, not merely on edge absence: the
failure being prevented is a row that outlives the sync, and an edge-only assertion is
green while the junk row is still written.

---

## Not raised by the review, found while responding

Test-item numbering in § 8 was duplicated (two 5s, two 6s) after the additions;
corrected to 1-8.
