import type { Database } from "bun:sqlite";

import { DEFAULT_FINOPS_CONFIG, loadNimbusFinopsFromConfigDir } from "../config/finops-toml.ts";
import {
  COST_ANOMALY_MAX_DAYS,
  type CostAnomalyResult,
  queryCostAnomalies,
} from "../finops/cost-anomaly-query.ts";
import type { ImportReport } from "../finops/cost-import.ts";
import { isCostServiceId } from "../finops/cost-item-contract.ts";
import type { CostRulesCheck } from "../finops/cost-rules-check.ts";
import type { CostViewResult } from "../finops/cost-views.ts";
import { isWasteKind, WASTE_KINDS } from "../finops/cost-waste.ts";
import { type CostWasteResult, queryCostWaste } from "../finops/cost-waste-query.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import { CostImportRpcError, handleCostImport, handleCostImportRemove } from "./cost-import-rpc.ts";
import {
  type ClusterViewResult,
  CostViewsRpcError,
  handleCostInternal,
  handleCostProducts,
} from "./cost-views-rpc.ts";
import {
  type CostWhyEmpty,
  type CostWhyResult,
  handleCostRulesCheck,
  handleCostWhy,
} from "./cost-why-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

export class CostRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * What the `cost.*` methods need: the local index, (optionally) the config dir for `[finops]` and `[cost]`, the
 * connection's DECLARED kind (`ctx.getClientKind`, never a param; the owner-only methods check it) and whether the
 * gateway is demo-rooted (I41).
 */
export interface CostRpcCtx {
  readonly db: Database;
  readonly configDir?: string;
  readonly now?: () => number;
  readonly caller?: { readonly kind: ClientKind };
  readonly demo?: boolean;
}

/** Run an import handler, carrying its error as a `CostRpcError` with the same code. */
function viaImport<T>(
  fn: (params: unknown, ctx: CostRpcCtx) => T,
): (params: unknown, ctx: CostRpcCtx) => T {
  return (params, ctx) => {
    try {
      return fn(params, ctx);
    } catch (e) {
      if (e instanceof CostImportRpcError || e instanceof CostViewsRpcError) {
        throw new CostRpcError(e.rpcCode, e.message);
      }
      throw e;
    }
  };
}

interface Parsed {
  readonly service?: string;
  readonly days: number;
}

/** A `cost.*` params object holding no key but `allowed`; anything else is -32602 naming `method`. */
function paramsObject(
  params: unknown,
  method: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new CostRpcError(-32602, `${method} requires an object payload`);
  }
  const p = params as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!allowed.includes(key)) {
      throw new CostRpcError(-32602, `${method}: unknown parameter "${key}"`);
    }
  }
  return p;
}

/** The optional `service` param: absent, or a cost service id. */
function serviceParam(p: Record<string, unknown>, method: string): string | undefined {
  const service = p["service"];
  if (service !== undefined && (typeof service !== "string" || !isCostServiceId(service))) {
    throw new CostRpcError(
      -32602,
      `${method}: service must be a cost service id (for example vantage)`,
    );
  }
  return service;
}

function parseParams(params: unknown): Parsed {
  if (params === undefined) return { days: 1 };
  const p = paramsObject(params, "cost.anomalies", ["service", "days"]);
  const service = serviceParam(p, "cost.anomalies");
  const days = p["days"] ?? 1;
  if (
    typeof days !== "number" ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > COST_ANOMALY_MAX_DAYS
  ) {
    throw new CostRpcError(
      -32602,
      `cost.anomalies: days must be an integer 1..${String(COST_ANOMALY_MAX_DAYS)}`,
    );
  }
  return { days, ...(service === undefined ? {} : { service }) };
}

function handleAnomalies(params: unknown, ctx: CostRpcCtx): CostAnomalyResult {
  const { service, days } = parseParams(params);
  const cfg =
    ctx.configDir === undefined
      ? DEFAULT_FINOPS_CONFIG
      : loadNimbusFinopsFromConfigDir(ctx.configDir);
  return queryCostAnomalies(ctx.db, {
    nowMs: (ctx.now ?? Date.now)(),
    days,
    thresholds: { ratio: cfg.anomalyRatio, minAmount: cfg.anomalyMinAmount },
    ...(service === undefined ? {} : { service }),
  });
}

/** `cost.waste` params: an optional cost service id and an optional waste kind, nothing else. */
function parseWasteParams(params: unknown): {
  service?: string;
  kind?: (typeof WASTE_KINDS)[number];
} {
  if (params === undefined) return {};
  const p = paramsObject(params, "cost.waste", ["service", "kind"]);
  const service = serviceParam(p, "cost.waste");
  const kind = p["kind"];
  if (kind !== undefined && !isWasteKind(kind)) {
    throw new CostRpcError(-32602, `cost.waste: kind must be one of ${WASTE_KINDS.join(", ")}`);
  }
  return {
    ...(service === undefined ? {} : { service }),
    ...(kind === undefined ? {} : { kind }),
  };
}

/** `cost.waste` - the waste report over the indexed FinOps recommendations; local index only. */
function handleWaste(params: unknown, ctx: CostRpcCtx): CostWasteResult {
  return queryCostWaste(ctx.db, { nowMs: (ctx.now ?? Date.now)(), ...parseWasteParams(params) });
}

export async function dispatchCostRpc(
  method: string,
  params: unknown,
  ctx: CostRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<
    CostRpcCtx,
    | CostAnomalyResult
    | CostWasteResult
    | ImportReport
    | { importId: string; removed: number }
    | CostViewResult
    | ClusterViewResult
    | CostWhyResult
    | CostWhyEmpty
    | CostRulesCheck
  >(method, params, ctx, {
    "cost.anomalies": handleAnomalies,
    "cost.waste": handleWaste,
    "cost.import": viaImport(handleCostImport),
    "cost.importRemove": viaImport(handleCostImportRemove),
    "cost.products": viaImport(handleCostProducts),
    "cost.internal": viaImport(handleCostInternal),
    "cost.why": viaImport(handleCostWhy),
    "cost.rulesCheck": viaImport(handleCostRulesCheck),
  });
}
