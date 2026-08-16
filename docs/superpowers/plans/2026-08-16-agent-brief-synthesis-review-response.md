# Plan Review Response: Agent Brief Synthesis (W6-A0)

Response to [the plan review](./2026-08-16-agent-brief-synthesis-review.md) of
[the plan](./2026-08-16-agent-brief-synthesis.md).

**Disposition: 2 fixed, 1 fixed-and-deferred-in-part.** Q1 exposed a defect in the plan far larger
than the item that prompted it.

| # | Item | Disposition | Where |
| --- | --- | --- | --- |
| Q1 | Automate red-proving | ⚠️ **suggestion declined; the defect it exposed is fixed** | Task 2 |
| Q2 | Abort hung LLM requests | ✅ verified real · ⏸️ deferred with the cost stated | Task 4 Step 3 |
| Q3 | DB lock resiliency + logging | ✅ fixed (both halves) | Task 4 Step 3, Task 5 |

---

## Q1 — Automating negative tests → suggestion declined, underlying defect fixed

**The proposed test already exists.** Task 2 Step 1 contained
`test("rejects when ONE of two identical disclaimers is dropped", …)`, which is the mirror image of
the suggested case — same fixture, same assertion, opposite lane. Adding it verbatim would have been
a duplicate.

**Red-proving is not replaceable by a negative test**, so it stays. The two catch different defect
classes:

- A *negative test* asserts the guard rejects bad markdown **given a working fixture**.
- *Reverting* asserts **the test itself can fail** — the case where the fixture is mis-cast,
  `requiredPhrases` returns `[]`, every "accepts" assertion passes **vacuously** (no requirements
  means nothing to violate), and the suite goes green over a guard that guards nothing. This repo
  has shipped six such tests in one PR; a green suite is not evidence.

Task 2 Step 5 now specifies **two** reverts with a named expected failure each, including one
(no-op `normalize`) that proves the reformatting test would catch the guard-rejects-everything mode
rather than passing incidentally.

### What the review actually surfaced, and it is the real finding

Pressing on the fixture exposed a genuine defect in the plan.

**`NegotiateBrief` has SEVEN nullable lanes, and `requiredPhrases` covered two.** Verified at
`negotiate-types.ts:103-109` — `authoredPrs`, `reviewedPrs`, `incidents`, `tickets`, `ownership`,
`decisions`, `writing` — each rendering its own `_could not be computed_` at
`render.ts:662,690,716,743,764,841,865`. As written, **five of seven lanes would have gone unguarded
in production while every test passed**, which is the exact class of failure the guard exists to
prevent, reproduced inside the guard.

Fixed: `NEGOTIATE_LANES` drives all seven, the fixture nulls all seven, and a **fixture-integrity
test** (`requiredPhrases(...).length === 7`) makes a mis-cast or a missed lane fail loudly instead
of quietly emptying the requirement set.

**A second defect fell out of the same check: heading matching was too strict.** `render.ts:789`
documents headings rendered as `## Ownership — services: checkout`. The plan's `sectionBody` did
normalized *equality*, so a suffixed heading would be reported as a **missing section** and would
reject an otherwise-correct synthesis. Now a normalized **prefix** match, with a test pinning it.

A third test was added for the inverse error: a **non-null** lane requires nothing. Guarding one
would force the disclaimer onto a lane that genuinely ran and measured zero — the "null is not `0`"
rule backwards, which is the property `negotiate` was built around.

## Q2 — Aborting hung requests → real, and deferred with the cost stated

**Verified, and the answer is the unwelcome one.** `LlmGenerateOptions` (`llm/types.ts:14-22`) has
**no** `signal` field. The only `AbortSignal` in the provider interface is on the optional
`pullModel` (`:46`), never on `generate` (`:43`). So the timeout abandons the promise and the
underlying request runs to completion — local CPU/GPU under `"local"`, **billable tokens** under
`"any"`. The review is right that this is a resource leak, and the recommendation's conditional
("if the router supports an `AbortSignal`") resolves to *it does not*.

**Deferred, not fixed.** Closing it means widening a shared type consumed by every provider
implementation and by the `nimbus ask` path — outside A0's blast radius, and it would make that task
the largest in the plan for a benefit that is bounded. Two things bound it: the default mode is
`"local"`, where the waste is local compute; and an abandoned remote call **still has its egress
row**, appended before the call, so the ledger stays accurate — its claim is that a request was
authorized and sent, which remains true whether or not anyone reads the answer.

Recorded in Task 4 Step 3 as a follow-up, with an explicit instruction **not** to paper over it by
shortening the timeout: a shorter timeout increases the number of abandoned-but-still-running
generations rather than reducing it.

## Q3 — Database lock resiliency and logging → both halves fixed

**On locking: no bespoke handling, deliberately.** Task 4 Step 3 now specifies the plain
`recordSynthesisEgress` call with no retry and no wrapping transaction, because it must behave
exactly as the three existing appenders do under contention — a divergent busy-handling policy in
one of four appenders is a worse outcome than a shared one.

**On the transaction concern specifically: none is open.** `buildBrief()` resolves before
`synthesize` is called (`emit-brief.ts:58-59`), so the brief's own reads are complete by the time
the append runs. A `SQLITE_BUSY` from a concurrent writer is therefore a normal failure, not a
self-deadlock.

**On distinguishing a database issue from a model issue: already designed, now with detail.** The
`SynthesisProvenance` type from the design review already separates `egress_append_failed` from
`timeout` and `contract_violation`, which is the distinction requested — and it travels on the
`briefReady` notification rather than into a gateway log, so it reaches the CLI, HTTP and Tauri
surfaces. The review is right that the reason alone lacks the *why*, so the failure arm gains an
optional redacted `detail` string carrying the SQLite error text.

---

## Still open, and still unreviewed

Unchanged from the design-review response: **spec §2.3 diverges from I29's fail-closed convention**
(an egress-append failure falls back to the deterministic render rather than aborting), and **spec
§2.3.2's narrowing of the `model` coverage class** — raised to `per-call` on a brief-synthesis
appender while embedding egress, which the class name also covers, remains unledgered. The second
was introduced after the design review and has had no external scrutiny at all.
