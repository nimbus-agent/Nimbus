# Plan Review Response: Agent Personas (A2)

Response to [`2026-08-18-agent-personas-a2-review.md`](./2026-08-18-agent-personas-a2-review.md).
Each item was checked against the tree before being accepted or declined.

**Outcome:** 2 accepted, 1 accepted in part — and one defect the review did not name but led
directly to, which was the most serious finding of the round.

| # | Item | Outcome | Plan change |
| --- | --- | --- | --- |
| Q1 | `warnedIssues` test pollution | **Accepted** | Task 1 step 5 — `beforeEach` reset |
| — | *(found via Q1)* the warning path is dead in production | **Fixed** | Task 5 step 3 — boot-time logger call |
| S1 | Widen the D6 omission regex | **Accepted in part** | Task 2 — 4 phrases added, 3 rejected, new guard test |
| S2 | Centralise provenance attachment | **Accepted, different mechanism** | Task 4 step 4 — one wrapper, not nine edits |

---

## Q1 — `warnedIssues` test pollution: accepted

Correct, and it is the plan's bug rather than a hypothetical. `persona.test.ts` asserts
`warnings.length === 1` against a module-scoped `Set` that nothing clears, so the test passes
only while it is the first thing in the file to use `tone = "tree"`. A later test using the
same bad value, or a reordering, breaks it — and breaks it confusingly, since the failure
would read as "the warning didn't fire" rather than "something already warned."

There was a louder signal in the plan that I missed: it exported
`resetPersonaWarningsForTest()` and then never called it. An exported test helper with no
callers is a straightforward smell.

`beforeEach(() => resetPersonaWarningsForTest())` added to Task 1 step 5, with a comment
saying what it protects against.

---

## The defect Q1 led to: the warning never fires in production

Not raised in the review, found while checking Q1's blast radius, and worse than Q1 itself.

`resolvePersona(configDir, logger?)` warns only when a logger is passed. In the plan as
written, **both** call sites deliberately passed none — `run-ask.ts` (Task 3 step 5) and
`agent-synthesis-runner.ts` (Task 4 step 6), each because warning on every turn or every
brief would be noise. That reasoning is right. What was missing is the consequence: no third
site passed one either, so the `logger !== undefined` branch was unreachable in production.

The design review's Q2 was accepted specifically so a typo like `tone = "tree"` would not
silently yield neutral behaviour. The plan would have shipped that fix **inert** — an
`OrWarn` loader that never warns, with a unit test proving the branch works and nothing
reaching it. That is the "gate justifications cite things that never run" shape: a defense
that tests green and does nothing.

Fixed in Task 5 step 3, which already touches `assemble.ts`: a single boot-time
`resolvePersona(paths.configDir, syncLogger)` whose only purpose is the warning, with a
comment stating that it is the sole logger-passing site and why the other two do not pass
one. Task 5 was retitled and its Interfaces block updated, since it now wires two things
rather than one. A "wiring completeness" paragraph was added to the plan's self-review to
make this class of check explicit rather than incidental.

The two wirings turn out to share a theme worth naming: `ProfileManager` was declared and
dispatched but never constructed, and the persona warn path was written but never reached.
Both are the same defect class, and landing them together keeps it from surviving the branch.

---

## S1 — widen the D6 omission regex: accepted in part

Split, because three of the proposed additions would have made the guard reject correct
directives.

**Rejected: `avoid`, `without`, `cut`.** These are register words, not omission words. "Avoid
jargon" and "without contractions" are precisely the instructions D6 **permits** — they
constrain how something is said, not whether it is said, and a `casual` or `formal` directive
would naturally be phrased that way. Adding them would fail the guard on a legitimate
rewrite. `cut` is worse than useless: bare `\bcut\b` matches ordinary prose with no relation
to omission at all.

The distinction D6 draws is between *expression* and *content*. A pattern that cannot tell
"avoid jargon" from "avoid listing gaps" is not enforcing D6, it is enforcing a word ban.

**Accepted: `ignore`, and `do not (include|show|list|mention)`.** These are object-qualified
or unambiguous — none of them reads naturally as a register instruction. Added.

**Also added, and the more valuable half:** a test asserting that register instructions still
**pass** the pattern:

```ts
expect("Avoid jargon; prefer plain words.").not.toMatch(OMISSION_PATTERN);
expect("Write formally, without contractions.").not.toMatch(OMISSION_PATTERN);
```

Without it, a future well-meant "hardening" of the pattern along exactly the lines this review
proposed would break legitimate directives, and the only signal would be Task 2's other tests
failing for a reason nobody would connect to the regex. The guard now pins both directions.

**A bound stated rather than papered over.** A regex denylist is incomplete by construction,
and no amount of widening changes that. The actual guarantee is that `TONE_DIRECTIVES` and
`VOICE_DIRECTIVES` are a closed, reviewed set of eight strings; the pattern is a tripwire on
careless future edits, not a proof. The plan now says so in a comment rather than implying
the regex is the safety mechanism.

---

## S2 — centralise provenance attachment: accepted, with a different mechanism

The concern is right, and understated. The plan said "several" arms and named five. The real
count is **nine** provenance return sites in `synthesize()`. A missed arm is also *silent* —
the brief still renders correctly; only the correlation between a discard and the persona
that provoked it goes missing, which is the single thing the field exists to provide. So the
failure mode is an observability hole that no test would notice unless it happened to cover
that exact arm.

**The proposed mechanism does not fit this function.** The review suggests post-processing
"right before it is returned". There is no such point: `synthesize()` returns from nine
places, each constructing its provenance inline. Creating a single exit would mean a
control-flow refactor of a file that is I31-load-bearing — a bad trade for an observability
field.

**What was done instead** achieves the same one-site goal without touching the control flow:
rename the existing function to `synthesizeInner` and add a thin exported wrapper.

```ts
export async function synthesize(brief, opts = {}): Promise<SynthesisOutcome> {
  const outcome = await synthesizeInner(brief, opts);
  const persona = opts.runner?.persona;
  if (persona === undefined || !outcome.provenance.attempted) return outcome;
  return { ...outcome, provenance: { ...outcome.provenance, persona } };
}
```

One site, every current and future arm covered by construction, no return site edited, no
call site changed. `attempted: false` arms are skipped deliberately — `disabled`,
`no_eligible_provider` and `reserved_extraction_failed` are all reached before the model is
prompted, so no persona was in force and reporting one would claim otherwise.

This also removes the "likeliest snag at execution" the plan's own handoff note called out.
That note is now obsolete and has been dropped.
