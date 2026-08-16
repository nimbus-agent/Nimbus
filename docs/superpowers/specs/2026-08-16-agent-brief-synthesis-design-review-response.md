# Design Review Response: Agent Brief Synthesis (W6-A0)

Response to [the design review](./2026-08-16-agent-brief-synthesis-design-review.md) of
[the design](./2026-08-16-agent-brief-synthesis-design.md).

**Disposition: 4 fixed, 1 already specified, 0 deferred.** Two items exposed errors in the spec
rather than gaps in it, and both corrections are larger than the item that prompted them.

| # | Item | Disposition | Where |
| --- | --- | --- | --- |
| Q1 | Phrase guard resilience | ✅ fixed, **and widened** | §2.4 |
| Q2 | Timeout duration + config | ✅ fixed, **spec was wrong** | §2.6 |
| Q3 | Resolution timing | ✅ fixed (made explicit) | §2.2 |
| S1 | Rejection observability | ✅ intent kept, **mechanism rejected** | §2.7 (new) |
| S2 | `assertNever` exhaustiveness | ⚪ already specified | §2.4 |

---

## Q1 — Phrase guard resilience → fixed, and widened

**Accepted as stated.** The concern is real and the consequence is severe: without normalization, a
model that renders `_could not be computed_` as `*could not be computed*` fails the guard, *every*
synthesis is rejected, and the feature ships inert. That is the exact failure mode this whole
sub-project exists to correct (§1.1), so shipping a second instance of it would be poor. Normalized
matching — strip `_`, `*`, `` ` ``, collapse whitespace, case-insensitive — is now specified.

**Widened beyond the recommendation.** The review proposes "simple case-insensitive substring checks
on normalized text." Substring-over-the-whole-document has a hole. Verified at
`agents/_lib/render.ts:660,690,716,743,764,841,865`: each null `negotiate` lane renders as

```markdown
## PRs authored

_could not be computed_
```

Seven lanes therefore emit the *same* phrase. A document-wide substring check passes as long as
**one** survives — so a brief with six null lanes where the model dropped five disclaimers and kept
one would be accepted, and five lanes would read as measured when they were not. That is precisely
the property `negotiate`'s honesty contract exists to guarantee.

The guard is therefore **section-scoped**: each required phrase is checked under its own heading.
This is available for free because `SYNTHESIS_INSTRUCTIONS` already mandates "Keep all section
headings." A missing heading is itself a rejection, so deleting a whole section cannot pass a check
that only inspects sections that exist.

## Q2 — Timeout duration and config → fixed; the spec was wrong

**Accepted, and the review is more right than it argued.** Two errors surfaced on checking.

*First, an overclaim of mine.* §2.6 said an LLM call "would blow the latency budget the
`nimbus-agent-patterns` skill sets." That skill pins exactly one number — `why-peek`'s sub-300ms —
and sets no per-brief budget. There was no budget to inherit, which is why the review had to ask for
a number: none existed.

*Second, the framing was wrong.* Briefs are **fire-and-forget**. `emit-brief.ts:54` returns
`{ sessionId }` immediately and delivers the brief later by `briefReady` notification, so no caller
is blocked on synthesis. The timeout is therefore not a latency guard at all — it exists so a hung
provider yields a deterministic brief instead of a `briefReady` that never arrives.

**On the proposed 3–5s: rejected, in the safe direction.** That range suits a synchronous path.
Here it would reject nearly every synthesis on a cold Ollama — which the review itself identifies as
the risk ("slow local LLM startup/first-token latency ... permanently blocking synthesis on lower-end
hardware") — and a rejected synthesis is invisible by construction. Default is **20 s**, with
`[agents] synthesis_timeout_ms` configurable per the recommendation, so a user preferring a fast
deterministic brief can have one.

## Q3 — Resolution timing → fixed

**Accepted; the recommendation matches the existing mechanism.** `LlmRouter` already probes
availability on every `selectProvider` call (`llm/router.ts:103`), so per-invocation resolution is
its natural shape rather than added cost. Caching would be actively wrong on a local-first machine
where Ollama starts and stops under a long-lived Gateway — the review's reasoning exactly. §2.2 now
says "per invocation — never cached" rather than leaving it to be inferred.

## S1 — Rejection observability → intent kept, mechanism rejected

**The problem is real** — it restates a risk the spec raised against itself in §5, and it needed an
answer rather than a note.

**The proposed `logger.warn` does not fit this code.** Verified: there is no logger in this path.
`agents/_lib/emit-brief.ts` and the agent modules do no logging at all. Adding a logging dependency
to a fire-and-forget notification path, to carry a fact the caller should already be receiving, is
the wrong shape — and a warning in a gateway log answers "why is my brief still deterministic?" only
for someone already reading gateway logs.

**Fixed at the notification instead.** `emit-brief.ts:59` already emits
`{ sessionId, brief, findings }`; a fourth `synthesis` field now carries provenance and rejection:

```ts
synthesis:
  | { attempted: false; reason: "disabled" | "no_eligible_provider" }
  | { attempted: true; used: true;  model: string; remote: boolean }
  | { attempted: true; used: false; reason: "timeout" | "contract_violation" | "egress_append_failed";
      missingPhrases?: string[] }
```

`missingPhrases` gives the review's diagnostic goal directly — it names which contract the model
broke. Reusing the notification means the fact reaches the CLI, the HTTP surface and the Tauri
renderer with no new infrastructure, and it is the same `{model, remote, disclosure?}` shape §2.5
already adopts for the footer rather than a second vocabulary for one fact.

## S2 — `assertNever` exhaustiveness → already specified

No change. §2.4 already required it: `requiredPhrases` "dispatches over the same `SynthInput` union
`deterministicRender` does and reuses the `assertNeverBrief` exhaustiveness guard (`synthesize.ts`),
so a fifteenth brief kind is a compile error rather than an unguarded brief." Reusing the existing
`assertNeverBrief` is preferred over a new `assertNever`; its docstring records that the guard was
added after a missing arm silently rendered one brief kind as a `huddle` and reported itself to the
model as `agents.huddle`. The corresponding test row was already in §4.

---

## Not raised by the review, and still the open question

The judgement call most worth a second opinion is untouched by these five items: **§2.3 diverges
from I29's fail-closed convention.** Everywhere else an egress-append failure aborts the action;
here it falls back to the deterministic render. The argument is that a brief has a complete
non-egressing fallback that a connector dispatch does not, so nothing egresses either way and the
user gets a correct brief instead of an error. That reasoning has not been externally reviewed.
