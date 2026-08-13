# `nimbus negotiate` Plan Review — Response

**Date:** 2026-08-12
**Responds to:** `2026-08-12-nimbus-negotiate-agent-review.md`
**Outcome:** 2 accepted, 1 accepted in a non-guessing form, 1 deferred with reasoning. Item 1's
investigation exposed a **plan defect that would have stopped Task 1 compiling**.

---

## 1. Synthesizer LLM fallback — **mechanism already exists; the test is accepted, and the question found a real defect**

**The fallback is robust, verified at `agents/_lib/synthesize.ts:132-154`.** `synthesize` renders
deterministically in all three failure shapes: no `llm` configured (`:134`), the model returning
`null` or empty (`:149`), and the model throwing (`:151-152`). So the agent does not fail without an
LLM.

**The suggested test is still worth taking** and is added to Task 1, because the no-LLM path is a
documented trap in this repo — the pre-mortem work shipped a pass that consumed its corpus
permanently when no Ollama was present. A mechanism existing is not evidence that this agent reaches
it.

**What the question actually exposed — a plan defect.** Checking the fallback surfaced that
`SynthInput` (`:52`) is a **closed union** and `deterministicRender` ends in `assertNeverBrief`
(`:99`), with `toolNameFor` (`:102`) the same shape. My plan never mentioned `synthesize.ts` at all.
As written, **Task 1 could not compile**, and had it somehow compiled, no Markdown would render — the
brief's Markdown being the entire deliverable.

Task 1 now has a step registering the brief with the renderer (union member, `deterministicRender`
case, `toolNameFor` case) plus a minimal `renderNegotiate`, and every lane task carries a banner
requiring it to extend that renderer — including that a `null` lane field renders as "could not be
computed", never `0`. That is the same registration-site-nobody-mentioned defect class as
`isItemLinkedGraphType` in the previous plan.

---

## 2. Malformed or unknown `personal_sources` — **ACCEPTED**

Two rules added to Task 6, both failing safe toward *excluding*:

- **Non-string and blank entries are dropped at parse time**, never reaching a query. Test:
  `["obsidian", "", 42]` yields `["obsidian"]`.
- **An unrecognised service needs no handling and must not throw.** The value is used in a bound
  `IN (...)` list, so an unconfigured service matches no rows — which is the correct outcome. A typo
  silently includes *nothing* rather than silently including everything. Test added proving a bogus
  name yields zero extra rows and no error.

The reviewer's alternative — a debug warning for unknown services — is not adopted: the lane cannot
distinguish "typo" from "connector not configured yet", and warning on the latter would be noise on
every run of a partially-configured index.

---

## 3. Unmapped git aliases for a `--person` subject — **ACCEPTED in a non-guessing form; the proposed heuristic is REJECTED**

The suggestion is to match `git:<email>` owner entities to the target person by name or email
substring and list them as "potentially unmapped aliases".

**Rejected as proposed.** This brief may influence someone's compensation. A substring heuristic that
guesses which git aliases belong to a person will sometimes be wrong, and a wrong attribution in this
document is worse than an acknowledged gap — it is the same failure as the undercount, with the sign
flipped. Two engineers at `a.smith@` and `a.smithson@`, or a shared `deploy@` bot carrying a person's
name in its label, are enough to produce it.

**Accepted in a form that states a fact rather than a guess.** Task 4 now counts `git:`-prefixed
owner entities in the index and surfaces it as `ownership.unmappedIdentitiesInIndex`, rendered as
"N git identities in this index are not mapped to a person; ownership attributed to them is not
counted here." That is a true statement about the index and tells the reader exactly what the
reviewer wanted them to know — that mapping is incomplete and worth fixing — without asserting
anything about whose work it is. The plan says explicitly not to add substring matching later.

The precise self-case gap (§ 5.A0) is unaffected: for the local user the git email is known from
`resolveSelfPerson`, so no guessing is involved there.

---

## 4. Index coverage for the JSON-parsing queries — **DEFERRED, with the fact recorded**

**Verified:** `item` carries indexes on `service`, `type`, `modified_at` and `resolve_key` — and
**not** on `author_id`. The reviewer is right that the reviewed-PR and writing lanes filter on an
unindexed column.

**Deferred because the fix is a migration**, which this plan forbids in its Global Constraints, and
slipping a schema change into an agent PR is how migrations arrive unreviewed. The lanes also narrow
hard on indexed columns first (`service = 'github' AND type = 'review'`) before any JSON parsing, so
the row set reaching `json_extract` is small on a personal index.

Recorded in Task 2 so the next reader knows the omission was deliberate: if profiling on a large
index shows a problem, an `item(author_id)` index is its own deliberate migration.

---

## Plan changes made

| Location | Change |
| --- | --- |
| Task 1, Step 9 (new) | Register the brief with `SynthInput` / `deterministicRender` / `toolNameFor`; add `renderNegotiate`; test the no-LLM deterministic path |
| Task 2 banner | Every lane task extends `renderNegotiate`; a `null` lane renders as "could not be computed", never `0` |
| Task 2 | Records that `item` has no `author_id` index and why no index is added here |
| Task 4 | Adds `unmappedIdentitiesInIndex` count; explicitly forbids substring alias matching |
| Task 6 | Drops non-string/blank `personal_sources` entries; unknown service names match no rows and must not throw |
