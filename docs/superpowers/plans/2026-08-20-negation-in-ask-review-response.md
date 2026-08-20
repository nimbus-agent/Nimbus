# Response to the W6-B.2 plan review (2026-08-20)

Reviewing `2026-08-20-negation-in-ask-review.md`. Both technical observations are correct and both
citations check out. One of them implies a plan change the review did not draw, and one parameter
in the sibling-tool specification is wrong in a way that would not have compiled against the
gateway. Acting on the review also surfaced a defect B.2 itself creates.

---

## 1A — no `inputSchema`, matching the existing tools

**Accepted, and it forces a plan change the review did not name.**

Verified: `grep -rn "inputSchema" packages/gateway/src/engine/*.ts` returns nothing. Every engine
tool is `createTool({ id, description, execute })` with hand-rolled narrowing inside `execute`, so
the plan is consistent with the codebase and should stay that way.

**The consequence:** with no input schema, a tool's **description and `toolGuidance` are the only
places the model learns what arguments exist.** That is how `fetchMoreIndexResults` does it — the
parameter list lives in `agent.ts`'s `toolGuidance` as
`fetchMoreIndexResults(service, indexedType, offset, limit)`, not in a schema.

The plan's drafted descriptions named `service` but never named `pathGlob`, so a model would have
had to guess the one required argument of the one tool that refuses without it. Task 3 Steps 3 and
5 now require every new tool to name its parameters in the same prose form as the existing six.
This is exactly the class of thing that ships and then reads as "the model is bad at using the
tool".

---

## 1B — provider independence in the Task 1 probe

**Accepted as a note, with one correction to the suggested fallback.**

The citation is right: `fakeConversationalAgent` exists at
`packages/gateway/src/engine/run-ask.test.ts:46`. The observation is right too — construction with
`model: "openai/gpt-4o-mini"` does not touch the network today, which is why `agent.test.ts` builds
agents that way and passes in CI with no key.

**But a fake `Agent` is the one fallback this step must never take.** Task 1 Step 6 exists to prove
that a tool *retrieved through a real Mastra `Agent`* still sees the request store. Substituting a
hand-built agent object removes the only thing under test and leaves a green test that proves
nothing — the "tests that cannot fail" shape this codebase keeps finding. `fakeConversationalAgent`
is right for `run-ask.test.ts`, whose subject is the caller, and wrong here, whose subject is
Mastra.

So the fallback ladder in the plan is now explicit: (1) real `Agent`, as drafted; (2) if
construction ever throws, a mock **model provider** passed to a real `Agent`; (3) if neither is
possible, the honest outcome is *"not provable in CI"* — which routes to the spec's § 5.1.1
fail-safe table, not to a fake that looks green.

---

## 2A / 2B — the sibling tool specifications

**Accepted, with two corrections.**

**Correction 1 — the strings need their backticks.** Production emits *"no `correlates_with` edges
are indexed…"* and *"no `reviewed` edges…"* with backticks around the edge type
(`ipc/diagnostics-rpc.ts`, `ipc/people-rpc.ts`). The review quotes them unbackticked. The plan says
to copy the refusal strings exactly because CLI tests assert on them, so this matters more than
typography.

**Correction 2 — `since` cannot be a duration string, and should not be an epoch either.** The
review specifies *"`since` (optional string/number duration)"*. A duration string like `7d` cannot
work: `parseSinceDurationToMs` lives in `packages/cli/src/lib/parse-since.ts` and **the gateway has
no duration parser at all** (`grep` for one returns nothing). Accepting `"7d"` would mean writing a
second parser inside the gateway — and B.1's own spec § 4.3 rejected exactly that, because two
duration parsers that disagree about `7d` is a silent correctness bug across two surfaces.

My own draft was no better: it took a millisecond epoch, which is what `people.list` wants but is a
hostile parameter for a model to compute correctly.

**Both are replaced by `sinceDays: number`** — days back from now, converted at the tool boundary
with `Date.now() - sinceDays * 86_400_000`. No parser, no epoch arithmetic in the model's head, no
second definition of what `7d` means. Omitted still means "ever", matching `people.list`'s
documented `sinceMs ?? 0` default.

---

## The defect acting on this review surfaced — and B.2 is what creates it

Both refusal remediations the review quotes are written in **CLI flag language**, because B.1 wrote
them for the CLI:

> "widen **`--since`** to include older reviews, or sync a connector that populates PR review
> activity and run `nimbus index regraph`"

B.1 was entitled to that phrasing: `--since` is exactly the right advice when the caller is
`nimbus people list`. **B.2 is what breaks it**, by routing that same string to two surfaces that
have no `--since`: a model answering in `nimbus ask`, and an external MCP client whose user may
never have touched the CLI. The remediation would tell them to widen a flag that does not exist
where they are — the same failure class this repo already has a scar from, where a gap note cited a
command that had not shipped.

Fixed at the single definition rather than per surface, so no second copy can drift: the
remediation becomes surface-neutral while keeping the CLI's advice concrete —

> "widen the time window (`--since` on the CLI, `sinceDays` on the tool surfaces) to include older
> reviews, or sync a connector that populates PR review activity and run `nimbus index regraph`"

This is the one place this delivery touches B.1's user-visible output, and it needs the two
assertions in `packages/cli/src/commands/people.test.ts:580,590` updated with it. It is recorded as
its own step (Task 2 Step 5b) rather than folded silently into the refactor step, whose whole
contract is that no existing test changes.
