# Response to the W6-B.2 design review (2026-08-20)

Reviewing `2026-08-20-negation-in-ask-design-review.md`. Four items: three accepted (one of them
promoted well above the severity it was filed at), one accepted in its conclusion and rejected in
its code. Checking the fourth surfaced a bound the review did not raise and the spec did not state,
which is now § 7 of the design.

---

## Q1 — where the streamed disclosure chunk is emitted

**Location: accepted.** After the fork, inside the `try`, at the single site both paths return
through. That is what the design meant by "one place both dispatchers reach", and the review pins
it correctly. (Its `:213` anchor lands on the `} catch (e) {` line rather than the final `return`
at `:212`; the prose is unambiguous, so this is a note, not a correction.)

**Two mechanical fixes were applied to the review document itself**, because it would otherwise
fail CI rather than merely read oddly: its file reference was an absolute
`file:///C:/gitrep/Nimbus/...` link — the machine-specific form that passes `audit:links` locally
because the path exists on this machine and fails on a Linux runner, which has now happened on
three separate branches — and a numbered list was missing the blank line MD032 requires. Only those
two; no claim in it was edited.

**The proposed code: rejected, three defects.** It restructures the fork into a ternary:

```ts
const res = await (llmRouter !== undefined && shouldUseLocalRouter(p)
  ? runViaLocalRouter(llmRouter, promptArg, p)
  : runViaAgent(p.agent, promptArg, p, maxSteps));
```

1. **It deletes the local-router fallback.** Today `runViaLocalRouter` is wrapped in its own
   `try`/`catch`: on failure, if a Mastra agent exists, the turn logs
   `"local LLM router failed; falling back to agent"` and continues to `runViaAgent`. The ternary
   has no catch, so a router failure propagates and the turn dies where it currently recovers. This
   is a behaviour regression in code whose only job is to append a sentence.
2. **It does not compile under strict.** `p.agent` is `Agent | undefined`; `runViaAgent`'s first
   parameter is `Agent`. The current code narrows it with an explicit
   `if (p.agent === undefined) throw new Error("No conversational agent or local LLM router configured")`,
   which the ternary also deletes — so the "nothing is configured" case would reach Mastra with
   `undefined` instead of erroring.
3. **It reads where the review's own item B says drain.** `store?.negationDisclosures` leaves the
   array populated. See item B below; the two halves of the review disagree, and B is right.

**Corrected shape.** Keep the existing control flow *verbatim* — fallback, narrowing, error — by
extracting it unchanged into a helper, and wrap the one call:

```ts
const res = await runTurn(p, promptArg, maxSteps); // the existing fork, moved, not rewritten
return appendNegationDisclosures(res, p);
```

`appendNegationDisclosures` drains the store, and when the drain is empty returns `res` unchanged
(identity, as § 5.1 requires). The plan must state that the extraction is a pure move: if `runTurn`
differs from today's body by anything other than its signature, the diff is wrong.

**One claim in the review is stronger than the code supports.** It says this guarantees "streamed
chunks and the final returned reply are byte-identical". That is not a property this design
establishes, and it is not one it needs. On the Mastra path the reply is `await streamOut.text`
while the chunks are text deltas; on the router path a non-streaming provider emits the whole text
in one late chunk. Those normally agree in aggregate, but nothing enforces it and B.2 does not make
it true. What B.2 guarantees is narrower and sufficient: **the disclosure reaches both the stream
and the returned reply**, so neither surface can be missing it. The spec keeps that wording.

---

## A — `AsyncLocalStorage` propagation under Mastra

**Accepted, and promoted to the first task of the plan rather than a test at the end.**

The review is right that nothing proves this today, and it is more right than it claims. The
closest existing evidence, `agent.test.ts:788` ("recallSessionMemory: returns recalled chunks via
AsyncLocalStorage sessionId"), calls `tool.execute(...)` **directly** inside
`agentRequestContext.run(...)`. It proves the wrapper reads the store; it never goes through
`agent.generate`, so it says nothing about whether the store survives Mastra's own tool scheduling.
That is the "a test per side proves the ENDS, never the WIRE" shape this codebase has shipped
before.

**Why this outranks its filed severity: the failure mode is silence.** If the store does not reach
a Mastra-scheduled tool, `getStore()` returns `undefined`, the tool pushes nothing, the drain finds
nothing, and the turn returns a perfectly normal answer with no disclosure — which is
indistinguishable from a turn that had nothing to disclose. The whole mechanism would be inert and
every test that calls `execute` directly would still pass.

**So it is retired first, before anything is built on it:** a probe that drives a real
`agent.generate` with a tool that pushes a sentinel, asserting the sentinel arrives at the caller.
If it fails, the design needs a different carrier and the plan stops for a decision — noting that
the obvious alternative is worse than it looks: `createNimbusEngineAgent` builds its tools **once**,
not per turn, so a closure-held collector would be shared across concurrent turns and would leak
one turn's disclosures into another's answer. ALS is the right mechanism precisely because the
tools are long-lived and the context is not; that is why proving it is worth a task of its own.

---

## B — draining and isolation of the disclosure store

**Accepted; the spec now says drain normatively rather than descriptively.**

`inline-handlers.ts` builds a fresh `requestStore` per dispatch, so cross-request leakage is
already prevented — the review states this correctly. The residual it names is real though: the
drain must be a read-and-clear, so that anything reusing a store within one dispatch frame (a
sub-agent turn, a retry) cannot re-emit a disclosure already shown. Cheap to make true, and
impossible to reason about later if left as "read".

---

## C — explicit tool schemas

**Accepted; it is a plan-level detail, and the spec makes the parameter lists explicit so the plan
cannot invent them.** This restates D4 and D5 rather than changing them: `findPrsNotTouching` takes
`pathGlob` (required), `service` (optional) and `limit`, and deliberately exposes **no** `itemType`
— the type scope is intrinsic to the tool, which is D4's whole point. `findPeopleWithoutReviews`
takes `since` and `limit` and no `service`, matching `buildPersonListSql`, which has no service
dimension.

---

## The bound the review did not raise, now § 7 of the design

Checking Q1's fork raised a question neither document had asked: **which turns can reach an engine
tool at all?**

`shouldUseLocalRouter` (`run-conversational-agent.ts:57`) returns true when `llmRouter.prefersLocal()`
— that is, when `[llm].prefer_local = true`, the documented Ollama setup. That path calls
`llmRouter.generate({ prompt, systemPrompt, ... })`, and the router has **no tool-calling support
whatsoever**: the string `tools` does not appear anywhere in `packages/gateway/src/llm/`.

So on the local-router path there are no engine tools — not the negation tools, and not
`searchLocalIndex` either. This is pre-existing behaviour that B.2 neither introduces nor can fix,
but it bounds what B.2 may claim: **"negation in `nimbus ask`" is true for turns that run through
the Mastra agent, and structurally inert for a `prefer_local = true` user**, who reaches the
predicates only through `nimbus query` / `nimbus people list` (B.1) or an MCP client.

Left unstated, this is precisely the failure this project keeps catching after the fact: A0 found a
synthesis seam that had never run in production, and A1 found a mode inert on the UI dispatcher.
Both were shipped-and-believed before they were measured. The spec states the bound, and the
CHANGELOG and roadmap row will carry it in the same words.
