import type { Database } from "bun:sqlite";
import { asRecord } from "../connectors/unknown-record.ts";
import { pruneEgress } from "../egress/egress-prune.ts";
import { digestEgressWindow, signWindowDigest } from "../egress/egress-sign.ts";
import { egressHead, listEgress, proveWindow, verifyEgressChain } from "../egress/egress-verify.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  dispatchByMethod,
  type RpcMethodHandlerMap,
  type RpcMissOrHit,
} from "./_lib/dispatch-by-method.ts";

export class EgressRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "EgressRpcError";
    this.rpcCode = rpcCode;
  }
}

export interface EgressRpcCtx {
  readonly db: Database;
  readonly vault: NimbusVault;
  readonly now: () => number;
  /**
   * Owner-HITL approval broker for the sole mutation (`egress.prune`).
   * In production this MUST route through the fail-closed executor consent gate (I2).
   * Denied or timed-out → returns `false` → nothing is pruned (fail-closed).
   */
  readonly requestPruneApproval: (beforeTs: number) => Promise<boolean>;
}

function optInt(params: unknown, key: string): number | undefined {
  const rec = asRecord(params);
  if (rec === undefined || !(key in rec)) return undefined;
  const v = rec[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new EgressRpcError(-32602, `egress: ${key} must be a non-negative integer`);
  }
  return v;
}

function reqInt(params: unknown, key: string): number {
  const v = optInt(params, key);
  if (v === undefined)
    throw new EgressRpcError(-32602, `egress: ${key} (non-negative integer) required`);
  return v;
}

function handleList(params: unknown, ctx: EgressRpcCtx): { rows: ReturnType<typeof listEgress> } {
  return {
    rows: listEgress(ctx.db, {
      since: optInt(params, "since"),
      until: optInt(params, "until"),
      limit: optInt(params, "limit"),
    }),
  };
}

function handleVerify(_p: unknown, ctx: EgressRpcCtx): ReturnType<typeof verifyEgressChain> {
  return verifyEgressChain(ctx.db);
}

function handleHead(_p: unknown, ctx: EgressRpcCtx): ReturnType<typeof egressHead> {
  return egressHead(ctx.db);
}

async function handleProveWindow(
  params: unknown,
  ctx: EgressRpcCtx,
): Promise<
  ReturnType<typeof proveWindow> & {
    receipt?: { sigB64: string; pubkeyB64: string; digest: string };
  }
> {
  const window = proveWindow(ctx.db, {
    since: optInt(params, "since"),
    until: optInt(params, "until"),
  });
  const rec = asRecord(params);
  const sign = rec?.["sign"] === true;
  if (!sign) return window;
  const digest = digestEgressWindow(window.rows, {
    outboundEgressEvents: window.completeness.outboundEgressEvents,
    rowsTotal: window.rowsTotal,
  });
  const { sigB64, pubkeyB64 } = await signWindowDigest(ctx.vault, digest);
  return { ...window, receipt: { sigB64, pubkeyB64, digest } };
}

async function handlePrune(
  params: unknown,
  ctx: EgressRpcCtx,
): Promise<{ approved: boolean; prunedCount: number }> {
  const beforeTs = reqInt(params, "beforeTs");
  const approved = await ctx.requestPruneApproval(beforeTs);
  if (!approved) return { approved: false, prunedCount: 0 };
  const { prunedCount } = pruneEgress(ctx.db, beforeTs, ctx.now());
  return { approved: true, prunedCount };
}

const HANDLERS: RpcMethodHandlerMap<EgressRpcCtx> = {
  "egress.list": handleList,
  "egress.verify": handleVerify,
  "egress.head": handleHead,
  "egress.proveWindow": handleProveWindow,
  "egress.prune": handlePrune,
} as const;

export async function dispatchEgressRpc(
  method: string,
  params: unknown,
  ctx: EgressRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<EgressRpcCtx>(method, params, ctx, HANDLERS);
}
