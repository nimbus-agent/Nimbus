# Response to the pre-mortem PR A plan review

Four findings. **All four fixed; nothing deferred.** Finding 1 was a genuine blocker that would have
shipped a subsystem passing every one of its own tests while being unusable by the PR that consumes
it.

| # | Finding | Verdict |
|---|---|---|
| 1 | Service axis: connector vs affected | **Fixed** — new Task 5; plan was wrong |
| 2 | Labels that normalize to empty | **Fixed** — guard at the model boundary |
| 3 | Orphaned evidence rows accumulate | **Fixed** — prune sweep + confidence recompute |
| 4 | `occurredAt` defaulted to `0` | **Fixed** — omitted, and the type made optional |

Plan grew from 10 tasks / 50 steps to **11 tasks / 55 steps**.

---

## 1. Service axis — the blocker. Fixed, and the plan was simply wrong

The review is correct and this was the most valuable finding in either review round.

The spec is unambiguous: themes are keyed on the **affected** service — *"the recurring blockers for
`billing-api` serve every epic that touches it"* — and PR B's Lane 4 reads *"`premortem_theme` rows
whose service matches the cohort's services"*, where Lane 2 derives those from children → PRs →
repos.

My plan wrote themes under `item.service`, the **connector** (`jira` / `linear`). The consequence is
exactly as the review states: every Jira epic would share one undifferentiated theme set, and PR B's
lookup for `billing-api` would return zero rows — forever, silently, with PR A's entire test suite
green.

**The part worth calling out is not the mistake but the comment I wrote around it.** Task 6 carried:

> *"Service here is the connector service (jira / linear) that owns the row — the theme's service
> key. PR B maps a cohort's affected services separately; these are not the same axis and must not
> be conflated."*

That is an authoritative-sounding rationale for a wrong decision. It would have read to an
implementer as a deliberate, considered choice and actively discouraged them from questioning it —
worse than leaving the question open.

**The fix, and why it is bigger than a find-and-replace:** the affected-service derivation is a
graph traversal (epic → children via `metadata.parent_key` → incoming `resolves` edges → `in_repo`),
and it did not exist anywhere in PR A. It is now **Task 5**, `premortem/epic-services.ts`, with six
tests covering the happy path, multi-service merge, and all four ways the traversal can come up
empty.

Placing it in PR A turns out to be the better factoring regardless: PR B's Lane 1 (target services)
and Lane 2 (candidate services) call the same function, so the two halves cannot drift onto
different definitions of "service". Three further changes lock it in:

- `DiscoveredEpic` **has no `service` field at all** — the connector service is not merely unused,
  it is unavailable at the call site where the mistake would recur.
- `DiscoveredEpic` gained `epicKey`, since the traversal needs the ticket key children point at and
  it is not derivable from `itemId` for every connector.
- The Task 8 test `writes themes under the AFFECTED service, not the connector` asserts both halves:
  the theme is found under `billing-api` **and** absent under `jira`. A one-sided assertion would
  pass if themes were written under both.

## 2. Labels that normalize to empty — fixed

Correct. `normalizeThemeLabel("...")` returns `""`, and my guard was `label.trim() !== ""`, which
`"..."` passes. The result would be a theme keyed on the empty string, rendering as a blank bullet
in the brief.

Fixed at the **model boundary** in `extractThemes` — where untrusted output enters — rather than in
`upsertTheme`. Two reasons: the boundary is where every other validation of model output already
lives, and throwing from `upsertTheme` would abort an entire pass over one malformed label, losing
the good themes in the same batch.

The new test uses `"..."` and `"   "` alongside a valid label and asserts only the valid one
survives, so it pins the specific gap between `trim()` and `normalize()`.

## 3. Orphaned evidence rows — fixed, with the tradeoff recorded

Correct: `premortem_theme_evidence.item_id` has no foreign key to `item(id)` — items sync and prune
dynamically — so rows behind removed items would linger forever.

Added `pruneOrphanedEvidence(db)`, run at the start of the reconcile sweep, **before** demotion. It
deletes orphaned rows and **recomputes confidence** for every theme that lost one. That second half
matters more than the cleanup: confidence is derived from corroboration count, so leaving dead
evidence in place means claiming corroboration from epics the user can no longer inspect.

Ordering it before demotion also simplifies the demotion check to "no evidence rows left".

**One tradeoff I made explicit in the code comment rather than silently accepting.** An item pruned
and later re-synced *unchanged* keeps its original `modified_at`, so it lands behind the watermark,
is never re-mined, and its evidence does not return — that theme's confidence stays permanently
lower. I chose this over the alternative, which overstates corroboration in the common case to
protect the rare one. It is a real limitation and it is written down where the next reader will see
it.

## 4. `occurredAt` defaulted to `0` — fixed

Correct, and it violated a rule this very workstream established. #1128's ticket-depth contract is
explicit that a missing timestamp **omits its key** rather than writing `0`, so a consumer can tell
"unresolved" from "resolved at the epoch". `resolvedAtMs ?? 0` did precisely what that rule forbids.

Fixed one level deeper than the review suggested. Rather than only converting at the evidence write,
`DiscoveredEpic.resolvedAtMs` is now `number | undefined`, and the discover stage omits the key
entirely when the source supplied none — so the `0` cannot re-enter from any other call site. The
evidence write then spreads the field conditionally, and `occurred_at` stays NULL as the DDL always
allowed.

New test in Task 6: `a missing resolved_at_ms is absent, never 0`.

---

## What this changed structurally

- **11 tasks, 55 steps** (was 10 / 50). New Task 5; old Tasks 5–10 renumbered to 6–11, with every
  cross-reference in the Interfaces blocks and trap notes updated.
- `PremortemPassResult` gained `prunedEvidence`, so the three downstream result literals in Tasks 9
  and 10 were updated to match.
- The self-review section now carries an explicit statement that **"service" has exactly one meaning
  in this plan**, naming the earlier error so it cannot quietly return in PR B.

## What did not change

The task decomposition, the TDD step shape, and every prior decision from the design round —
no-model ⇒ no themes, demote-not-delete, the composite watermark, `[premortem]` gated on `enabled`,
`premortem.refresh` LAN-forbidden with no parameters and no rebuild.

Estimated size is slightly up: Task 5 adds roughly 40 source lines plus its tests, and the
prune sweep another ~30. Still comfortably PR-A-shaped.
