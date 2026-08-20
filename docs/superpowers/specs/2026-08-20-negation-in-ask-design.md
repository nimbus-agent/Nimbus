# Negation predicates on the model surfaces (W6-B.2) — design

**Date:** 2026-08-20
**Status:** Design approved in conversation, not yet implemented.
**Relationship to other work:** sub-project **B.2** of W6-B, the last open Wave 6 row. Built
directly on **B.1** (shipped 2026-08-20 as #1277), which put three negation predicates on
`nimbus query` / `nimbus people list`. B.1 is the precondition: there was nothing to expose until
the predicates and their fail-closed semantics existed.

---

## 1. What this is

The same three predicates B.1 shipped, reachable by a model:

| Tool | Answers | Scoped to |
| --- | --- | --- |
| `findPrsNotTouching` | PRs with no indexed changed-file path matching a glob | `item.type = 'pr'`, intrinsically |
| `findDeploymentsWithoutIncident` | deployments with no outgoing `correlates_with` edge | `item.type = 'deployment'`, intrinsically |
| `findPeopleWithoutReviews` | people with no outgoing `reviewed` edge newer than a cutoff | people |

On **two surfaces**, under the same three names, so there is one vocabulary rather than two:

- **the gateway engine** — Mastra tools in `engine/agent.ts`, reached by `nimbus ask` and, because
  they run the same engine, by the desktop app and the VS Code extension;
- **the MCP server** — `INDEX_TOOL_SPECS` in `packages/cli/src/mcp/adapter.ts`, reached by external
  MCP clients through the published `@nimbus-dev/mcp` launcher.

There is no predicate grammar, no `--negate`, and no composition, exactly as in B.1 § D1. Three
named tools, each carrying its own honesty story in its own description.

---

## 2. Why a model surface is a different problem from a flag

B.1's refusal is **structural**: an empty substrate means exit code `1`, a `missing_substrate`
document, and no rows. A user cannot miss it, because there is nothing else on screen.

Hand the same result to a model and every part of that guarantee becomes a request. The model can
paraphrase the refusal into a hedge, omit it, or — worst and most likely — route around it by
calling `searchLocalIndex` instead and answering the negation question from ranked results, which
is precisely the confident-wrong answer B.1 exists to prevent, now with a fluent explanation
attached.

So B.2 is not a wiring job. Two of its three sections are about what happens to a refusal after a
model has seen it.

---

## 3. Decisions taken (recorded so they are not relitigated)

**D1 — three named tools, mirroring B.1's three named flags.** One tool per predicate, not one
tool with a `predicate` enum. The enum shape saves a schema and costs the thing that matters: each
predicate's substrate story has to live in *some* description, and a shared tool has one
description for three different stories.

**D2 — both surfaces in one delivery, with unequal guarantees stated rather than blurred.** See
§ 5. The engine surface gets a disclosure the model cannot drop; the MCP surface cannot have one.
Shipping both is still right — the MCP half is nearly free once § 4 exists — but the delivery must
not describe them as equivalent.

**D3 — the orchestration is extracted, not duplicated.** See § 4.

**D4 — type scoping becomes intrinsic instead of validated.** B.1 § 4.5 makes `--type pr` mandatory
for `--not-touching` and errors on a conflicting type, because an unscoped negation returns every
issue, message and commit — none of which can touch a path. On this surface the tool *is* the
scope: `findPrsNotTouching` hardcodes `types: ["pr"]`, so the guard B.1 had to enforce cannot be
violated here. There is no `itemType` parameter to get wrong.

**D5 — `service` is OPTIONAL on the two item tools, and this is a deliberate divergence from the
CLI.** (`findPeopleWithoutReviews` takes no `service` at all — see § 10.)
B.1 requires `--service` on `nimbus query`, and its § 1 is explicit that this is *pre-existing
`runQuery` behaviour, not a choice that spec made*; cross-service negation was recorded there as a
follow-up because relaxing it would change an existing surface. These tools are a new surface, so
they inherit the semantics and not the accident: "which PRs don't touch tests" across every
indexed forge is the natural question for a model to ask. The CLI is untouched. Gap counts are
computed over the same scope the query used (B.1 already threads `gapScope`), so an unscoped count
describes an unscoped result set.

**D6 — no detector for negation-shaped questions.** Classifying a user's free-text question as "a
negation" is a guess about natural language, and a false positive attaches a scary caveat to a
correct answer. Steering is by tool description only, and the residual is recorded (§ 6).

---

## 4. The extraction: `index/negation-query.ts`

B.1 put the predicate *builders* in `index/negation-predicates.ts` (`probePrFileCoverage`,
`buildNotTouchingSql`, `countNotTouchingExclusions`, `missingSubstrateRefusal`, …) but left the
*sequence* inside the two IPC handlers — `rpcIndexQueryItems` (`ipc/diagnostics-rpc.ts`) and
`rpcPeopleList` (`ipc/people-rpc.ts`). That sequence is: probe the substrate → refuse if empty →
build the predicate → compose it with the base query → run → count exclusions → attach `explain`.

Three consumers now need it, so it moves into one module returning a discriminated result:

```ts
export type NegationOutcome<Row> =
  | { kind: "refused"; refusal: MissingSubstrateRefusal }
  | { kind: "ok"; rows: Row[]; gaps: NegationGaps; explain?: NegationExplain };

export function runNotTouchingQuery(...): NegationOutcome<IndexedItem>;
export function runNoDownstreamIncidentQuery(...): NegationOutcome<IndexedItem>;
export function runNotReviewedQuery(...): NegationOutcome<PersonRecord>;
```

**Wire-shaped validation stays in the RPC layer.** The `-32602` rejections B.1 added — non-string
`notTouching`, non-boolean `noDownstreamIncident`, `null`-reads-as-absent, both-predicates-supplied
— are about untrusted JSON-RPC records. The orchestrator takes typed arguments and assumes them
valid. Keeping the split this way is what stops the engine importing `DiagnosticsRpcError` and the
`{kind:"hit"}` outcome shape, which is the coupling that made "just call the dispatcher in-process"
the wrong answer.

**The two RPC handlers keep their own tests.** They cover the wire contract, which the orchestrator
tests do not. The orchestrator gets its own tests for the sequence.

**The MCP tools do not touch this module.** They call `index.queryItems` / `people.list` over IPC
and inherit the orchestration through the handlers, exactly as every other tool in
`INDEX_TOOL_SPECS` does.

---

## 5. The disclosure, and the asymmetry between surfaces

### 5.1 Engine surface — structural

A new `engine/negation-disclosure.ts` owns one definition of each disclosure sentence, derived from
the refusal/gap data rather than re-authored beside it (the `agents/_lib/brief-disclosures.ts`
shape: one definition, two readers).

Flow:

1. A negation tool, having refused or having excluded rows, pushes its sentence onto a
   lazily-created array on the **existing** `agentRequestContext` store (`engine/agent-request-context.ts`).
   Lazy creation matters: `ipc/server/inline-handlers.ts` builds that store in **two** places
   (`engine.ask` at :96 and the `engine.askStream` dispatcher at :350), and a field that had to be
   initialised at both would eventually be initialised at one.
2. `runConversationalAgent` (`engine/run-conversational-agent.ts`) drains the array and appends the
   sentences to the reply **at the single site above the router-vs-agent fork** — the mirror image
   of where `applyDevilAdvocate` and `applyPersona` go in. Both paths return `{ reply }` through
   that one function, so neither can be missed.
3. On the streaming path the model's text has already been sent to the client by then, so the same
   text is also emitted through `p.sendChunk` before returning. **The streamed answer and the
   returned answer must be byte-identical**; a disclosure present in `reply` and absent from the
   stream would mean the desktop app shows a different answer from the CLI. This is the two-
   dispatcher trap that made `--devil` inert on the UI path until it was caught.
4. When nothing fired, the function is the identity. A default turn's reply must not move.

**Fires on two conditions, matching what the CLI prints:** a refusal, and a non-zero exclusion
count. B.1's gap line prints on every negation query precisely because exclusion accounting is part
of the answer, not debug output.

**One precision this design must not overstate.** Unlike invariant I31, where reserved sections are
withheld from the model entirely, here the refusal *is* also in the tool result the model sees — it
has to be, or the model will answer anyway. The guarantee is therefore **not** "the model never saw
it and so cannot drop it". It is: *a verbatim copy reaches the user regardless of what the model
does with its own copy.* Anyone extending this later should keep that distinction; it is the
difference between a structural guarantee and a stronger one we do not have.

### 5.2 MCP surface — refusals structural, exclusion counts not

The append lives in the gateway engine. An external MCP client never goes through it: it calls
`tools/call`, receives JSON, and what its model does with that JSON is beyond our reach — no system
prompt of ours, no persona, no append hook.

Verified rather than assumed: `@nimbus-dev/mcp` **cannot** close this. The launcher spawns
`nimbus mcp-server --stdio` with `stdio: "inherit"` (read at `30e06981^:packages/mcp-launcher/src/index.ts`
before its extraction to the satellite repo). It is a pure exec, not a proxy; the MCP stream runs
directly between client and gateway. Making it a proxy would mean parsing the MCP wire protocol
inside a wrapper whose entire value is that it does not.

Nor is there a client of ours to strengthen: VS Code and the web clipper do not speak MCP (VS Code
reaches the gateway over IPC, through the engine, so it already receives the append). Every actual
MCP client is third-party.

So the guarantee splits, and the split is narrower than "MCP is unprotected":

- **Refusals are structural on both surfaces.** A refusing tool returns *only* the refusal — there
  are no rows alongside it — so an MCP client cannot present a confident answer while dropping the
  caveat. There is nothing else in the payload to present.
- **Exclusion counts are guaranteed only on the engine surface.** A successful query returns rows
  plus `gaps`, and a client's model can report the rows and omit "12 excluded". On `nimbus ask` the
  append makes that impossible; on MCP nothing does.

The CHANGELOG and the roadmap row must state this at that granularity. A feature named "negation
in ask and MCP" that implies one guarantee across both would be the same overclaim this row was
written to correct.

---

## 6. Steering away from the wrong tool, and what stays open

`searchLocalIndex`'s description gains one sentence: that it ranks and returns matches, cannot
answer which items do **not** match, and that the negation tools — which prove their substrate
before answering — are the ones for that.

**The residual is real and is not closed by this design.** A model can ignore the description,
call `searchLocalIndex` for a negation question, and produce a fluent wrong answer with no
disclosure attached, because no negation tool ran and so nothing was recorded. D6 rules out the
detector that would catch it. This goes in the spec, the CHANGELOG and the roadmap row as a known
open bound — not as a limitation implied by silence.

---

## 7. Scope boundary — what B.2 does NOT do

- **No grammar, no `--negate`, no composition.** Inherited from B.1 § 8. Two predicates cannot be
  combined in one tool call; each tool stands alone.
- **No new IPC method.** The tools reuse `index.queryItems` and `people.list`. `ALLOWED_METHODS`
  stays at **105** and no Tauri allowlist change is needed.
- **No schema change.** All three predicates read tables and edges that already exist.
- **No egress-ledger row, on either surface, and this is a scope fact rather than an omission.**
  Engine tools append nothing for two independent reasons, and both should be understood: the
  tools read local SQLite and never reach `connectors.dispatch`, so the executor chokepoint sees
  nothing; and `engine.ask` is not an `agents.*` brief method, so the agent-brief append path — the
  one whose fail-closed rule sends a CLI-originated call to zero rows — never considers it at all.
  MCP *index* tools have never been ledgered either
  — only `AGENT_CLASSIFIED_TOOL_SPECS`, which serve gateway-synthesised briefs, are, and that is
  the documented rule for which list a tool belongs in. The three new MCP tools serve index rows,
  so they go in `INDEX_TOOL_SPECS` and append nothing, exactly like the six index tools already
  there. I29's coverage classes are deliberately narrow; this delivery does not widen them.
- **No change to `nimbus query` / `nimbus people list`.** B.1's surface is untouched, including its
  mandatory `--service` (D5).

---

## 8. Testing

- **The seam, not the ends.** The test that matters drives a real `ask` turn through **both**
  dispatchers and asserts the disclosure appears in `reply` **and** in the streamed chunks. A test
  per side proves two ends and can leave the wire dead — this codebase has shipped exactly that
  (both sides of an IPC seam faked, feature inert, nine reviews passed).
- **Identity when nothing fires** gets its own test: a turn with no negation tool call must return
  a byte-identical reply.
- **Refusal and exclusion paths** per tool, asserting the disclosure text is *derived* from the
  orchestrator's output rather than a second copy of the sentence.
- **Orchestrator tests** for the extracted sequence; the two RPC handlers keep theirs.
- **MCP adapter tests** in the existing pattern. `adapter.test.ts` pins `TOOL_SPECS` at **18**; it
  becomes **21**. `mcp-server.ts` derives its counts from the arrays, so only the test pin moves.
- **Every guard red-proved by reverting it** and confirming the test goes red. Observing green
  proves nothing about a guard.
- Coverage floor: every touched file ≥85% line AND ≥80% branch.

---

## 9. Verified against the tree while writing this spec

- Engine tools call `deps.localIndex` **directly** (`engine/agent.ts:114` `searchLocalIndex`), not
  the IPC handlers — which is why § 4's extraction is required rather than optional.
- Every engine tool result is enveloped by the wrapper at `engine/agent.ts:45`
  (`wrapToolOutput`), so **I11 needs no new work** and the new tools inherit it.
- `runConversationalAgent` returns `{ reply }` from both the local-router and Mastra-agent paths
  (`engine/run-conversational-agent.ts:172`), with `applyDevilAdvocate`/`applyPersona` applied at
  `:189` — the symmetric inbound site § 5.1 mirrors.
- `agentRequestContext.run(...)` is established at `ipc/server/inline-handlers.ts:96` and `:350`
  (two sites, hence the lazy array).
- `INDEX_TOOL_SPECS` at `packages/cli/src/mcp/adapter.ts:377`; `TOOL_SPECS` at `:476`;
  `AGENT_CLASSIFIED_TOOL_SPECS` carries the "gateway-SYNTHESISED output ⇒ ledgered" rule that
  places the new tools in the index list.
- `adapter.test.ts:906` asserts `TOOL_SPECS` has 18 entries.
- The launcher is a pure exec (`stdio: "inherit"`), read from
  `30e06981^:packages/mcp-launcher/src/index.ts`; `@nimbus-dev/mcp@0.2.0` is published from the
  `nimbus-agent/nimbus-mcp` satellite repo, so **B.2's MCP tools ship with the gateway and need no
  launcher release**.
- `ALLOWED_METHODS.len()` asserts **105** at `packages/ui/src-tauri/src/gateway_bridge.rs:594`.

---

## 10. Open questions

One recorded for the plan to answer against the tree rather than by assumption:

1. **Where exactly the streamed disclosure chunk is emitted** — inside `runConversationalAgent`
   after the fork returns, or by the caller. It must be one place that both dispatchers reach; the
   plan should name the line rather than the function.

**A second open question was closed while writing this section rather than deferred.** It asked
whether `findPeopleWithoutReviews` needs a `service` parameter. It does not, and D5's optional
`service` does not apply to it: `buildPersonListSql` (`packages/gateway/src/people/person-store.ts:306`) filters only on
`linked` and the injected `idInSql`, and takes no service dimension — a `person` row spans services
by construction, which is the point of the people graph. The tool therefore takes `since` and
`limit` only. Recorded here rather than silently dropped, because a reader comparing the three
tools will notice the asymmetry and should find the reason.
