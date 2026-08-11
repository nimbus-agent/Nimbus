# GitHub Contribution Depth — Design Review Response

**Date:** 2026-08-11
**Responds to:** `2026-08-11-github-contribution-depth-design-review.md`
**Outcome:** 4 accepted (2 with corrections that make them stronger), 1 rejected on verified grounds,
1 accepted in reduced form.

Every item below was checked against the tree or vendor documentation before deciding. Two checks
surfaced problems larger than the review described; one check showed the review's premise was false.

---

## 1. Gap detection when Nimbus is off for >30 days — **ACCEPTED, with a correction that widens it**

The concern is valid and the underlying problem is **worse than the review states**.

`syncGithubUserEvents` (`github-sync.ts:492`) issues **exactly one request per tick** — `per_page=100`,
no pagination loop, no `page` parameter. So the binding limit is not the vendor's 300-event/30-day
ceiling; it is **the newest ~100 events between two successful syncs**. A user need not be offline for
30 days to lose evidence — a busy enough account, or any outage during which more than 100 events
accumulate, loses everything older than the newest 100, silently, well inside the vendor window.

A 30-day threshold as proposed would therefore give false assurance: it would stay quiet through
exactly the cases that lose data.

**What ships instead**, split by where the remediation exists (§ 5.H of the spec):

- **PR 1 — saturation logging.** A tick that parses a full page is direct evidence the window may have
  overflowed. Logged structurally via `ctx.logger`, matching how the sync already reports partial
  failures. Detection belongs where the loss happens, not on a timer.
- **PR 2 — staleness note.** `connectors/health.ts` already tracks `last_sync_at` /
  `lastSuccessfulSync`, so the suggested surface exists. It ships in PR 2 rather than PR 1 because its
  only useful remediation is `nimbus index backfill`, which does not exist until then. Telling a user
  about a gap they have no means to close is noise, not honesty.

The single-page behaviour is pre-existing and not introduced by this design, so widening the fetch to
paginate is deliberately **out of scope** here — it changes the sync's request profile and deserves
its own change. It is now recorded in § 2 as the real loss boundary rather than left implicit.

---

## 2. Distinguishing authorship from review in retrieval — **ACCEPTED as documentation; the suggested work is unnecessary**

The suggestion is to ensure agent queries filter by `author_id` versus the `reviewed` relation rather
than pulling `github:pr` items indiscriminately. Checked: **that distinction is already structural and
needs no new mechanism.** A colleague's PR row carries *their* `author_id`, so every query already
keyed on `author_id = me` excludes reviewed-only PRs for free — `catchup.ts:284` (`subOwnedServices`)
and `:305` (`subActiveRepos`) both do exactly this. The `reviewed` edge is a separate traversal
entirely.

One real downstream effect the review did not identify: `catchup.ts:364` `subWindowItems` selects
`FROM item WHERE modified_at >= ?` with **no author filter**, so colleague PRs the user reviewed will
begin appearing in `nimbus catchup`'s window.

That is recorded in § 4 as a known consequence and deliberately **not** mitigated. A PR you reviewed
is genuinely relevant to your day, and `scoreAndGroup` already ranks unrelated items down to
`SCORE_DEFAULT`. Suppressing reviewed PRs from `catchup` would be a product regression dressed up as
a scoping fix.

---

## 3. Duplicate/stale `reviewed` edges — **REJECTED: premise is false, and the proposed fix is unsafe**

**The premise does not hold.** `upsertGraphRelation` (`relationship-graph.ts:114`) is
`ON CONFLICT (from_id, to_id, type) DO UPDATE`. A dismissed review followed by a new review from the
same person on the same PR produces **one** edge, not two. Duplicate review relationships cannot be
displayed because they cannot exist. The review items themselves are distinct rows (distinct review
ids), but the edges collapse by construction.

**The proposed fix would introduce a bug.** "Delete all `reviewed` edges for a specific PR and
re-insert current ones" is unsafe inside PR 2's *quarter-bucketed* backfill: a delete-all keyed on the
PR, executed while processing one bucket, discards edges established by other buckets and re-inserts
only what the current bucket happens to contain. It is harmless today only because every `reviewed`
edge belongs to the local user (§ 3, "one direction only") — the moment a "who reviewed my PRs"
direction is ever added, with multiple reviewers per PR, it becomes real data loss. Adding a
reconciliation step that is safe only by accident, to solve a problem that cannot occur, is the wrong
trade.

**The genuine residual risk is narrower than the review frames it** and is already disclosed: a review
deleted *entirely* upstream leaves its edge behind, because `reviewed` joins
`CROSS_ITEM_RELATION_TYPES` and nothing retires it (§ 5.F). That is stated on the connector page
rather than engineered away. A test now pins the single-edge property, since skipping the retirement
mechanism rests on it.

---

## 4. Secondary rate limits — **ACCEPTED, confirmed by vendor docs, plus a second bug the review did not name**

Confirmed against GitHub's rate-limit documentation: a secondary limit returns *"either a `403` or
`429`"*, and `retry-after` is an independent signal — *"If the `retry-after` response header is
present, you should not retry your request until after that many seconds has elapsed."*

`throwGithubRateLimitErrorIfApplicable` (`github-sync.ts:366`) only honours `retry-after` when
`remaining === "0" || remaining === null` (`:373`). **A 403 carrying `retry-after` with a non-zero
`remaining` falls through to `return` at `:379`** and is not treated as rate limiting at all; the
caller sees a plain `!res.ok` and retries next tick. That is a live bug on the existing enrich path,
which PR 1 widens — so the fix lands in **PR 1**, with a red-proved test that fails against the
current handler.

**Second bug, found while verifying this one:** `penalise("github", ms)` (`:376`, `:384`) hardcodes the
bucket name. Calling this helper from a `github_search` context would penalise the *core* bucket and
leave the offending one unthrottled — the exact opposite of the separation § 5.D exists to provide.
The key becomes a parameter in **PR 2**, alongside the search path.

The review's alternative suggestion — an adaptive sleep inside the backfill loop instead of relying on
the rate limiter — is **not adopted**. `ctx.rateLimiter` already supports `penalise(bucket, ms)`,
which is the codebase's existing mechanism for exactly this; a bespoke sleep in one loop would be a
second, divergent throttling path. Fixing the two defects above makes the existing mechanism correct
rather than routing around it.

---

## 5. Test a third-party reviewer resolves to a distinct person — **ACCEPTED**

Added to § 6 as a required test: a review whose `user` differs from the PR's `user` must yield two
`person` entities, with `authored` and `reviewed` pointing at the same PR from different people.

This also **closes § 8's third open item**, which had flagged that `resolveGithubActorPersonId` has
only ever been exercised on the author path. Better as an assertion than an assumption.

---

## 6. Metric for missing stats — **ACCEPTED in reduced form: a log line, not a metric**

The signal is worth having. The form is not: a counter surfaced through `index.metrics` would need a
new metric registration for something relevant only during a transient catch-up window, and nothing
consumes it today.

PR 1 emits a structured `ctx.logger` line reporting the stats-missing backlog, matching how the sync
already reports partial state. If it is ever actually monitored, promoting it to a metric is a small
follow-up; building the metric first is speculative.

Independently, § 5.B already requires that **every aggregate in the brief carries its own coverage
count** (`over M of K PRs with stats available`), so the user-facing honesty property does not depend
on this signal at all — the log serves operators, not the brief.

---

## Spec changes made

| Section | Change |
| --- | --- |
| § 2 | Single-page fetch recorded as the real loss boundary; ~100-events-per-tick supersedes the 300/30-day framing |
| § 4 | New subsection: `catchup` window side-effect documented, explicitly not mitigated |
| § 5.D | Two rate-limit fixes specified — `retry-after` honoured independently (PR 1), bucket key parameterised (PR 2) |
| § 5.H | New: saturation logging (PR 1) + stale-connector note (PR 2) |
| § 6 | Three tests added — third-party reviewer, red-proved 403 handling, single-edge property |
| § 7 | File lists updated for both PRs |
| § 8 | Open item 3 struck, now covered by a test |
