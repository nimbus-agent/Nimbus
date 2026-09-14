# Design Review: `nimbus explain last` (X-ray of the most recent `nimbus ask`)

**Target Spec:** [`2026-09-14-nimbus-explain-last-design.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/explain-last/docs/superpowers/specs/2026-09-14-nimbus-explain-last-design.md)  
**Review Date:** 2026-09-14  
**Review Status:** Detailed findings, open questions, structural edge cases, and suggested improvements.

---

## 1. Executive Summary

The design for `nimbus explain last` is conceptually elegant and addresses a genuine observability gap in `nimbus ask`: making the mechanical retrieval, ranking, and routing pipeline transparent to the user without adding schema migrations, egress classes, or external network reach.

The design's key strengths:
1. **Accurate Diagnosis of Score Formula Divergence (§2.2):** Recognizing that the primary probe uses hybrid RRF min-max normalization while secondary passes use FTS rank normalization, and mandating per-pass attribution and non-comparability disclosures.
2. **Correct Route Discrimination (§4.2):** Explicitly distinguishing between empty-index guidance, local-context retrieval, Mastra agent tool-calling, and plan dispatch.
3. **Sound Security & Locality Boundary (§3.1):** Structurally excluding `explain last` from LAN, external tokens, Tauri allowlist, and external agents, preserving owner privacy.

Below are critical technical gaps, unstated upstream costs, subtle runtime edge cases, algorithmic clarifications, and suggested UX improvements to address before or during implementation.

---

## 2. Critical Implementation Gaps & Unstated Costs

### 2.1 Unstated Upstream Change: Classifier Model Metadata is Dropped
- **Spec Claim (§4.3):** The report must state *"whether classification was itself a model call, and to which destination (`engine.ask.classify` is an I29 `model`-class egress row)"*.
- **Code Reality ([`engine/router.ts:187-217`](file:///C:/gitrep/Nimbus/packages/gateway/src/engine/router.ts#L187-L217)):** `classifyIntent` calls `policy.generate(...)` which produces an `LlmGenerateResult` (containing `provider`, `model`, etc.), but `classifyIntent` discards this metadata and returns only `ClassifiedIntent` (`{ intent, entities, requiresHITL, confidence }`).
- **Required Fix:** `classifyIntent` and `classifyIntentForAskWithLocalFallback` must either return an extended type `{ classified: ClassifiedIntent; modelMeta?: LlmGenerateResult }` or accept a collector callback. This should be explicitly listed under **§7 Cost, stated**.

### 2.2 `buildContextWindow` is Not Called by `buildLocalIndexedContext`
- **Spec Claim (§4.4):** Lists *"`sourceSummary` — the discarded tail, already grouped by service + type with date ranges by `buildContextWindow` (`engine/context-ranker.ts`)"*.
- **Code Reality ([`engine/run-ask.ts:482-585`](file:///C:/gitrep/Nimbus/packages/gateway/src/engine/run-ask.ts#L482-L585)):** `buildLocalIndexedContext` does **not** call `buildContextWindow`. `buildContextWindow` is currently only used by the Mastra agent tool in [`engine/agent.ts:235`](file:///C:/gitrep/Nimbus/packages/gateway/src/engine/agent.ts#L235).
- **Required Fix:** The recorder (or `buildLocalIndexedContext`) must explicitly construct `sourceSummary` over the discarded candidate tail using `buildContextWindow(candidates, limit)` or an equivalent grouping pass.

### 2.3 Direct SQL Matches Have No Score Components
- **Spec Claim (§4.4):** Assumes every candidate in the pool has *"the three score components and the composite (§2.1)"*.
- **Code Reality ([`engine/run-ask.ts:440-475`](file:///C:/gitrep/Nimbus/packages/gateway/src/engine/run-ask.ts#L440-L475)):** The GitHub repo-slug pass (`githubIssueContextItemsForRepo`) queries SQLite directly (`SELECT ... WHERE service = 'github' AND ... ORDER BY modified_at DESC LIMIT ?`). These items have **no** lexical score, recency score, service priority score, or composite score computed.
- **Required Fix:** The candidate model must allow score components to be `undefined` / `null` (or tagged as `direct-sql`), and the renderer must display `n/a (direct query)` rather than `0.00` or failing to render.

### 2.4 Security Invariant: LAN Denylist Omission Hazard
- **Spec Claim (§3.1):** Stated as LAN-forbidden (`checkLanMethodAllowed`, I5).
- **Code Reality ([`ipc/lan-rpc.ts:204-215`](file:///C:/gitrep/Nimbus/packages/gateway/src/ipc/lan-rpc.ts#L204-L215)):** `checkLanMethodAllowed` uses a **denylist** (`FORBIDDEN_OVER_LAN.has(ns) || FORBIDDEN_OVER_LAN.has(method)`). Because `ask` is not in `FORBIDDEN_OVER_LAN`, introducing `ask.explainLast` would be **accidentally permitted over LAN** unless `"ask"` or `"ask.explainLast"` is explicitly added to `FORBIDDEN_OVER_LAN` in `ipc/lan-rpc.ts`.
- **Required Fix:** Explicitly document adding `"ask"` / `"ask.explainLast"` to `FORBIDDEN_OVER_LAN` and adding an invariant test in [`security-invariants.test.ts`](file:///C:/gitrep/Nimbus/packages/gateway/src/security-invariants.test.ts).

### 2.5 IPC Dispatcher Registration
- **Code Reality ([`ipc/server/dispatchers.ts:1824-1830`](file:///C:/gitrep/Nimbus/packages/gateway/src/ipc/server/dispatchers.ts#L1824-L1830)):** `tryDispatchDiagnosticsRpc` routes to `diagnostics-rpc.ts` only for methods matching `db.*`, `diag.*`, `telemetry.*`, `config.*`, or explicit `index.*` methods.
- **Required Fix:** `tryDispatchDiagnosticsRpc` must be updated to route `method === "ask.explainLast"` (or `method.startsWith("ask.")`), and `DiagnosticsRpcContext` in `diagnostics-rpc.ts` needs access to the in-memory `AskExplainRecorder` instance.

---

## 3. Runtime Edge Cases & Concurrency

### 3.1 Un-Sessioned Asks & `tool_call_log` Session Isolation
- **Problem:** In default CLI usage (`nimbus ask "query"`), no `--session` is passed, so `sessionId` is `undefined`.
  - When Mastra agent tools execute, [`agent.ts:58`](file:///C:/gitrep/Nimbus/packages/gateway/src/engine/agent.ts#L58) writes `tool_call_log` rows with `session_id: null`.
  - §4.5 states that for the agent tool-calling route, the ring stores `{ sessionId, startMs, endMs }` and joins to `tool_call_log` at read time.
  - If `sessionId` is `null` / `undefined`, querying `tool_call_log` by `session_id IS NULL AND called_at BETWEEN startMs AND endMs` can conflate concurrent asks or background tasks.
- **Recommendation:** Mint an internal ephemeral `runId` (e.g. `ask_<uuid>`) on every `runAsk` invocation inside `agentRequestContext.run({ sessionId: sessionId ?? ephemeralRunId })`. This ensures all `tool_call_log` entries for a turn share a unique session key, making the join 100% deterministic and isolated.

### 3.2 Error Handling: What Happens When `runAsk` Fails?
- **Problem:** If `runAsk` throws an error (e.g. `GatewayAgentUnavailableError`, LLM timeout, malformed model response):
  - If the recorder only records on successful return, running `nimbus explain last` after an error will display the *previous* successful ask, deceiving the user.
  - If the recorder wraps `runAsk` with a `try...catch` or `try...finally`, it can capture partial failure states (e.g. `route: "failed"`, `stage: "classification" | "retrieval" | "model"`, `error: string`, `durationMs`).
- **Recommendation:** Define a failed-run record shape in the in-memory ring so `nimbus explain last` reports what failed and at what stage.

### 3.3 Silent Local-to-Agent Fallback in `runConversationalAgent`
- **Code Reality ([`engine/run-conversational-agent.ts:218-234`](file:///C:/gitrep/Nimbus/packages/gateway/src/engine/run-conversational-agent.ts#L218-L234)):** When `shouldUseLocalRouter` is true, `runTurn` attempts `runViaLocalRouter`. If the local model throws and `p.agent !== undefined` and air-gap is false, it logs a warning and falls back to `runViaAgent` (the remote Mastra agent).
- **Issue:** In this scenario, `buildLocalIndexedContext` ran, but the actual inference ran on the remote agent tool-calling path with prompt-injected context.
- **Recommendation:** Record whether a fallback occurred (`fallbackFromLocalRouter: true` and the caught local error) in the explain record. This is a critical diagnostic event for the owner.

### 3.4 Multi-Client Concurrency (CLI vs Desktop vs ChatOps)
- **Problem:** `runAsk` is shared across CLI `nimbus ask`, desktop `engine.askStream`, and ChatOps `@nimbus` ([`gateway-main.ts:218`](file:///C:/gitrep/Nimbus/packages/gateway/src/gateway-main.ts#L218)).
- **Issue:** If a teammate queries `@nimbus` in Slack via ChatOps, it will overwrite the gateway's in-memory ring. When the local owner subsequently runs `nimbus explain last`, they would see their teammate's Slack query and retrieval trace.
- **Recommendation:** Tag each record in the ring with `clientId` / `source` (`"cli"`, `"desktop"`, `"chatops"`), and disclose the source in the report header (e.g. `Source: CLI` vs `Source: ChatOps (@user in #channel)`).

---

## 4. Algorithmic & Scoring Clarifications

### 4.1 Mathematical Definition of the 4 Outcomes (§4.4)
The spec defines 4 outcomes: `shown`, `cut: probe slice`, `cut: over cap`, `cut: service fairness`. To ensure testable and unambiguous implementation, the exact decision tree should be specified:

Let:
- $P$ be the primary probe list of length up to 100.
- $K = \text{resolveLocalContextItemLimit()}$ (default 8).
- $\text{byId}$ be the merged candidate map after adding $P[0..K-1]$, quoted matches, repo-slug matches, and fallback matches.
- $N = \text{byId.values()}$ (in insertion / raw score order).
- $S = \text{capPerService}(N, K)$ (the final selected items of length $\le K$).

Then for each candidate $x$ in the union pool:
1. If $x \in S \implies \mathbf{shown}$
2. If $x \in P[K..|P|-1]$ and $x \notin \text{byId} \implies \mathbf{cut:\ probe\ slice}$
3. If $x \in \text{byId}$:
   - If $x \in N[0..K-1]$ but $x \notin S \implies \mathbf{cut:\ service\ fairness}$ (would have been admitted under naive top-$K$, but displaced by service round-robin).
   - If $x \notin N[0..K-1]$ and $x \notin S \implies \mathbf{cut:\ over\ cap}$ (ranked beyond position $K$ even before fairness).

### 4.2 Multi-Pass Candidate Reconciliation
- **Scenario:** Item $x$ ranks at position 15 in the primary probe ($x \in P[K..|P|-1]$), but also matches a quoted search term $\text{"foo"}$ and is successfully added to $\text{byId}$.
- **Question:** Is item $x$ reported as `cut: probe slice` or as `shown` (or `cut: over cap` / `service fairness`)?
- **Clarification:** The candidate entry should be reconciled by its final status in $\text{byId}$. Its contributing pass should be recorded as `quoted:"foo"` (or primary if added there), and its outcome determined by its fate in $\text{byId}$.

### 4.3 Field Naming on `RankedIndexItem`
- §2.1 proposes adding 3 optional numeric fields to `RankedIndexItem`.
- **Hazard:** Naming the first field `lexicalScore` or `bm25Score` is misleading because on the hybrid path it is actually the min-max normalized RRF score ($nr \in [0, 1]$).
- **Recommendation:** Name the fields:
  ```ts
  export type RankedIndexItem = NimbusItem & {
    score: number;
    // ...
    matchScore?: number;        // normRrf on hybrid path, normBm25 on FTS path
    recencyScore?: number;      // recencyScore(modifiedAt, now)
    servicePriorityScore?: number; // servicePriorityScore(service, priorities)
    scoringFormula?: "hybrid_rrf" | "fts_rank" | "direct_sql";
  };
  ```

---

## 5. Verification of Open Question in Spec

### 5.1 Verification of `params_json` Redaction Posture (§4.5 callout)
The spec contains the following callout:
> *To verify during implementation: whether `params_json` needs `redactAuditPayload` treatment on this read path.*

- **Verification Result:** [`db/tool-call-log.ts:58-99`](file:///C:/gitrep/Nimbus/packages/gateway/src/db/tool-call-log.ts#L58-L99) reveals that `writeToolCallLog` **already calls `redactAuditPayload(params, MAX_PARAMS_JSON_BYTES)` before inserting** into `tool_call_log`.
- **Conclusion:** `params_json` is stored pre-redacted at write time. No secondary redaction is required on read, though parsing should handle truncated sentinels `{"truncated": true}` gracefully.

---

## 6. Open Questions & Suggested Improvements

### 6.1 CLI Text Output Wireframes & Formatting Examples
The spec does not include concrete visual mockups of the CLI output for each route. Adding standard visual formats to the spec prevents discrepancies during implementation:

#### Example: Route 2 (Local Context)
```text
Ask Explanation — 2026-09-14 18:42:10 UTC (took 342ms)
Question: "what did we decide about rate limiting on slack?"
Route: conversational / local context (reason: llm.prefer_local = true)
Model: ollama / llama3.2 (local) | Persona: standard
Classifier: intent=unknown, conf=0.00 (not called: local preference)

Search Terms: ["rate", "limiting", "slack"] (primary-hybrid probe: 14 matches)
Truncation: 8 items shown out of 14 matching candidates

Candidate Pool (14 items evaluated across 2 passes):
#  Pass            Service  Type     Title                          Score [Match / Rec / Svc]  Outcome
1  primary-hybrid  slack    message  #eng: rate limiting RFC        0.84  [ 0.90 / 0.80 / 0.75 ]  shown
2  primary-hybrid  github   pr       #412 Add redis rate limiter    0.79  [ 0.85 / 0.70 / 0.80 ]  shown
3  quoted:"rate"   slack    message  #leads: API throttling debate  0.72  [ 0.80 / 0.60 / 0.70 ]  shown
...
9  primary-hybrid  slack    message  #eng: old rate limit ideas     0.45  [ 0.50 / 0.40 / 0.40 ]  cut: probe slice
10 primary-hybrid  github   issue    #102 GitHub actions throttle   0.68  [ 0.75 / 0.60 / 0.65 ]  cut: service fairness

Note: Scores are derived from different passes (hybrid RRF vs FTS) and are not directly comparable.
```

#### Example: Route 3 (Agent Tool-Calling)
```text
Ask Explanation — 2026-09-14 18:45:02 UTC (took 1,420ms)
Question: "list my recent open PRs on nimbus"
Route: conversational / agent tool-calling (reason: remote vendor enabled: gemini)
Model: gemini / gemini-2.5-flash (remote) | Persona: standard
Classifier: intent=unknown, conf=0.00 (fallback to conversational agent)

Retrieval Ranking: None (the model autonomously decided which tools to invoke)

Tool Calls Executed (2 calls):
1. github.listPullRequests { state: "open", author: "@me" } -> ok (185ms)
2. github.getPullRequest { number: 491 } -> ok (94ms)
```

### 6.2 Formal TypeScript Types for `--json`
The return type of `ask.explainLast` should be formally specified as a discriminated union:

```ts
export type AskExplainRecord =
  | EmptyIndexExplainRecord
  | LocalContextExplainRecord
  | AgentToolCallingExplainRecord
  | PlanDispatchExplainRecord
  | FailedAskExplainRecord;

export interface BaseExplainRecord {
  readonly id: string;
  readonly askedAt: number;
  readonly durationMs: number;
  readonly question: string;
  readonly source: "cli" | "desktop" | "chatops";
  readonly persona: string;
  readonly modelRoute: {
    readonly provider: string;
    readonly model: string;
    readonly isLocal: boolean;
  };
  readonly classifier: {
    readonly called: boolean;
    readonly reasonIfNotCalled?: string;
    readonly intent?: string;
    readonly confidence?: number;
    readonly entities?: Record<string, string>;
    readonly destination?: string;
  };
}
```

### 6.3 Ring History Navigation (`nimbus explain list` / `explain last~N`)
- While a durable SQLite table is rightly deferred to the SQLCipher milestone (§6), the in-memory ring holds 10 items.
- Adding `nimbus explain list` (lists the 10 recent asks with timestamps, questions, and routes) and `nimbus explain <index | runId>` (inspects a specific recent ask from the ring) provides immediate value without disk persistence or encryption concerns.

### 6.4 Negation Predicate & Index Count Queries
- When `ask` evaluates negation predicates (e.g. `runNotTouchingQuery`) or runs direct SQL `indexCountFor` queries, capturing them in the local context explain report provides complete mechanical transparency for all retrieval actions that took place.

---

## 7. Implementation Checklist

- [ ] Add `matchScore`, `recencyScore`, `servicePriorityScore`, and `scoringFormula` to `RankedIndexItem` in `index/ranked-item.ts`.
- [ ] Populate score components at both scoring sites in `index/local-index.ts`.
- [ ] Expose classifier `LlmGenerateResult` / destination from `classifyIntent` in `engine/router.ts`.
- [ ] Implement `AskExplainRecorder` bounded ring in `engine/ask-explain-recorder.ts`.
- [ ] Hook recorder at all exit points and error catches in `engine/run-ask.ts`.
- [ ] Handle unranked / direct-SQL candidates from repo-slug searches in the candidate pool.
- [ ] Implement outcome classifier using the 4-way decision tree in `engine/ask-explain-outcome.ts`.
- [ ] Add `ask.explainLast` handler in `ipc/diagnostics-rpc.ts`.
- [ ] Update `tryDispatchDiagnosticsRpc` in `ipc/server/dispatchers.ts` to route `ask.explainLast`.
- [ ] Add `"ask"` / `"ask.explainLast"` to `FORBIDDEN_OVER_LAN` in `ipc/lan-rpc.ts`.
- [ ] Implement CLI subcommand `nimbus explain last [--json]` in `packages/cli/src/commands/explain.ts`.
- [ ] Add unit tests for ring buffer, outcome classification, score non-comparability disclosure, and all 4 routes.
- [ ] Add security invariant test asserting `ask.explainLast` is rejected over LAN.
- [ ] Add integration test verifying tool-call joining against real SQLite database.
- [ ] Add E2E test verifying fresh gateway empty state and post-ask report.
