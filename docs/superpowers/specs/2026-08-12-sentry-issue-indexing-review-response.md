# Sentry issue indexing — review response

**Date:** 2026-08-12
**Reviews:** [2026-08-12-sentry-issue-indexing-review.md](./2026-08-12-sentry-issue-indexing-review.md)
**Design:** [2026-08-12-sentry-issue-indexing-design.md](./2026-08-12-sentry-issue-indexing-design.md)

Five items. **Three accepted, one rejected on technical grounds, one deferred with the
blocking reason stated.** Every verdict below was checked against the tree or
primary-source documentation before being written; nothing here is accepted or refused
on plausibility.

| # | Item | Verdict |
| --- | --- | --- |
| 1 | Link-header regex is parameter-order-dependent | **Accepted** — measured, spec updated |
| 2 | Add a `project -> error_issue` graph edge | **Deferred** — `project` is not a graph entity type |
| 3 | Checkpoint the cursor on partial pagination failure | **Rejected** — silently loses data under a descending scan |
| 4 | Document how `initialSyncDepthDays` is overridden | **Accepted** — documented, and Sentry now opts into `historyFloorMs` |
| 5 | Document token scope and 403 behaviour | **Accepted** — `event:read` documented; per-project fallback deferred |

---

## 1. Link-header regex — accepted

The claim was that `/<([^<>]+)>;\s*rel="next"/` depends on `rel` appearing first among
the link-params. Measured against four header shapes:

| Header | Result |
| --- | --- |
| `<url>; rel="next"; results="true"; cursor="…"` (as Sentry documents it) | matches |
| `<url>; results="false"; rel="next"; cursor="…"` (same params, reordered) | **no match** |
| `<url>; rel="next"` (Mendeley, RFC-5988) | matches |
| two links, `previous` then `next` | matches |

Confirmed. One refinement to the reviewer's framing: the reordered case fails **closed** —
no match means "no next page", so pagination stops early and under-fetches rather than
looping. It is a data-completeness bug, not a runaway-request bug, which lowers its
severity but not its reality.

The reason to fix it anyway is compositional. Layering a `results` check onto an
order-dependent regex makes the *stop condition* order-dependent, and a pagination loop
that terminates correctly only when a third party emits parameters in a particular order
is the kind of defect that reproduces on nobody's machine.

**Change:** the design now specifies parsing each link-value into a URL plus a parameter
map and reading `rel` / `results` from that map, with `results` defaulting to `true`
when absent — which is what preserves Mendeley. A test asserting both `rel`-first and
`results`-first shapes was added to the test table.

## 2. `project -> error_issue` edge — deferred

**Blocking fact:** `project` is not in `ITEM_LINKED_ENTITY_TYPES`
(`graph/relationship-graph.ts:6-23`). `sentry:project` items — which this connector has
been writing since it was built — have **no graph entity at all**. There is nothing on
the other end of the proposed edge.

So this is not a populator addition. It means introducing a new entity type to a graph
model shared by every connector, several of which have a project-like concept
(GitLab projects, Jira projects, Vercel projects, Sentry projects) that would all
immediately raise the question of whether they converge onto one entity type or stay
distinct. That is a graph-model decision with reach well past Sentry, and Spec A is not
where it should be settled.

**What is not lost by deferring:** the design already stores the project slug in item
metadata, so per-project filtering and aggregation work today via ordinary indexed
queries. The edge would buy graph *traversal* from a project, which nothing currently
asks for.

Recorded as an explicit non-goal in the design rather than left unmentioned.

## 3. Cursor checkpointing — rejected

The observation is correct: a run that indexes pages 1-3 and fails on page 4 will
re-fetch pages 1-3 on the next tick. The proposed remedy would introduce **silent data
loss**, and it is worth being precise about why, because the intuition behind it is
sound in the ascending case.

The cursor is a high-water mark asserting *"everything with `lastSeen` greater than this
is indexed."* The scan is **descending** — newest first. After a failure on page 4:

- pages 1-3 (the newest slice) are indexed;
- everything older than page 3, down to the previous cursor, is **not**.

Advancing the cursor to the newest `lastSeen` observed would assert that the un-fetched
middle band is complete. The next run starts at that mark and never looks below it. The
band is gone permanently — no error, no retry, and no gap visible in any count derived
from it. For a substrate whose entire purpose is attributing work to people, an
undercount that cannot be detected is the worst available failure.

Re-fetching a bounded number of pages is the correct trade. `maxPagesPerSync` caps the
waste and the sync interval is minutes.

**Change:** the design now carries this rationale inline, at the point where an
implementer would be tempted to optimise it, along with the note that the *legitimate*
way to eliminate the rework is persisting Sentry's **opaque page cursor** to resume
mid-scan — a different design, requiring evidence about how long those cursors stay
valid.

> **CORRECTED 2026-08-12, after the Task 4 review (recorded here, not rewritten above —
> see the design doc's own `CORRECTED 2026-08-12` note for the full argument).** The
> "different design, requiring evidence" framing above is superseded: persisting the
> opaque resume cursor is not an optional follow-up, it is **required for correctness**.
> A descending scan's high-water mark cannot express "the page budget stopped here, not
> at end of data" — advancing it past a budget-truncated page silently drops every older,
> unfetched issue on every future run, not just the current one. The design doc's
> `resume` field is that fix, shipped in this PR
> (`packages/gateway/src/connectors/sentry-issue-sync.ts`). Do not read the paragraph
> above as license to defer resume-cursor persistence — it does not describe the shipped
> behaviour.

## 4. `initialSyncDepthDays` override — accepted

Answering the question as asked: it is a **hardcoded field on the `Syncable` interface**
(`sync/types.ts:117`). There is no `nimbus.toml` key for it. It is also unrelated to
`connector_depth`, which the reviewer offered as a candidate — that table governs *body*
depth (`metadata_only` / `summary` / `full`), not history window.

The one override that exists is `SyncContext.historyFloorMs`: a one-shot cold-start
floor the scheduler sets for a single run when the owner runs
`nimbus index rebody --since <days>`. It is opt-in per connector and today only
`jira-sync.ts` and `linear-sync.ts` read it.

**Change:** documented, and **Sentry now opts in**. An attribution substrate is precisely
the case the mechanism was built for — pulling more than 30 days once, without widening
every routine sync permanently.

## 5. Token scope and 403 — accepted, fallback deferred

Verified against Sentry's permissions documentation. The org-wide issues endpoint
requires **`event:read`** (or `event:write` / `event:admin`); a token holding only
`project:read` receives 403.

This is sharper than the reviewer framed it, and the sharp version is the dangerous one:
`event:read` is a *different scope from the one pass 1 needs*. An existing, working
Sentry install can take this connector version and have **pass 2 fail permanently while
pass 1 keeps succeeding** — the connector looks configured, syncs projects, and returns
zero issues forever.

Two related facts also now stated, because both look like bugs from outside:
Organization Auth Tokens cannot help (they are for source-map upload in CI, and an
existing one's scope is immutable), and a project-scoped token cannot reach the endpoint
at all.

**Change:** a "Token scope" section documenting the requirement and fixing the behaviour
— treat 403 as an ordinary non-OK response: warn naming the required scope, index
nothing, leave the cursor untouched.

**Deferred, and named rather than omitted:** distinguishing a permanent 403 from a
transient failure, and falling back to per-project listing. The consequence accepted
knowingly is that a mis-scoped token warns every interval and yields an empty
`error_issue` index with nothing surfaced to the user. Spec B's gap note is the right
place to make that visible, since it is the component that has to explain an empty
result.
