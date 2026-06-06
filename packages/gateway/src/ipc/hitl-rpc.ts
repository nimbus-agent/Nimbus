import type { Database } from "bun:sqlite";
import { delegatedApprovalBroker } from "../engine/delegated-approval-broker.ts";
import { type DelegationScopeKind, DelegationStore } from "../engine/delegation-store.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class HitlRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "HitlRpcError";
    this.rpcCode = rpcCode;
  }
}

export interface HitlRpcContext {
  readonly db: Database;
  readonly now?: () => number;
}

function rec(p: unknown): Record<string, unknown> {
  if (p === null || typeof p !== "object") {
    throw new HitlRpcError(-32602, "ERR_INVALID_PARAMS: object expected");
  }
  return p as Record<string, unknown>;
}
function str(r: Record<string, unknown>, k: string): string {
  const v = r[k];
  if (typeof v !== "string" || v.length === 0) {
    throw new HitlRpcError(-32602, `ERR_INVALID_PARAMS: ${k} must be a non-empty string`);
  }
  return v;
}
function num(r: Record<string, unknown>, k: string): number {
  const v = r[k];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new HitlRpcError(-32602, `ERR_INVALID_PARAMS: ${k} must be a number`);
  }
  return v;
}

export async function dispatchHitlRpc(
  method: string,
  params: unknown,
  ctx: HitlRpcContext,
): Promise<RpcMissOrHit> {
  const store = new DelegationStore(ctx.db);
  const now = (ctx.now ?? Date.now)();
  return dispatchByMethod<HitlRpcContext>(method, params, ctx, {
    "hitl.delegate": (p) => {
      const r = rec(p);
      const scopeKind = str(r, "scopeKind");
      if (scopeKind !== "action_type" && scopeKind !== "service") {
        throw new HitlRpcError(-32602, `ERR_INVALID_PARAMS: bad scopeKind ${scopeKind}`);
      }
      const expiresAt = num(r, "expiresAt");
      if (expiresAt <= now) {
        throw new HitlRpcError(-32602, "ERR_INVALID_PARAMS: expiresAt must be in the future");
      }
      const id = store.create({
        delegatePeer: str(r, "delegatePeer"),
        scopeKind: scopeKind as DelegationScopeKind,
        scopeValue: str(r, "scopeValue"),
        expiresAt,
        nowMs: now,
      });
      return { delegationId: id };
    },
    "hitl.revokeDelegation": (p) => {
      const r = rec(p);
      store.revoke(str(r, "delegationId"), now);
      return { ok: true };
    },
    "hitl.listDelegations": () => {
      return { delegations: store.listActive(now) };
    },
    "hitl.pendingQueue": () => {
      return { pending: delegatedApprovalBroker.listPending() };
    },
  });
}
