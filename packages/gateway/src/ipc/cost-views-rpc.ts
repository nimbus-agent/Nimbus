import type { Database } from "bun:sqlite";

import {
  DEFAULT_COST_CONFIG,
  loadNimbusCostFromConfigDir,
  type NimbusCostConfig,
} from "../config/cost-toml.ts";
import {
  type ClusterAllocationRow,
  readClusterAllocations,
} from "../finops/cost-allocation-adapter.ts";
import { gatherCostViewInput } from "../finops/cost-view-input.ts";
import {
  type CostViewResult,
  type CostWindow,
  internalView,
  periodWindow,
  productView,
} from "../finops/cost-views.ts";
import type { ClientKind } from "./server/client-kind.ts";

/**
 * `cost.products` and `cost.internal` (Phase 7, the Cost Pack): the allocation views over the local cost lines
 * and the owner's `[[cost.rule]]` rules. Reads of the local index only: no network, no model, no egress row.
 * They restate the owner's spend per product and env, so they serve only a connection whose DECLARED kind is
 * `cli` or `ui` (`ctx.getClientKind`, never a param). The `cost` namespace is LAN-forbidden (I5); neither is on
 * the renderer allowlist yet (I7: the desktop page is a later change). A demo gateway answers from its seeded lines.
 */
export class CostViewsRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CostViewsRpcCtx {
  readonly db: Database;
  readonly configDir?: string;
  readonly caller?: { readonly kind: ClientKind };
  readonly now?: () => number;
}

export interface ClusterViewResult {
  readonly view: "cluster";
  readonly range: CostWindow;
  readonly rows: ClusterAllocationRow[];
}

const OWNER_KINDS: ReadonlySet<ClientKind> = new Set<ClientKind>(["cli", "ui"]);

export function requireOwner(ctx: CostViewsRpcCtx, method: string): void {
  if (ctx.caller === undefined || !OWNER_KINDS.has(ctx.caller.kind)) {
    throw new CostViewsRpcError(
      -32000,
      `ERR_COST_FORBIDDEN_CLIENT: ${method} is served only to the owner's own surfaces (the CLI and the desktop), on a connection that declared its kind`,
    );
  }
}

export function params(
  raw: unknown,
  method: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CostViewsRpcError(-32602, `${method} requires an object payload`);
  }
  const p = raw as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (!allowed.includes(k))
      throw new CostViewsRpcError(-32602, `${method}: unknown parameter "${k}"`);
  }
  return p;
}

export function windowOf(p: Record<string, unknown>, method: string, nowMs: number): CostWindow {
  const period = p["period"] ?? "30d";
  const w = typeof period === "string" ? periodWindow(period, nowMs) : undefined;
  if (w === undefined) {
    throw new CostViewsRpcError(-32602, `${method}: period must be <N>d (1 to 400), week or month`);
  }
  return w;
}

export function config(ctx: CostViewsRpcCtx): NimbusCostConfig {
  return ctx.configDir === undefined
    ? DEFAULT_COST_CONFIG
    : loadNimbusCostFromConfigDir(ctx.configDir);
}

export function handleCostProducts(
  raw: unknown,
  ctx: CostViewsRpcCtx,
): CostViewResult | ClusterViewResult {
  requireOwner(ctx, "cost.products");
  const p = params(raw, "cost.products", ["period", "allocation"]);
  const nowMs = (ctx.now ?? Date.now)();
  const range = windowOf(p, "cost.products", nowMs);
  const allocation = p["allocation"];
  if (allocation !== undefined && allocation !== "cluster") {
    throw new CostViewsRpcError(-32602, "cost.products: allocation must be cluster");
  }
  if (allocation === "cluster")
    return { view: "cluster", range, rows: readClusterAllocations(ctx.db, range) };
  return productView(gatherCostViewInput(ctx.db, config(ctx), range, nowMs));
}

export function handleCostInternal(raw: unknown, ctx: CostViewsRpcCtx): CostViewResult {
  requireOwner(ctx, "cost.internal");
  const p = params(raw, "cost.internal", ["period"]);
  const nowMs = (ctx.now ?? Date.now)();
  const range = windowOf(p, "cost.internal", nowMs);
  const cfg = config(ctx);
  return internalView(gatherCostViewInput(ctx.db, cfg, range, nowMs), cfg.internalEnvs);
}
