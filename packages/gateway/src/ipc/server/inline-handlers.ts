import { randomUUID } from "node:crypto";

import { Config } from "../../config.ts";
import { asRecord } from "../../connectors/unknown-record.ts";
import {
  describeEmbeddingWarming,
  EMBEDDING_WARMING_CODE,
  EMBEDDING_WARMING_RPC_CODE,
} from "../../embedding/embedding-readiness.ts";
import {
  type AgentRequestContext,
  agentRequestContext,
} from "../../engine/agent-request-context.ts";
import { GatewayAgentUnavailableError } from "../../engine/gateway-agent-error.ts";
import { driftHintsFromIndex } from "../../index/drift-hints.ts";
import type { IndexSearchQuery } from "../../index/local-index.ts";
import type { AgentInvokeContext } from "../agent-invoke.ts";
import { type AgentInvokeContextLike, createAskStreamHandler } from "../engine-ask-stream.ts";
import type { ClientSession } from "../session.ts";
import type { WorkflowRunContext } from "../workflow-invoke.ts";
import type { ServerCtx } from "./context.ts";
import { RpcMethodError } from "./rpc-error.ts";

function requireNonEmptyRpcString(rec: Record<string, unknown> | undefined, key: string): string {
  if (rec === undefined) {
    throw new RpcMethodError(-32602, `Missing or invalid ${key}`);
  }
  const v = rec[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new RpcMethodError(-32602, `Missing or invalid ${key}`);
  }
  return v.trim();
}

function parseOptionalString(
  rec: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const raw = rec?.[key];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return raw.trim();
}

function sendAgentChunkIfStreaming(session: ClientSession, stream: boolean, text: string): void {
  if (!stream) {
    return;
  }
  session.writeNotification({
    jsonrpc: "2.0",
    method: "agent.chunk",
    params: { text },
  });
}

export async function dispatchAgentInvoke(
  ctx: ServerCtx,
  session: ClientSession,
  clientId: string,
  params: unknown,
): Promise<unknown> {
  const rec = asRecord(params);
  const input = rec !== undefined && typeof rec["input"] === "string" ? rec["input"] : "";
  const stream = rec?.["stream"] === true;
  const sessionIdRaw = rec?.["sessionId"];
  const sessionId =
    typeof sessionIdRaw === "string" && sessionIdRaw.trim() !== ""
      ? sessionIdRaw.trim()
      : undefined;
  const agentRaw = rec?.["agent"];
  const agent =
    typeof agentRaw === "string" && agentRaw.trim() !== "" ? agentRaw.trim() : undefined;
  const handler = ctx.getAgentInvokeHandler();
  if (handler === undefined) {
    return {
      reply: `Agent invoke is not configured (no handler). Echo: ${input.slice(0, 500)}`,
      stream,
    };
  }
  try {
    const requestStore: AgentRequestContext = {};
    if (sessionId !== undefined) {
      requestStore.sessionId = sessionId;
    }
    return await agentRequestContext.run(requestStore, async () => {
      const payload: AgentInvokeContext = {
        clientId,
        input,
        stream,
        sendChunk: (text: string) => {
          sendAgentChunkIfStreaming(session, stream, text);
        },
      };
      if (sessionId !== undefined) {
        payload.sessionId = sessionId;
      }
      if (agent !== undefined) {
        payload.agent = agent;
      }
      return handler(payload);
    });
  } catch (e) {
    if (e instanceof GatewayAgentUnavailableError) {
      throw new RpcMethodError(-32000, e.message);
    }
    throw e;
  }
}

function parseWorkflowRunParamsOverride(
  rec: Record<string, unknown> | undefined,
): Readonly<Record<string, Record<string, unknown>>> | undefined {
  const raw = rec?.["paramsOverride"];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new RpcMethodError(
      -32602,
      "workflow.run: paramsOverride must be an object keyed by step label",
    );
  }
  return raw as Readonly<Record<string, Record<string, unknown>>>;
}

function buildWorkflowRunContext(
  clientId: string,
  session: ClientSession,
  params: unknown,
): { ctx: WorkflowRunContext; sessionId: string | undefined } {
  const rec = asRecord(params);
  const workflowName = requireNonEmptyRpcString(rec, "name");
  const triggeredBy = parseOptionalString(rec, "triggeredBy") ?? clientId;
  const dryRun = rec?.["dryRun"] === true;
  const stream = rec?.["stream"] === true;
  const sessionId = parseOptionalString(rec, "sessionId");
  const agent = parseOptionalString(rec, "agent");
  const paramsOverride = parseWorkflowRunParamsOverride(rec);

  const ctx: WorkflowRunContext = {
    clientId,
    workflowName,
    triggeredBy,
    dryRun,
    stream,
    sendChunk: (text: string) => {
      sendAgentChunkIfStreaming(session, stream, text);
    },
  };
  if (sessionId !== undefined) ctx.sessionId = sessionId;
  if (agent !== undefined) ctx.agent = agent;
  if (paramsOverride !== undefined) ctx.paramsOverride = paramsOverride;
  return { ctx, sessionId };
}

export async function dispatchWorkflowRunRpc(
  ctx: ServerCtx,
  clientId: string,
  session: ClientSession,
  params: unknown,
): Promise<unknown> {
  if (ctx.options.localIndex === undefined) {
    throw new RpcMethodError(-32603, "Local index is not available");
  }
  const handler = ctx.getWorkflowRunHandler();
  if (handler === undefined) {
    throw new RpcMethodError(-32603, "Workflow runner is not configured");
  }
  const { ctx: workflowCtx, sessionId } = buildWorkflowRunContext(clientId, session, params);

  try {
    const requestStore: AgentRequestContext = {};
    if (sessionId !== undefined) {
      requestStore.sessionId = sessionId;
    }
    return await agentRequestContext.run(requestStore, async () => handler(workflowCtx));
  } catch (e) {
    if (e instanceof GatewayAgentUnavailableError) {
      throw new RpcMethodError(-32000, e.message);
    }
    throw e;
  }
}

export function rpcGatewayPing(ctx: ServerCtx, params: unknown): unknown {
  const extra = ctx.options.getEmbeddingStatus?.() ?? {};
  const base: Record<string, unknown> = {
    version: ctx.options.version,
    uptime: Date.now() - ctx.startedAtMs,
    agentLimits: {
      maxAgentDepth: Config.maxAgentDepth,
      maxToolCallsPerSession: Config.maxToolCallsPerSession,
    },
    ...extra,
  };
  const rec = asRecord(params);
  if (rec?.["includeDrift"] !== true) {
    return base;
  }
  if (ctx.options.localIndex === undefined) {
    return { ...base, drift: { lines: ["Local index is not available."] as const } };
  }
  const lines = driftHintsFromIndex(ctx.options.localIndex.getDatabase());
  return { ...base, drift: { lines } };
}

export async function rpcIndexSearchRanked(ctx: ServerCtx, params: unknown): Promise<unknown> {
  if (ctx.options.localIndex === undefined) {
    throw new RpcMethodError(-32603, "Local index is not available");
  }
  const rec = asRecord(params);
  if (rec === undefined) {
    throw new RpcMethodError(-32602, "Invalid params");
  }
  const name = typeof rec["name"] === "string" ? rec["name"] : "";
  const service = typeof rec["service"] === "string" ? rec["service"] : undefined;
  const itemType = typeof rec["itemType"] === "string" ? rec["itemType"] : undefined;
  const limit =
    typeof rec["limit"] === "number" && Number.isFinite(rec["limit"])
      ? Math.min(500, Math.max(1, Math.floor(rec["limit"])))
      : 20;
  const semantic = rec["semantic"] !== false;
  const contextChunks =
    typeof rec["contextChunks"] === "number" && Number.isFinite(rec["contextChunks"])
      ? Math.min(8, Math.max(0, Math.floor(rec["contextChunks"])))
      : 2;
  // #928 false-green guard. The gateway now binds BEFORE the embedding model is loaded, so a
  // semantic query can arrive with no vectors yet. Serving it anyway silently degrades to BM25
  // — and a query with no lexical overlap then returns `[]`, which reads exactly like "searched
  // everything, found nothing". Say "not yet" instead, and hand back the readiness so the client
  // can show progress or retry. Only WARMING is transient: `disabled`/`unavailable` are
  // permanent for this process, so those serve keyword results as before.
  const readiness = ctx.options.embeddingReadiness?.();
  if (semantic && readiness?.state === "warming") {
    throw new RpcMethodError(
      EMBEDDING_WARMING_RPC_CODE,
      `index.searchRanked: ${describeEmbeddingWarming(readiness)}`,
      { code: EMBEDDING_WARMING_CODE, readiness },
    );
  }

  const query: IndexSearchQuery = { limit };
  if (name !== "") {
    query.name = name;
  }
  if (service !== undefined) {
    query.service = service;
  }
  if (itemType !== undefined) {
    query.itemType = itemType;
  }
  return await ctx.options.localIndex.searchRankedAsync(query, {
    semantic,
    contextChunks,
  });
}

export function rpcConsentRespond(ctx: ServerCtx, clientId: string, params: unknown): unknown {
  const err = ctx.consentImpl.handleRespond(clientId, params);
  if (err !== null) {
    throw new RpcMethodError(err.code, err.message);
  }
  return { ok: true };
}

export function rpcAuditList(ctx: ServerCtx, params: unknown): unknown {
  const rec = asRecord(params);
  let limit = 100;
  if (rec !== undefined && typeof rec["limit"] === "number" && Number.isFinite(rec["limit"])) {
    limit = Math.min(1000, Math.max(1, Math.floor(rec["limit"])));
  }
  if (ctx.options.localIndex === undefined) {
    return [];
  }
  return ctx.options.localIndex.listAudit(limit);
}

export function dispatchEngineAskStream(
  ctx: ServerCtx,
  session: ClientSession,
  clientId: string,
  params: unknown,
): Promise<{ streamId: string }> {
  const rec = asRecord(params);
  const input = rec !== undefined && typeof rec["input"] === "string" ? rec["input"] : "";
  const sessionIdRaw = rec?.["sessionId"];
  const sessionId =
    typeof sessionIdRaw === "string" && sessionIdRaw.trim() !== ""
      ? sessionIdRaw.trim()
      : undefined;

  const handler = ctx.getAgentInvokeHandler();
  if (handler === undefined) {
    throw new RpcMethodError(-32603, "No agent handler configured for engine.askStream");
  }

  const dispatch = createAskStreamHandler({
    registry: ctx.streamRegistry,
    randomId: () => randomUUID(),
    sessionWriteNotification: (n) => session.writeNotification(n),
    runWithRequestContext: (rc, fn) => {
      const requestStore: AgentRequestContext = {};
      if (rc.sessionId !== undefined) requestStore.sessionId = rc.sessionId;
      return agentRequestContext.run(requestStore, fn);
    },
    agentInvokeHandler: async (innerCtx: AgentInvokeContextLike) => {
      const payload: AgentInvokeContext = {
        clientId: innerCtx.clientId,
        input: innerCtx.input,
        stream: innerCtx.stream,
        sendChunk: innerCtx.sendChunk ?? (() => undefined),
      };
      if (innerCtx.sessionId !== undefined) payload.sessionId = innerCtx.sessionId;
      return await handler(payload);
    },
  });

  const askParams: { input: string; sessionId?: string } = { input };
  if (sessionId !== undefined) askParams.sessionId = sessionId;
  return dispatch(clientId, askParams);
}
