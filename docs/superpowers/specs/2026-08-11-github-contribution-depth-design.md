# GitHub Contribution Depth — Design

**Date:** 2026-08-11
**Spine slot:** S1 (Local Brain)
**Position:** sub-project A/B of the `nimbus negotiate` workstream — the first of five substrate
pieces, ahead of the agent itself.
**Ships as:** two PRs, neither requiring a migration, a new invariant, or a Tauri allowlist change.
**Plan boundary:** the implementation plan that follows this spec covers **PR 1 only**. PR 2 reuses
PR 1's writers unchanged and gets its own plan once PR 1 has merged — planning both at once would
bank assumptions about writers that do not exist yet.

---

## 1. Why this exists

`docs/roadmap.md:1121` specifies `nimbus negotiate` as a compensation-conversation prep brief
assembled from nine named evidence sources. Every one was checked against the tree before any design
work. **Four do not exist, two are partial, and three are real.**

| Claimed input | Verdict | Evidence |
| --- | --- | --- |
| PRs merged (count) | ✅ real | `item type='pr'`, `author_id` resolved across github/gitlab/bitbucket |
| PRs **reviewed** | ❌ dead | `reviewed` declared at `graph-v7-sql.ts:33`; **no populator writes it**. `graph-populator.ts` emits 16 relation types; `reviewed` is not among them. `ownership.ts:192` already states "no reviewer data" as a standing gap note. |
| PR **complexity** | ❌ not indexed | `extractPrMetadataForIndex` (`github-sync.ts:70`) captures number/repo/state/draft/merged/user/labels/mergeable/merged_at/merge_commit_sha. No additions, deletions, or changed_files. |
| Incidents resolved, attributed | ❌ dead | `pagerduty-sync.ts:96` writes `authorId: null`; metadata carries status/incidentId/opened_at/service/severity/urgency only. `gap-notes.ts:76` calls `person -> incident "resolves"` **"a future"** edge. `catchup.ts:328`'s incident lane returns empty today. |
| Deploys triggered, no rollback | ❌ dead | `deployment/types.ts` `DeploymentAnnotateInput` has **no actor field** and no rollback concept. |
| ADRs authored | ⚠️ derivable | `decision_record` has no author column; `source_item_id` → `item.author_id` joins. |
| On-call shifts | ❌ dead | `pagerduty-sync.ts` calls `/incidents` only. The PagerDuty MCP connector exposes no schedule tool either. |
| 1:1 themes | ⚠️ undefined | No "1:1" concept exists; the "asks before reading" consent mechanism does not exist. |
| `--peer-benchmark` comp ranges | ❌ blocked by design | No federated comp primitive exists, and `workday-field-allowlist.ts` **deliberately excludes compensation**. Building it means reversing a privacy decision already made. |

The decision (2026-08-11) was to **widen the substrate before writing the agent**, and to land all
five substrate pieces. This spec covers the first.

### Workstream decomposition

Agreed order: **A/B → C → F → D → E**. Every PR has a live reader the day it merges, which is
specifically a response to how pre-mortem PR A shipped a substrate that turned out unreachable.

| # | Sub-project | Migration | Reader on merge day |
| --- | --- | --- | --- |
| **A/B** | **GitHub contribution depth (this spec)** | No | Yes — `expert.ts:283`, `why.ts:319` query `reviewed` and get nothing today |
| C | Incident attribution (PagerDuty assignee/resolver + `person --resolves--> incident`) | No | Yes — `catchup.ts:328`, dead today |
| F | The `negotiate` agent | No | — |
| D | On-call shifts (new endpoint, new item type) | Likely | The agent |
| E | Deployment actor + rollback (cross-repo; rollback is a new concept) | Possibly | The agent |

---

## 2. Verified constraints

Everything below was checked against the tree or against vendor documentation. Nothing here is
asserted from memory.

**The GitHub events feed is capped, and Nimbus reads less of it than the cap allows.** Per GitHub's
REST documentation: *"The timeline will include up to 300 events. Only events created within the past
30 days will be included."* Private events are included because the sync authenticates as the user
(`fetchAuthenticatedLogin`, `github-sync.ts:461`).

But the vendor ceiling is not the binding one. `syncGithubUserEvents` (`github-sync.ts:492`) issues
**exactly one request per tick** — `per_page=100`, no pagination loop, no `page` parameter. So the
practical window is **the newest ~100 events between two successful syncs**, not 300. In steady state
at a 60-second interval that is ample; after an outage, or for a very active account, everything
older than the newest 100 events is lost permanently and silently, well inside the 30-day vendor
window. This is pre-existing behaviour, not introduced here, but it sets the real loss boundary and
§ 5.H exists because of it.

Consequence: **incremental accumulation works, retroactive backfill does not.** A gateway running for
a year holds a year of evidence; a fresh install holds nothing. A comp cycle is quarterly or annual,
so PR 1 alone cannot serve the use case — hence PR 2.

**Review events are silently discarded today.** `processEvent` (`github-sync.ts:318`) handles exactly
`PullRequestEvent` and `IssuesEvent`. `PullRequestReviewEvent` falls through to `return false`.

**PR stats exist on pull detail and nowhere else.** Per GitHub's documentation, the single-PR response
carries `additions`, `deletions`, `changed_files`, `commits`; the list response does not.
`enrichFallbackPrTitles` (`github-sync.ts:425`) **already fetches pull detail and discards them**.

**Search can reach arbitrary history.** `reviewed-by:`, `author:` and `merged:>=` are supported with
no documented history limit. Limits: **30 requests/minute** for search (a distinct budget from core)
and **1,000 results per query**.

**`rebody` cannot help here.** `REBODY_REQUIRED_META_VERSION` (`index-rebody-rpc.ts:134`) is the
existing mechanism for recovering new metadata on already-indexed rows, and its own docstring says
"a later depth PR adds a row here; it does not add a mechanism." But it works by clearing the sync
watermark, and a cleared GitHub etag still only replays 30 days. **GitHub is a third cost category
the `rebody` docstring does not model: bounded by the source feed, and unable to complete.**

**Three clobber traps, each verified:**

1. **Metadata is replaced wholesale.** `item-store.ts:130` — `metadata = excluded.metadata`. Storing
   reviewers in PR metadata would be destroyed by the next `PullRequestEvent` for that PR, and vice
   versa. Ordering-dependent, intermittent, and invisible to correctness tests.
2. **Graph edges touching a PR are cleared on re-population.** `clearRelationsTouchingEntity`
   (`graph-populator.ts:83`) deletes every edge touching the entity except
   `CROSS_ITEM_RELATION_TYPES` = `["resolves", "mentions", "correlates_with"]` (`:77`). `reviewed` is
   not in that list, so `syncPrGraph:240` would delete the edge on every PR re-population, and
   `syncPrGraph` cannot re-create it because reviews live in a different item.
3. **`synced_at` is overwritten on every upsert.** `item-store.ts:131` — so `MIN(synced_at)` drifts
   forward and cannot mark when Nimbus started watching. Neither `scheduler_state` nor `sync_state`
   records a first-sync time.

**A graph entity with no backing item is invisible.** 14 non-test sites inner-join `item` on
`entity.external_id` — `why.ts:222`, `why-peek.ts:71`, `catchup.ts:327`, `premortem.ts:153`,
`decision-corroborate.ts:146` among them. An edge pointing at an item-less entity is written,
queryable in principle, and dead in practice.

**Free-form types, per-service depth.** `item.type` is `TEXT NOT NULL` with no constraint
(`unified-item-v3-sql.ts:19`), and `applyDepth` reads `ctx.depth`, which is per-service. A new
`review` type under `github` therefore needs no migration and no depth registration.

**`github:pr` is not prose-heavy.** `PROSE_HEAVY_TYPES` has 23 entries; `github:issue` is present,
`github:pr` is not. PR bodies cap at 512 characters and stay on the local MiniLM route.

**`index.*` long-running jobs are CLI-only.** Only `index.metrics` appears in the Tauri allowlist;
`index.rebody`/`reembed`/`regraph` do not. `NO_TIMEOUT_METHODS` has exactly 5 entries, none of them
`index.*`.

---

## 3. Architecture

### PR 1 — "Accumulate forward" (events + enrich)

Two independent channels into the existing index. No migration, no new IPC, no allowlist change.

**Channel 1 — reviews as first-class items.** `processEvent` gains a `PullRequestReviewEvent` branch.
Reviewers are deliberately **not** stored in PR metadata (trap 1). Each review becomes its own row:

- `service='github'`, `type='review'`
- `external_id = <repo>#<pr-number>#review-<review-id>`, where `<review-id>` is GitHub's own review
  id from the event payload — not the PR number, and not a hash. Two reviews by the same person on
  the same PR are distinct rows.
- `author_id` via the existing `resolveGithubActorPersonId`, which already upserts through
  `resolvePersonForSync` — no new person plumbing
- body = the review's own text, at GitHub's configured depth

The same branch also calls the existing `upsertPr` on the event's `pull_request` payload, so the edge
targets a real, titled PR (see § 4).

The populator gains `syncReviewGraph` plus one branch in the `row.type` chain (`graph-populator.ts:780`),
emitting `person --reviewed--> pr` via `upsertGraphRelation` only. One review is one edge, so it is
idempotent with nothing to retire. **`"reviewed"` is added to `CROSS_ITEM_RELATION_TYPES`** — without
it, trap 2 deletes the edge on every PR re-population.

**Channel 2 — PR stats.** `extractPrMetadataForIndex` captures `additions`, `deletions`,
`changed_files`, `commits` when present: a no-op on the events path, free on the enrich path. The
enrich predicate (`selectFallbackPrCandidates:397`) widens from "title is the exact `PR #<n>`
fallback" to "fallback title **or** stats missing", still bounded by `MAX_ENRICH_PER_TICK = 10`.

### PR 2 — opt-in search backfill

A separate, user-triggered path in a new `connectors/github-backfill.ts`: quarter-bucketed
`author:@me` and `reviewed-by:@me` searches calling PR 1's `upsertPr` and `upsertReview` **unchanged**.
A different source, not a different shape.

A new `ipc/index-backfill-rpc.ts` mirrors `index-rebody-rpc.ts`: `index.backfill` plus
`backfillProgress` / `backfillDone` / `backfillError` / `backfillCancel` over `LongRunningJobRegistry`.
Params are strictly validated the way `rebody`'s `--limit` is, because they bound real API requests
rather than local CPU.

CLI: `nimbus index backfill --service github [--since <duration>] [--limit N] [--dry-run] [--yes] [--json]`,
alongside `add` / `reembed` / `rebody` / `regraph`.

### Scope property — one direction only

`/users/{login}/events` returns events performed **by** the authenticated user, and `reviewed-by:`
finds PRs reviewed by a named person. Both PRs therefore deliver **"PRs I reviewed"**, never
**"who reviewed my PRs."** The latter needs per-PR review listing — a different endpoint and a
different design. For a self-advocacy brief the first direction is the useful one, but it must be
stated so nobody expects the second. A consequence worth noting: **every `review` row is authored by
the local user.**

---

## 4. Decision: reviewing a PR indexes that PR

A review event carries the full `pull_request` payload, and a PR you reviewed is usually not yours.
Three options were weighed.

**Rejected — emit the edge against an item-less PR entity.** Disqualified on the merits: 14 sites
inner-join `item` on `entity.external_id`, so the edge would be invisible to every existing reader
including `why`, one of the two this work exists to light up. That is the shipped-but-unreachable
shape again, and the brief could only ever print `repo#number`.

**Rejected — index the PR at metadata-only depth** (`body: ""` + `bodyTruncated: true`, mirroring
`applyDepth`'s metadata_only arm at `item-store.ts:200`, which works through the depth chokepoint
rather than bypassing it). It buys a partial privacy improvement — bodies excluded, titles still
indexed and searchable — and pays with a **false promise**: those rows land at `body_complete = 0`,
and because `github` is in `REBODY_IMPROVABLE_SERVICES` (`index-rebody-rpc.ts:263`), `nimbus index
rebody` would report them as recoverable and then never recover them. Suppressing that needs a
carve-out in `computePendingByService`, i.e. new complexity in a carefully-reasoned subsystem.

**Chosen — reuse `upsertPr` verbatim.** Simplest change, consistent with every other PR row, no new
special case, no `rebody` wart, zero additional egress (the payload is already in a response we
fetched). The cost is that colleagues' PR descriptions enter the index and `nimbus decisions` will
mine them — bounded by `github:pr` not being prose-heavy, so bodies cap at 512 characters and stay
off the OpenAI embedding route.

Volume supports this: PR 1 only ever sees PRs the user personally reviewed inside a rolling 30-day
window. The place colleague-PR volume genuinely matters is PR 2's backfill over arbitrary history,
and that stays behind an explicit opt-in.

**Paired with a disclosure rather than a mechanism:** the GitHub connector page and, later, the
`negotiate` brief state plainly that reviewing a PR indexes that PR — matching how `ownership`
carries its unconditional "authorship is not accountability" note.

### Downstream effect on `catchup`, documented not mitigated

Distinguishing "PRs I wrote" from "PRs I reviewed" needs **no new mechanism**: a colleague's PR row
carries *their* `author_id`, so every query already keyed on `author_id = me` — `catchup.ts:284`
(`subOwnedServices`), `:305` (`subActiveRepos`) — excludes reviewed-only PRs for free, and the
`reviewed` edge is a separate traversal.

One query is not author-scoped and will change behaviour: `catchup.ts:364` `subWindowItems` selects
`FROM item WHERE modified_at >= ?` with no author filter, so colleague PRs the user reviewed will
begin appearing in `nimbus catchup`'s window. That is arguably an improvement — a PR you reviewed is
genuinely relevant to your day — and `scoreAndGroup` already ranks unrelated items down to
`SCORE_DEFAULT`. It is recorded here so it lands as a known consequence rather than a surprise, and
deliberately not "fixed": suppressing reviewed PRs from `catchup` would be a product regression
dressed as a scoping fix.

---

## 5. Error handling & honesty

**A. Coverage is stated from content dates, never sync dates.** `synced_at` is overwritten on every
upsert (trap 3), so the brief reports the observed range — `MIN(modified_at)` / `MAX(modified_at)`
over contributing GitHub items, plus the item count — and never asserts completeness for any
sub-window.

**B. Stats coverage is reported, not assumed.** Enrich converges at ≤10 PRs/tick, so at any moment
some PRs have stats and some do not. Every aggregate carries `over M of K PRs with stats available`;
a total computed over a 60%-covered set and printed bare is a lie by omission. Silent when coverage
is complete — a conditional note, following `decisions`' truncated-source count rather than a
standing disclaimer readers learn to skip.

**C. The 1,000-result cap never truncates silently.** If a quarter bucket's total exceeds 1,000,
subdivide to months; if a month still exceeds it, **report that bucket as truncated with its count**
rather than returning the first 1,000 and implying completeness.

**D. Search gets its own rate-limit bucket, and the 403 handler needs two fixes.** 30 req/min for
search is a distinct budget from core's hourly limit. Sharing `ctx.rateLimiter.acquire("github")`
would let a backfill starve the 60-second freshness sync and vice versa, so backfill acquires on
`github_search`.

`throwGithubRateLimitErrorIfApplicable` (`github-sync.ts:366`) cannot be reused unchanged, for two
separate reasons found while reviewing:

1. **It misses secondary rate limits.** GitHub's documentation states a secondary limit returns
   *"either a `403` or `429`"*, and treats `retry-after` as a signal independent of
   `x-ratelimit-remaining`: *"If the `retry-after` response header is present, you should not retry
   your request until after that many seconds has elapsed."* The current handler only honours
   `retry-after` when `remaining === "0" || remaining === null` (`:373`); a 403 carrying `retry-after`
   with a non-zero `remaining` falls through to `return` at `:379` and is not treated as rate
   limiting at all. The caller then sees a plain `!res.ok` and retries on the next tick. Fix: honour
   a present `retry-after` regardless of `remaining`. **This is a live bug on the existing enrich
   path, so it lands in PR 1**, whose widened predicate increases exposure to it.
2. **The penalised bucket is hardcoded.** `penalise("github", ms)` (`:376`, `:384`) names the bucket
   literally, so calling this helper from a search context would penalise the core bucket and leave
   the offending one unthrottled. Fix: take the bucket key as a parameter. Lands in PR 2 with the
   search path.

**H. A saturated tick is logged; a stale connector is surfaced.** Because the events sync reads a
single page (§ 2), evidence loss is silent by construction. Two signals, split by where the
remediation exists:

- **PR 1 — saturation.** A tick that parses a full page of events is evidence the window may have
  overflowed. Log it structurally via `ctx.logger`, matching how the sync already reports partial
  failures. Detection belongs where the loss happens.
- **PR 2 — staleness.** `connectors/health.ts` already tracks `last_sync_at` /
  `lastSuccessfulSync` per connector, so a "GitHub last synced N days ago; review evidence in that
  window is unrecoverable from the events feed" note has a natural home. It ships in PR 2 rather
  than PR 1 because its only useful remediation is `nimbus index backfill`, which does not exist
  until then — warning a user about a gap they have no way to close is noise, not honesty.

**E. Backfill resumes by idempotence, not by cursor.** Every write is an upsert on a deterministic
`external_id`, so a cancelled or failed run converges on re-run. No new cursor state; the cost of
repeated API calls on resume is stated in the command output rather than engineered away.
`--dry-run` reports the bucket plan and estimated request count before spending quota, matching
`rebody`.

**F. The stale-edge limit is stated, not hidden.** Because `reviewed` joins
`CROSS_ITEM_RELATION_TYPES`, no re-population retires it and nothing else does. A review dismissed or
deleted upstream leaves its edge behind. Documented on the connector page; not worth a retirement
mechanism at this volume, but not silent either.

**G. A bad event skips, never throws.** A malformed review payload, a missing `pull_request` object,
or an unresolvable actor returns early. Throwing out of `processEvent` would abort the tick and stall
the etag cursor; the existing branches return `false` rather than throwing, and the new one matches.

---

## 6. Testing

**The headline test is reachability, not existence.** `reviewed` has been declared since V7 and never
emitted, and an item-less entity is invisible to 14 readers. So the test that matters asserts through
the real query path in `expert.ts:283` / `why.ts:319`, not a hand-rolled `SELECT`. A test that only
checks for a `graph_relation` row would pass in every world where this feature is still dead.

**Red-prove the `CROSS_ITEM_RELATION_TYPES` change.** Review event → `PullRequestEvent` for the same
PR → assert the edge survives. Then remove `"reviewed"` from the list and confirm the test goes red.
Without that step there is no evidence the line is load-bearing rather than decorative.

**Red-prove the widened enrich predicate.** A PR with a good title but no stats must be selected;
under the old predicate it would not be, so the test should fail against the unmodified selector.

**Seed through real writers.** Follow `graph-populator-resolves.test.ts`: `LocalIndex.ensureSchema`
on `:memory:`, then `upsertIndexedItem`. No hand-rolled `INSERT INTO graph_entity` — fixtures that
invent their own row shape hid three separate defects in the pre-mortem work, including a query that
returned nothing in production while six tests passed.

**Connector tests reuse the existing harness** — `createMemoryIndexDb`, `syncTestContext`,
`describeWithFetchRestore`, `urlFromFetchInput` from `connector-sync-test-helpers.ts`; stubbed fetch,
no network. Cases: a well-formed review event; a malformed payload skips without throwing (guarding
G's etag-stall mode); an events payload lacking stats produces no stats keys and no crash; a
pull-detail payload captures all four stats.

**A third-party reviewer resolves to a distinct person.** A review whose `user` differs from the PR's
`user` must produce two separate `person` entities, with `authored` and `reviewed` pointing at the
same PR from different people. This closes § 8's third open item — `resolveGithubActorPersonId` has
only ever been exercised on the author path — and is the single test that proves the edge means what
the brief will claim it means.

**A 403 carrying `retry-after` with non-zero `x-ratelimit-remaining` raises `RateLimitError`.** Red-
prove it: the test must fail against the unmodified `throwGithubRateLimitErrorIfApplicable`, which
returns early in exactly that case (§ 5.D).

**Two reviews by one person on one PR yield one edge, not two.** `upsertGraphRelation` is
`ON CONFLICT (from_id, to_id, type)` (`relationship-graph.ts:114`), so this is already true — the
test pins it, because the safety of skipping any edge-retirement mechanism (§ 5.F) rests on it.

**PR 2 adds:** bucket subdivision when a period exceeds 1,000; a truncated bucket is reported rather
than silently capped; `github_search` acquired as a distinct key; `--dry-run` issues zero requests.

**Gates, per branch and not per session.** `bun run preflight:fast` after every change. The
Linux-authoritative coverage floor before pushing: neither `github-sync.ts` nor `graph-populator.ts`
appears in `docs/structure-audit/coverage-baseline.json`, so both already clear the 85% line / 80%
branch floor and have **no ratchet headroom** — new untested branches create a new violation rather
than eroding existing debt. And `bun run typecheck:tests`, reading the "N new" line, because it is
advisory on Windows and gating on CI-Linux and these PRs add test files.

**Deliberately not here:** no agent e2e test and no HITL-free structural assertion — there is no
agent until sub-project F.

---

## 7. Files touched

### PR 1

- `packages/gateway/src/connectors/github-sync.ts` — `PullRequestReviewEvent` branch; new
  `upsertReview`; stats capture in `extractPrMetadataForIndex`; widened enrich predicate + rename;
  `throwGithubRateLimitErrorIfApplicable` honours a present `retry-after` regardless of
  `x-ratelimit-remaining` (§ 5.D fix 1); saturation log when a tick parses a full page (§ 5.H).
- `packages/gateway/src/graph/graph-populator.ts` — `"reviewed"` into `CROSS_ITEM_RELATION_TYPES`;
  new `syncReviewGraph`; one dispatch branch.
- Tests: `github-sync.test.ts`, `github-sync-enrich.test.ts`, new `graph-populator-reviews.test.ts`.
- Docs: GitHub connector page + `docs/CHANGELOG.md` (connector deliveries go in the changelog, not
  the CLAUDE.md status line).

### PR 2

- New `packages/gateway/src/connectors/github-backfill.ts`.
- New `packages/gateway/src/ipc/index-backfill-rpc.ts` + IPC registration.
- `packages/cli/src/commands/index-cmd.ts` — `nimbus index backfill`.
- `packages/gateway/src/connectors/github-sync.ts` — parameterise the penalised bucket key
  (§ 5.D fix 2).
- `packages/gateway/src/connectors/health.ts` — stale-connector note (§ 5.H).
- Docs: `docs/cli-reference.md` + `docs/CHANGELOG.md`.

---

## 8. To confirm at plan time

Deliberately left open rather than guessed, since each is a vendor-response detail that the repo's
hand-authored fixtures cannot settle:

1. The exact `PullRequestReviewEvent` payload shape in the user-events feed — specifically that it
   carries both `review` (with a stable id) and a full `pull_request` object.
2. The search response fields carrying the result total and any incomplete-results flag, which
   § 5.C's truncation reporting depends on.
3. ~~Whether `resolveGithubActorPersonId` behaves correctly when a review's `user` differs from the
   PR's `user`.~~ **Closed by review (2026-08-11)** — now covered by a required test in § 6 rather
   than left as an assumption.
