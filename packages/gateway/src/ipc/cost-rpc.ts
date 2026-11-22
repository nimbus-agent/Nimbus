import type { Database } from "bun:sqlite";

import { DEFAULT_FINOPS_CONFIG, loadNimbusFinopsFromConfigDir } from "../config/finops-toml.ts";
import {
  COST_ANOMALY_MAX_DAYS,
  type CostAnomalyResult,
  queryCostAnomalies,
} from "../finops/cost-anomaly-query.ts";
import { isCostServiceId } from "../finops/cost-item-contract.ts";
import { isWasteKind, WASTE_KINDS } from "../finops/cost-waste.ts";
import { type CostWasteResult, queryCostWaste } from "../finops/cost-waste-query.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class CostRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** What `cost.anomalies` and `cost.waste` need: the local index and (optionally) the config dir for `[finops]`. */
export interface CostRpcCtx {
  readonly db: Database;
  readonly configDir?: string;
  readonly now?: () => number;
}

interface Parsed {
  readonly service?: string;
  readonly days: number;
}

function parseParams(params: unknown): Parsed {
  if (params === undefined) return { days: 1 };
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new CostRpcError(-32602, "cost.anomalies requires an object payload");
  }
  const p = params as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (key !== "service" && key !== "days") {
      throw new CostRpcError(-32602, `cost.anomalies: unknown parameter "${key}"`);
    }
  }
  const service = p["service"];
  if (service !== undefined && (typeof service !== "string" || !isCostServiceId(service))) {
    throw new CostRpcError(
      -32602,
      "cost.anomalies: service must be a cost service id (for example vantage)",
    );
  }
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
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new CostRpcError(-32602, "cost.waste requires an object payload");
  }
  const p = params as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (key !== "service" && key !== "kind") {
      throw new CostRpcError(-32602, `cost.waste: unknown parameter "${key}"`);
    }
  }
  const service = p["service"];
  if (service !== undefined && (typeof service !== "string" || !isCostServiceId(service))) {
    throw new CostRpcError(
      -32602,
      "cost.waste: service must be a cost service id (for example vantage)",
    );
  }
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
  return dispatchByMethod<CostRpcCtx, CostAnomalyResult | CostWasteResult>(method, params, ctx, {
    "cost.anomalies": handleAnomalies,
    "cost.waste": handleWaste,
  });
}
