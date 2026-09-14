import { AsyncLocalStorage } from "node:async_hooks";

import type { CollectedToolCall } from "./ask-explain-types.ts";

export type AgentRequestContext = {
  sessionId?: string | undefined;
  /**
   * Disclosure sentences recorded by negation tools during this turn, drained and appended by
   * `runConversationalAgent`. Created LAZILY by `recordNegationDisclosure` rather than
   * initialised where the store is built: `ipc/server/inline-handlers.ts` constructs the store
   * in THREE places (`agent.invoke` at :96, `workflow.run` at :215, and the `engine.askStream`
   * dispatcher at :350), and a field that had to be initialised at all three would eventually
   * be initialised at fewer.
   */
  negationDisclosures?: string[];
  /**
   * Tool calls made during THIS turn, for `nimbus explain last` (spec §4.5).
   *
   * Collected here rather than joined out of `tool_call_log`: `agent.ts` writes
   * `getAgentRequestSessionId() ?? null`, and a plain `nimbus ask` passes no session — so the
   * rows land with `session_id` NULL and a time-window join would conflate concurrent asks.
   * Created lazily, exactly as `negationDisclosures` is.
   */
  explainToolCalls?: CollectedToolCall[];
};

export const agentRequestContext = new AsyncLocalStorage<AgentRequestContext>();

export function getAgentRequestSessionId(): string | undefined {
  return agentRequestContext.getStore()?.sessionId;
}

/**
 * Push a tool call onto the current turn's store. A missing store is a silent no-op, not an
 * error: this is a diagnostic riding along a real tool call, and if collection fails the user's
 * answer must still be correct.
 */
export function recordExplainToolCall(call: CollectedToolCall): void {
  const store = agentRequestContext.getStore();
  if (store === undefined) return; // outside a turn: a diagnostic must never break the caller
  const arr = store.explainToolCalls ?? [];
  arr.push(call);
  store.explainToolCalls = arr;
}

export function getExplainToolCalls(): readonly CollectedToolCall[] | undefined {
  return agentRequestContext.getStore()?.explainToolCalls;
}
