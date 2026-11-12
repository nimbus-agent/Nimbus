import { AsyncLocalStorage } from "node:async_hooks";

import { redactAuditPayload } from "../audit/format-audit-payload.ts";
import { MAX_PARAMS_JSON_BYTES } from "../db/tool-call-log.ts";
import type { PointInTimeFacts } from "../index/item-history-at.ts";
import type { CollectedToolCall } from "./ask-explain-types.ts";
import type { ToolExecutor } from "./executor.ts";

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
  /**
   * The DISPATCHING executor a model-initiated user-MCP tool call runs through (I42 owner prompt,
   * audit row, I29 egress row). Present ONLY when this turn's caller is the local owner — set by
   * `runAsk` from an explicit flag decided at the entry point, never inferred here. Absent, a
   * user-MCP agent tool refuses and calls nothing (`engine/user-mcp-agent-tools.ts`).
   */
  userMcpExecutor?: ToolExecutor;
  /**
   * The DISPATCHING executor the model's connector-write door (`engine/connector-write-agent-tools.ts`)
   * runs every call through. Built WITHOUT delegation, so only the local owner is ever asked. Present
   * ONLY on the local owner's non-demo `cli`/`ui` turn — set by `runAsk` from an explicit flag decided
   * at the IPC entry (`CONNECTOR_WRITE_OFFER_BY_KIND`). Absent, no door tool is listed and a stale
   * call is refused.
   */
  connectorWriteExecutor?: ToolExecutor;
  /**
   * The instant a point-in-time turn (`nimbus ask --at`, Phase 10 IC1) answers for. Present ONLY on such
   * a turn: `toolsFor` then offers the three time-aware tools and nothing else, and the index tools pass
   * the instant to the index. Set by the IPC entry and again by `runAsk`, so the store always agrees with
   * the turn's params.
   */
  pointInTimeMs?: number;
  /**
   * The facts of every point-in-time search this turn ran (one per `searchLocalIndex` call), drained by
   * the deterministic disclosure after the model has finished. Created lazily, like `explainToolCalls`.
   */
  pointInTimeFacts?: PointInTimeFacts[];
};

export const agentRequestContext = new AsyncLocalStorage<AgentRequestContext>();

export function getAgentRequestSessionId(): string | undefined {
  return agentRequestContext.getStore()?.sessionId;
}

/** This turn's user-MCP executor, or `undefined` outside a turn / for a non-owner caller. */
export function getAgentRequestUserMcpExecutor(): ToolExecutor | undefined {
  return agentRequestContext.getStore()?.userMcpExecutor;
}

/** This turn's connector-write door executor, or `undefined` outside an owner `cli`/`ui` turn. */
export function getAgentRequestConnectorWriteExecutor(): ToolExecutor | undefined {
  return agentRequestContext.getStore()?.connectorWriteExecutor;
}

/** This turn's point-in-time instant, or `undefined` outside a turn / for an ordinary turn. */
export function getAgentRequestPointInTimeMs(): number | undefined {
  return agentRequestContext.getStore()?.pointInTimeMs;
}

/** Records one point-in-time search's facts on the turn's store (a no-op outside a turn). */
export function recordPointInTimeFacts(facts: PointInTimeFacts): void {
  const store = agentRequestContext.getStore();
  if (store === undefined) return;
  const list = store.pointInTimeFacts ?? [];
  list.push(facts);
  store.pointInTimeFacts = list;
}

/** The facts recorded this turn, drained (the disclosure is built once, after the model finished). */
export function drainPointInTimeFacts(): PointInTimeFacts[] {
  const store = agentRequestContext.getStore();
  if (store === undefined) return [];
  const list = store.pointInTimeFacts ?? [];
  delete store.pointInTimeFacts;
  return list;
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
