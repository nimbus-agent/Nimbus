import {
  DOORS,
  type Door,
  listByDoor,
  type ProposerProof,
  proveByProposer,
} from "../audit/agent-door-proof.ts";
import { verifyAuditChain } from "../db/audit-verify.ts";
import { readToolCallLog, type ToolCallLogFilter } from "../db/tool-call-log.ts";
import { verifyEgressChain } from "../egress/egress-verify.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import type { ClientKind } from "./server/client-kind.ts";

export type AuditRpcContext = {
  index: LocalIndex | undefined;
  /**
   * The asking connection's DECLARED kind, from the server (never a param). Only the two Phase 28
   * AD4 proof methods read it; absent, they refuse.
   */
  callerKind?: ClientKind;
};

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

// ---- Phase 28 AD4: the proof of an outside agent's actions --------------------------------------

/** The kinds that may read the proof: the owner's own terminal and desktop (the rule AD2 set for new owner methods). */
const PROOF_KINDS: ReadonlySet<ClientKind> = new Set<ClientKind>(["cli", "ui"]);
const PROPOSER_MAX = 400;

/** Step 1 of both proof methods, BEFORE the params and any read. */
function requireProofCaller(ctx: AuditRpcContext, method: string): void {
  if (ctx.callerKind === undefined || !PROOF_KINDS.has(ctx.callerKind)) {
    throw new AuditRpcError(-32001, `${method} needs a connection that declared cli or ui`);
  }
}

function paramsObject(params: unknown, method: string): Record<string, unknown> {
  if (params === undefined) return {};
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AuditRpcError(-32602, `${method}: params must be an object`);
  }
  return params as Record<string, unknown>;
}

function optionalMs(p: Record<string, unknown>, key: string, method: string): number | undefined {
  if (!(key in p) || p[key] === undefined) return undefined;
  const v = p[key];
  if (!isNonNegativeInteger(v)) {
    throw new AuditRpcError(-32602, `${method}: ${key} must be a non-negative integer`);
  }
  return v;
}

function optionalProposer(p: Record<string, unknown>, method: string): string | undefined {
  if (!("proposer" in p) || p["proposer"] === undefined) return undefined;
  const v = p["proposer"];
  if (typeof v !== "string" || v.length === 0 || v.length > PROPOSER_MAX) {
    throw new AuditRpcError(
      -32602,
      `${method}: proposer must be a string of 1 to ${String(PROPOSER_MAX)} characters`,
    );
  }
  return v;
}

function windowOf(p: Record<string, unknown>, method: string) {
  const sinceMs = optionalMs(p, "sinceMs", method);
  const untilMs = optionalMs(p, "untilMs", method);
  if (sinceMs !== undefined && untilMs !== undefined && untilMs < sinceMs) {
    throw new AuditRpcError(-32602, `${method}: untilMs must be >= sinceMs`);
  }
  return { sinceMs, untilMs };
}

/** `nimbus prove --by-proposer`: the agent door's actions by the client's own label, with both chains verified. */
function handleProveByProposer(params: unknown, ctx: AuditRpcContext): ProposerProof {
  const method = "audit.proveByProposer";
  requireProofCaller(ctx, method);
  const p = paramsObject(params, method);
  const { sinceMs, untilMs } = windowOf(p, method);
  const proposer = optionalProposer(p, method);
  const idx = ensureIndex(ctx);
  const audit = verifyAuditChain(idx, { fromId: 0 });
  const egress = verifyEgressChain(idx.rawDb);
  return proveByProposer(idx.rawDb, {
    sinceMs,
    untilMs,
    byLabel: proposer,
    audit: { ok: audit.ok, reason: audit.reason },
    egress: { ok: egress.ok, reason: egress.reason },
  });
}

/** `nimbus audit --door`: the newest audit rows that came through one door. */
function handleListByDoor(params: unknown, ctx: AuditRpcContext): unknown {
  const method = "audit.listByDoor";
  requireProofCaller(ctx, method);
  const p = paramsObject(params, method);
  const door = p["door"];
  if (typeof door !== "string" || !(DOORS as readonly string[]).includes(door)) {
    throw new AuditRpcError(-32602, `${method}: door must be one of ${DOORS.join(", ")}`);
  }
  const { sinceMs, untilMs } = windowOf(p, method);
  const proposer = optionalProposer(p, method);
  if (proposer !== undefined && door !== "agent") {
    throw new AuditRpcError(-32602, `${method}: proposer applies to the agent door only`);
  }
  let limit: number | undefined;
  if ("limit" in p && p["limit"] !== undefined) {
    const v = p["limit"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 1_000) {
      throw new AuditRpcError(-32602, `${method}: limit must be an integer in [1, 1000]`);
    }
    limit = v;
  }
  const idx = ensureIndex(ctx);
  return listByDoor(idx.rawDb, { door: door as Door, byLabel: proposer, sinceMs, untilMs, limit });
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
    "audit.proveByProposer": handleProveByProposer,
    "audit.listByDoor": handleListByDoor,
  });
}
