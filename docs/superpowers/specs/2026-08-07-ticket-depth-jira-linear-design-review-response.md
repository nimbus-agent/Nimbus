# Review response — Ticket depth (Jira + Linear), D1

Response to `2026-08-07-ticket-depth-jira-linear-design-review.md`. Every finding was checked
against the tree at `0a32751f` before being accepted or declined; the verification command is given
with each.

**Outcome: 1 fixed (and widened), 1 fixed, 1 already specified (clarified), 1 fixed in part with the
remainder explicitly deferred.**

---

## 1. The 30-day sync window — CONFIRMED, and the impact is larger than reported. **Fixed.**

The finding is correct and it is the most valuable thing in this review. Verified:

```
packages/gateway/src/connectors/jira-sync.ts:302    const initialSyncDepthDays = 30;
packages/gateway/src/connectors/linear-sync.ts:212  const initialSyncDepthDays = 30;
```

`jiraJqlFromCursor` cold-starts at `updated >= -30d` when `decodeCursor(null)` yields no floor, and
Linear cold-starts at `now − 30 × 86_400_000`. `rebody`'s own doc comment already classifies this
family of connector as bounded-window and warns that a Confluence `rebody` recovers ~30 days rather
than the whole wiki — documentation I had read past when I wrote the backfill section.

**Where the review understates it.** It frames this as historical rows keeping stale metadata. The
sharper consequence is that those rows are **largely not in the index at all**: since the very first
sync cold-started at the same 30-day floor, Nimbus has never ingested a Jira or Linear ticket that
was not updated within 30 days of connector setup or touched since. So this was never only a
backfill problem — no metadata backfill, however thorough, would have surfaced the closed epics
`pre-mortem` exists to analyze. D1 has to widen the corpus, not just enrich it.

**One more fact that shapes the fix**, found while checking the suggestion that `SyncContext` carry
a dynamic depth: `Syncable.initialSyncDepthDays` is declared at `sync/types.ts:52` and set by every
connector, but nothing outside `connectors/` reads it —

```
grep -rn "\.initialSyncDepthDays" packages/gateway/src --include=*.ts | grep -v "connectors/"   # empty
```

— and each connector uses its own local constant instead. The field is decorative, and no config
knob exists. So "allow the depth to be overridden" means wiring a consumer path that does not exist
today; it is not a matter of surfacing an existing one. Worth knowing before implementation, because
the obvious-looking change (set the field, expect it to take effect) would silently do nothing.

**Adopted, in the shape of the review's suggestion 1**: an optional `SyncContext.historyFloorMs`,
honored by Jira and Linear, set only by an explicit user-initiated re-walk via
`nimbus index rebody --since <days>`, defaulting to each connector's own constant so absent-flag
behavior is unchanged.

**Declined: suggestion 2's "fetch all historical items" / "unlimited".** An unbounded walk is the
exact shape most likely to trip the rate-limit behavior in finding 4, where an aborted run makes no
cursor progress — so "unlimited" degrades into re-fetching the same early pages forever on a large
account. A window the user names is a window the user can widen again.

## 2. Status-category normalization — VALID; the spec contradicted itself. **Fixed.**

Accepted, and the review caught a genuine internal inconsistency rather than a preference: the spec
asserted "both mappers write the same keys, so a consumer never branches on service" while storing
each platform's raw vocabulary under `status_category` — which would have forced exactly that
branch.

The normalized vocabulary is adopted as proposed (`todo` / `in_progress` / `done` / `canceled`),
with one addition the review did not include: `status_category_raw` keeps the platform's own value
alongside it, so normalization never destroys information (Linear's `backlog` vs `unstarted` stays
recoverable).

**And one correction to the proposed mapping table.** It lists `cancelled` as `Linear: canceled`
with no Jira column — true, but the reason matters and needs stating in the contract rather than
being left as a blank cell: Jira folds "Won't Do" / "Canceled" into the **`done`** status category,
with the distinction living in `fields.resolution`, which this PR does not fetch. A consumer
counting canceled work would therefore read zero for Jira and non-zero for Linear and conclude that
Jira teams never abandon epics. The spec now states that a Jira `done` means "closed, outcome
unknown", forbids cross-service cancel-rate comparison in `pre-mortem`, and records
`fields.resolution` as a scoped follow-up.

## 3. Linear parent vs project — ALREADY SPECIFIED. **No change; clarified.**

The requested behavior was already in the metadata contract: the `parent_key` row maps to
`fields.parent.key` on Jira and `parent.identifier` on Linear, so uniform parent→child linking
across both services was never dependent on `project_id`.

Since the review read it as ambiguous, the spec now says explicitly that `parent_key` and
`project_id` are independent and may both be present on the same Linear issue — `parent_key` for
plain hierarchy on either service, `project_id` only as Linear's epic-shaped grouping.

Related and already in the spec, worth re-flagging because it is the sharper version of this
concern: on **classic (company-managed) Jira projects**, `fields.parent` is not populated at all —
epic membership lives in a per-instance `customfield_100xx`, which this PR deliberately does not
chase.

## 4. Quota and rate limits — VALID; **fixed in part, remainder deferred.**

The concern is right to raise, and the answer is more specific than "verify the limiter is
respected". Verified behavior:

- Both syncs call `ctx.rateLimiter.acquire(service)` before walking; Jira raises `RateLimitError`
  mid-walk on a 429 (`jira-sync.ts:165`).
- `sync/scheduler.ts:656` catches it, transitions health to `rate_limited`, records aborted
  telemetry, and **returns without persisting a cursor**.

So a rate-limited backfill is **safe but not resumable**: upserted rows persist and nothing is
corrupted, but the cursor never advances, so the next tick restarts from the same cold floor and
re-fetches the same early pages. On a large account with a wide window the tail may never be
reached. That is a real answer to "won't cause sync aborts midway" — it *will* abort midway, and the
consequence is wasted quota rather than data loss.

**Fixed in D1:** `--since` takes an explicit bound rather than offering an unlimited mode, and
`rebody`'s report distinguishes a completed walk from one that ended rate-limited with no cursor
progress — a silent retry loop that looks like activity is the specific failure worth surfacing.

**Deferred:** making the walks resumable (persisting a partial cursor on abort) changes the
`SyncResult` contract every connector shares and is a general question about interrupted pagination,
not about ticket depth. It gets its own PR rather than riding along here.

---

## Net effect on D1

Scope grew by one seam — `SyncContext.historyFloorMs` plus `rebody --since` — which is a fair price
for the alternative being an agent that reports "no comparable epics found" on an index that was
never allowed to contain any. Still no migration, still no new item type. The consuming agent
inherits two more stated bounds: the history window actually indexed per service, and Jira's
outcome-blind closure.
