# Response to the `nimbus pre-mortem` design review

Seven findings across four sections. **Six fixed in the spec, one deferred with reasoning
recorded.** No finding was rejected outright, and two of them were factual questions whose answers
changed the design rather than merely documenting it.

One of the review's assumptions was wrong in a way that matters (finding 5), and chasing another
one surfaced an **overclaim of my own** that the review did not catch directly (finding 6).

| # | Finding | Verdict |
|---|---|---|
| 1 | Monolith / shared-service dilutes the cohort | **Fixed** — IDF-weighted overlap |
| 2 | `max_candidate_scan` has no defined order | **Fixed** — `resolved_at_ms DESC` |
| 3 | Cycle time vs elapsed-so-far on a new epic | **Fixed** — expectation below 1 day |
| 4 | Read/memory bounds on the pass | **Fixed** — explicit columns + batching |
| 5 | `correlates_with` semantics undefined | **Fixed** — cited; review's premise corrected |
| 6 | Snippet fallback strategy | **Fixed differently** — the fallback cannot exist |
| 7 | Deleted watcher gets re-created | **Fixed** — fourth table, proposal record |
| — | Deterministic no-LLM theme discovery | **Deferred**, reasoning recorded |

---

## 1. Monolith / shared-service dilution — fixed

Correct, and the strongest finding in the review. Ranking by raw overlap count means a target
touching `api-gateway` matches nearly every closed epic, and the specific service that actually
characterises the work is drowned out.

Adopted **IDF-weighted overlap**: each service is weighted `log(N / epics_touching_service)` over
the scanned candidates, and a candidate scores the sum of the weights of the services it shares
with the target.

I took IDF over the review's other suggestions deliberately:

- **Over Jaccard** — Jaccard normalises by union size, which helps a little, but a ubiquitous
  service still contributes a full point of similarity. IDF attacks ubiquity directly, which is the
  actual failure mode named.
- **Over a configured exclusion list** — a service present in every epic earns a weight near zero
  *automatically*. A blacklist is one more hand-maintained table to drift; this repo's own
  body-depth connector list drifted three times before the lesson stuck ("derive it, do not trust a
  hand-written table"). Deriving the weight needs no config and cannot go stale.

## 2. Candidate scan ordering — fixed

Correct, and a genuine hole: I specified a cap with no order, so `max_candidate_scan` would have
truncated whatever SQLite happened to return first — neither recent nor stable across runs. Now
explicitly `resolved_at_ms DESC`, so the cap discards the *oldest* history.

## 3. Cycle time on a newly created epic — fixed

Correct. `elapsed_so_far ≈ 0` makes "47d vs 0d" read as an alarming overrun when it means nothing.
Below a target age of 1 day the risk is now phrased as an expectation ("comparable epics took a
median 24 days") and only above it as a comparison.

Worth stating plainly: because the roadmap's trigger is "when a new Epic is created", **the young
case is the common one, not the edge case** — this was a default-path bug, not a corner.

## 4. Read and memory bounds — fixed

Correct and cheap. `max_llm_calls_per_pass` bounded model calls but nothing bounded rows read, and
bodies run to 16 KiB since V48. The discover stage now selects only the columns it needs (never
`SELECT *`) and processes candidates in bounded batches, checkpointing the watermark per batch. A
background pass that degrades the interactive gateway would defeat the reason the work was moved off
the request path.

## 5. `correlates_with` — fixed, and the review's premise corrected

This was posed as an open question ("is there an existing schema, or is this time-proximity
based?"). It has a concrete answer, and the answer contradicts the suggestion attached to it.

`graph/graph-populator.ts` already populates the edge: a deployment pairs with an incident on the
**same affected service** within `CORRELATION_WINDOW_MS = 2 hours`, directed deployment→incident,
each side owning one direction of the clear-and-rebuild.

So the suggestion — *"define the exact time-window tolerance (e.g. within 24 hours of a deploy
associated with a child PR of the epic)"* — would have been a **second, conflicting correlation
rule**. Two things about the existing one differ from the review's mental model:

- The window is **2 hours, not 24**, and it is not mine to redefine here.
- Correlation is keyed on **service and time, not on any link to a child PR of the epic.**

That second point is the substantive one, and the spec now says it out loud: a busy shared service
will attract correlations from work unrelated to the epic. This makes incident coupling the sharpest
instance of the unconditional correlation-is-not-causation note, and the brief must not imply the
epic caused those incidents. Reuse the edge; do not invent a parallel rule.

## 6. Snippet fallback — fixed, but not as suggested

The review asked how verbatim snippets get identified and proposed a keyword heuristic
(`"block"`, `"delay"`, `"wait"`…). Checking `glossary`'s implementation to copy the precedent showed
the premise is unsound — **including mine.**

`glossary`'s `pickSnippetDefinition(term, snippets)` works because glossary **already has the term**
and only needs a definition for it; it picks a snippet mentioning that term and returns `retry` when
none qualifies. Pre-mortem has no candidate theme to look up — *discovery is the task*. There is
nothing to pick.

So my own spec was overclaiming: it advertised a "verbatim-snippet fallback when no local model",
which cannot exist as described. That was my error, surfaced by the review rather than stated in it.

Fixed by making the honest behaviour explicit everywhere: **no model ⇒ no themes**, said plainly in
the brief, with all five structural risks still fully computed. The failure-mode table already
covered this case correctly; the architecture diagram and test plan contradicted it, and now do not.

I did not adopt the keyword list. It would be hand-maintained, English-only, and — worse — would
fabricate a "theme" from a single incidental mention of the word "blocked", which is precisely the
kind of confident-but-baseless output the deterministic-scoring rule exists to prevent.

## 7. Deleted watcher re-created — fixed

Correct, and confirmed to be a real flow rather than a hypothetical: `watcher.delete` exists in
`ipc/automation-rpc.ts`.

Rules 1–2 alone would resurrect a watcher the user deliberately deleted. It would come back paused
and inert, so the blast radius is small — but it is still the tool overriding an explicit "no",
which undercuts the exact control that paused-on-create was chosen to preserve.

Fixed with the review's option 1, placed to avoid its cost: a fourth V53 table,
`premortem_watcher_proposal`, records every watcher id pre-mortem has proposed. An id **in that
table but absent from `watcher`** was deleted deliberately and is never re-created; the brief lists
it as suppressed with the command to un-suppress.

The table is needed because without a record of what was proposed, "never created" and "created then
deleted" are indistinguishable. Keeping it pre-mortem-owned — rather than the review's `enabled = -1`
sentinel — means no tombstone semantics leak into the shared `watcher` table that other subsystems
read.

---

## Deferred: deterministic no-LLM theme discovery

Recorded in *Explicitly out of scope* because it was actively considered, not overlooked.

A recurring-n-gram pass across the cohort would be a legitimate deterministic alternative to the
LLM — language-agnostic, frequency-grounded, and free of the keyword list's drift and
fabrication problems. It is genuinely attractive.

It is deferred because it is a **distinct discovery algorithm, not a fallback**: it would need its
own scoring, its own confidence treatment, and its own honesty rules about what an n-gram does and
does not mean. Bolting it on here would grow a design that is already `decisions`-scale, and the
no-model path is honestly served today by saying so and still delivering every structural risk.

---

## Net effect on scope

Findings 1 and 7 add real work — IDF weighting over the candidate set, and a fourth table with its
proposal/suppression logic. Findings 2, 3, 4 and 5 are clarifications that mostly *prevent* wasted
implementation. Finding 6 removes a component I had wrongly promised.

The estimate stands at roughly `decisions`-scale (~2,850 src lines), with the PR-A/PR-B split now
slightly more attractive since the migration grew a table.
