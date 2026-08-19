# Plan Review Response: PR changed-file indexing

Response to [`2026-08-19-pr-changed-file-indexing-review.md`](./2026-08-19-pr-changed-file-indexing-review.md).
Every item checked against the plan and the tree on 2026-08-19 before being accepted or declined.

**Outcome:** 3 accepted, 0 deferred, 0 rejected. Item 1 is the most valuable review finding this
project has produced: the plan as written would have shipped **nothing that runs**, with every task
green.

| # | Item | Outcome | Plan change |
| --- | --- | --- | --- |
| 1 | No sync-loop integration task | **Accepted — the plan was inert** | New Tasks 6 and 7 |
| 2 | Bitbucket pagination and envelope | **Accepted, resolved page-by-page** | Task 6 driver, Task 7 Step 3 |
| 3 | Per-candidate transaction isolation | **Accepted, pinned by tests** | Task 6 Steps 1 and 3 |

---

## 1 — the missing integration task: the plan produced no running code

This is correct, and it is worse than a missing task. Checked against my own plan:

- Task 1 — schema. No I/O.
- Task 2 — store. Writes only when someone calls it.
- Tasks 3 and 4 — **pure mappers.** `payload → ChangedFileRow[]`. No I/O.
- Task 5 — **pure selector and cap.** Reads candidates, trims an array. No I/O.

**Nothing anywhere issued an HTTP request or called `recordPrChangedFiles`.** Every task would have
passed its tests, `preflight` would have been green, the migration would have landed two empty
tables, and the feature would have been completely inert. `nimbus status` would have printed
`PR file coverage: 0 / 1203` forever, which reads as a backlog rather than as "this was never
wired".

**My self-review is what let it through, and it was wrong in a specific, repeatable way.** It
claimed "§ 5 fetch path → Tasks 3–5" — matching tasks to a spec section by *topic* rather than by
what makes the code run. Tasks 3–5 are all *about* fetching; none of them fetches. A spec-coverage
line has to name the task that executes, not the tasks that share the subject. That correction is
now written into the plan's self-review section rather than silently fixed, because the false line
is the artefact worth keeping.

**Two new tasks**, split where a reviewer could reject one and accept the other:

- **Task 6 — the shared driver plus GitHub.** `runPrFilePass(ctx, { service, fetchPage, nowMs })`
  owns the candidate loop, page accumulation, the cap, the coverage write and error containment.
  Each forge supplies only a `fetchPage` closure. This split is not tidiness: it means the loop —
  where every correctness property lives — is tested with a fake `fetchPage` and **no HTTP mocking
  at all**, while each forge task shrinks to a URL and a mapper call.
- **Task 7 — GitLab and Bitbucket wiring.**

Task 6 also carries a detail the review could not have known: the pass must be called at **both**
existing enrichment call sites, including the 304/unchanged path. `enrichPrDetail`'s own docstring
records that before it ran on the unchanged path, the backlog drained at roughly zero on a
low-activity account. Wiring only the changed path would reproduce a bug this repo already fixed
once.

---

## 2 — Bitbucket pagination: accepted, and the suggested answer is the right one

The question exposes a real ambiguity: my mapper takes a whole envelope, and the plan never said
whether pages are concatenated before or after mapping.

**Resolved as suggested — map each page, concatenate the mapped rows.** The driver accumulates
`ChangedFileRow[]` across pages and never holds more than one page of raw payload, so a
3,000-file PR does not build a large temporary JSON structure. This also keeps all three forges
identical from the driver's point of view despite their envelopes differing (GitHub and GitLab
return bare arrays; Bitbucket wraps in `values`), because the difference is absorbed inside each
`fetchPage`.

One correction the review did not raise but that follows from its question: **Bitbucket's
`hasMore` cannot be a length comparison.** GitHub and GitLab signal "maybe another page" with a
full-length page, but Bitbucket paginates with a `next` URL in the envelope. Task 7 Step 3 states
that explicitly, because copying GitHub's length check into Bitbucket would silently stop after
one page — and a PR truncated that way would still be *marked* truncated, so the bug would hide as
a coverage statistic rather than an error.

---

## 3 — per-candidate isolation: accepted, and now pinned by tests rather than by intent

Correct, and the plan only implied it. `recordPrChangedFiles` scopes its transaction per PR, but
nothing said the *loop* must not wrap them, and nothing tested it.

Task 6's driver now states it in the doc comment — the loop deliberately holds no transaction of
its own — and three tests enforce it:

- one candidate throwing does not stop the others, and does not roll back what was already written;
- a failed candidate gets **no coverage row**;
- a `null` page result is treated the same way.

The second is the one worth calling out, and it goes slightly beyond the review's ask. A failed PR
must not be recorded with an empty file set, because an empty coverage row asserts *"we checked
this PR and it touched nothing"* — a confident wrong negative, precisely the failure the coverage
table exists to prevent. Leaving it uncovered is what makes the selector re-queue it next tick.

One deliberate exception to "keep going": a rate-limit error still propagates and ends the tick.
Continuing to call a rate-limited API is worse than stopping early, and the existing
`runPrDetailEnrichmentBestEffort` already rethrows `RateLimitError` for the same reason.
