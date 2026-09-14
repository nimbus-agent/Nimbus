import { AsyncLocalStorage } from "node:async_hooks";

import { redactAuditPayload } from "../audit/format-audit-payload.ts";
import { MAX_PARAMS_JSON_BYTES } from "../db/tool-call-log.ts";
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
 * Everything a call site knows about a tool call BEFORE redaction — `params` is the raw,
 * unredacted input, since `recordExplainToolCall` does the redaction itself (see below).
 */
export type ExplainToolCallInput = {
  readonly toolId: string;
  readonly service: string;
  readonly status: "ok" | "error";
  readonly durationMs: number;
  /** Raw tool input, NOT yet redacted. `undefined` becomes a stored `paramsJson: null`. */
  readonly params: unknown;
  readonly ranking?: CollectedToolCall["ranking"];
};

/**
 * Push a tool call onto the current turn's store. Best-effort, exactly like
 * `db/tool-call-log.ts`'s `writeToolCallLog`: redaction/serialization of `params` happens INSIDE
 * the try, because `redactAuditPayload`/`JSON.stringify` can throw on pathological input (a
 * circular reference, a BigInt field — the wrapper's `input` is `unknown` and rules out neither),
 * and this is a diagnostic riding along a real tool call — it must never throw and never break
 * the caller. A missing store is the same story, just the cheaper case: outside a turn there is
 * nothing to push to, so return before doing any work.
 */
export function recordExplainToolCall(call: ExplainToolCallInput): void {
  const store = agentRequestContext.getStore();
  if (store === undefined) return; // outside a turn: a diagnostic must never break the caller
  try {
    const paramsJson =
      call.params === undefined ? null : redactAuditPayload(call.params, MAX_PARAMS_JSON_BYTES);
    const entry: CollectedToolCall = {
      toolId: call.toolId,
      service: call.service,
      status: call.status,
      durationMs: call.durationMs,
      paramsJson,
      ...(call.ranking !== undefined ? { ranking: call.ranking } : {}),
    };
    const arr = store.explainToolCalls ?? [];
    arr.push(entry);
    store.explainToolCalls = arr;
  } catch {
    // Best-effort: a redaction/serialization failure must never surface to the caller, whose
    // tool call has already succeeded (or already failed on its own, independent terms).
  }
}

export function getExplainToolCalls(): readonly CollectedToolCall[] | undefined {
  return agentRequestContext.getStore()?.explainToolCalls;
}
