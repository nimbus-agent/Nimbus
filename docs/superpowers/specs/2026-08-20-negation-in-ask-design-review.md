# Design Review: Negation in Ask (2026-08-20)

Below are comments, questions, and suggested improvements for the `2026-08-20-negation-in-ask-design.md` specification.

---

## 1. Responses to Open Questions

### Q1: Where exactly the streamed disclosure chunk is emitted

To ensure that both the local router and the Mastra agent paths consistently append the disclosure to both the returned reply and the stream chunk callback:

* **Location:** The check and append should occur at the end of `runConversationalAgent` in `packages/gateway/src/engine/run-conversational-agent.ts:213` (immediately after the `runViaLocalRouter` / `runViaAgent` fork but inside the `try` block).
* **Implementation Pattern:**

  ```ts
  const res = await (llmRouter !== undefined && shouldUseLocalRouter(p)
    ? runViaLocalRouter(llmRouter, promptArg, p)
    : runViaAgent(p.agent, promptArg, p, maxSteps));

  const store = agentRequestContext.getStore();
  if (store?.negationDisclosures && store.negationDisclosures.length > 0) {
    const disclosuresText = "\n\n" + store.negationDisclosures.join("\n");
    if (p.stream === true) {
      p.sendChunk(disclosuresText);
    }
    return {
      ...res,
      reply: res.reply + disclosuresText,
    };
  }
  return res;
  ```

This guarantees:

1. Streamed chunks and the final returned reply are byte-identical.
2. The UI stream (via Tauri bridge) and the CLI output receive the exact same chunk.
3. No dual-maintenance across the local router and agent routes.

---

## 2. Technical Alignment & Suggestions

### A. Confirming `AsyncLocalStorage` Propagation under Mastra

* **Observation:** Mastra runs tool executions asynchronously. If Mastra delegates tool executes across thread boundaries or performs cleanups that prune local context, `agentRequestContext.getStore()` inside the tool could resolve to `undefined`.
* **Suggestion:** We should add an integration test in `run-conversational-agent.test.ts` or `agent.test.ts` that triggers a mock tool pushing a dummy string to `agentRequestContext.getStore().negationDisclosures`, asserting that the value is successfully collected at the caller level.

### B. Cleaning/Isolating the Disclosures Store

* **Observation:** `dispatchAgentInvoke` and `dispatchEngineAskStream` in `inline-handlers.ts` create a fresh `requestStore: AgentRequestContext` object for every invocation. This prevents leakages between parallel user requests.
* **Suggestion:** To prevent any potential leakage in sequential loops (e.g., if a subagent is invoked inside the same context), the array should be drained or read-once when we format the reply, or we should document that the store is strictly single-use per IPC dispatch frame.

### C. Schemas for Negation Tools

* **Suggestion:** Aligning with D4 and D5:
  * `findPrsNotTouching`: Explicitly define the Mastra/MCP tool schema parameters to accept an optional `service` string, but completely omit `itemType` to enforce the PR type constraint intrinsically.
  * `findPeopleWithoutReviews`: The schema parameters should only accept `since` and `limit`, with no `service` parameter whatsoever (matching the person-store query semantics).
