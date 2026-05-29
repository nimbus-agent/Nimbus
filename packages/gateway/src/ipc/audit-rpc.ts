import { verifyAuditChain } from "../db/audit-verify.ts";
import { readToolCallLog, type ToolCallLogFilter } from "../db/tool-call-log.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export type AuditRpcContext = { index: LocalIndex | undefined };

export class AuditRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "AuditRpcError";
    this.rpcCode = rpcCode;
  }
}

function ensureIndex(ctx: AuditRpcContext): LocalIndex {
  if (ctx.index === undefined) {
    throw new AuditRpcError(-32603, "audit RPC unavailable: LocalIndex not configured");
  }
  return ctx.index;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseSessionId(p: Record<string, unknown>, filter: ToolCallLogFilter): void {
  if (!("sessionId" in p)) return;
  const v = p["sessionId"];
  if (typeof v !== "string") {
    throw new AuditRpcError(-32602, "audit.toolCalls: sessionId must be a string");
  }
  filter.sessionId = v;
}

function parseToolId(p: Record<string, unknown>, filter: ToolCallLogFilter): void {
  if (!("toolId" in p)) return;
  const v = p["toolId"];
  if (typeof v !== "string" || v.length === 0) {
    throw new AuditRpcError(-32602, "audit.toolCalls: toolId must be a non-empty string");
  }
  filter.toolId = v;
}

function parseStatus(p: Record<string, unknown>, filter: ToolCallLogFilter): void {
  if (!("status" in p)) return;
  const v = p["status"];
  if (v !== "ok" && v !== "error") {
    throw new AuditRpcError(-32602, "audit.toolCalls: status must be 'ok' or 'error'");
  }
  filter.status = v;
}

function parseLimit(p: Record<string, unknown>, filter: ToolCallLogFilter): void {
  if (!("limit" in p)) return;
  const v = p["limit"];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 1_000) {
    throw new AuditRpcError(-32602, "audit.toolCalls: limit must be an integer in [1, 1000]");
  }
  filter.limit = v;
}

function parseTimeBounds(p: Record<string, unknown>, filter: ToolCallLogFilter): void {
  if ("since" in p) {
    const v = p["since"];
    if (!isNonNegativeInteger(v)) {
      throw new AuditRpcError(-32602, "audit.toolCalls: since must be a non-negative integer");
    }
    filter.since = v;
  }
  if ("until" in p) {
    const v = p["until"];
    if (!isNonNegativeInteger(v)) {
      throw new AuditRpcError(-32602, "audit.toolCalls: until must be a non-negative integer");
    }
    filter.until = v;
  }
  if (filter.since !== undefined && filter.until !== undefined && filter.until < filter.since) {
    throw new AuditRpcError(-32602, "audit.toolCalls: until must be >= since");
  }
}

function parseCursor(p: Record<string, unknown>, filter: ToolCallLogFilter): void {
  if (!("cursor" in p)) return;
  const v = p["cursor"];
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new AuditRpcError(
      -32602,
      "audit.toolCalls: cursor must be an object with calledAt and id",
    );
  }
  const c = v as Record<string, unknown>;
  const calledAt = c["calledAt"];
  const id = c["id"];
  if (!isNonNegativeInteger(calledAt) || !isNonNegativeInteger(id)) {
    throw new AuditRpcError(
      -32602,
      "audit.toolCalls: cursor.calledAt and cursor.id must be non-negative integers",
    );
  }
  filter.cursor = { calledAt, id };
}

function parseToolCallsParams(params: unknown): ToolCallLogFilter {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AuditRpcError(-32602, "audit.toolCalls: params must be an object");
  }
  const p = params as Record<string, unknown>;
  const filter: ToolCallLogFilter = {};
  parseSessionId(p, filter);
  parseToolId(p, filter);
  parseStatus(p, filter);
  parseLimit(p, filter);
  parseTimeBounds(p, filter);
  parseCursor(p, filter);
  return filter;
}

function handleAuditVerify(
  params: unknown,
  ctx: AuditRpcContext,
): ReturnType<typeof verifyAuditChain> {
  const idx = ensureIndex(ctx);
  const full =
    params !== null &&
    typeof params === "object" &&
    (params as Record<string, unknown>)["full"] === true;
  const fromId = full ? 0 : idx.getAuditVerifiedThroughId();
  const result = verifyAuditChain(idx, { fromId });
  if (result.ok) idx.setAuditVerifiedThroughId(result.lastVerifiedId);
  return result;
}

function handleAuditExport(_p: unknown, ctx: AuditRpcContext): unknown {
  return ensureIndex(ctx).listAuditWithChain(10_000);
}

function handleAuditGetSummary(_p: unknown, ctx: AuditRpcContext): unknown {
  return ensureIndex(ctx).getAuditSummary();
}

function handleAuditToolCalls(params: unknown, ctx: AuditRpcContext): unknown {
  const filter = parseToolCallsParams(params);
  const idx = ensureIndex(ctx);
  return readToolCallLog(idx.getDatabase(), filter);
}

export async function dispatchAuditRpc(
  method: string,
  params: unknown,
  ctx: AuditRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<AuditRpcContext>(method, params, ctx, {
    "audit.verify": handleAuditVerify,
    "audit.exportAll": handleAuditExport,
    "audit.export": handleAuditExport,
    "audit.getSummary": handleAuditGetSummary,
    "audit.toolCalls": handleAuditToolCalls,
  });
}
