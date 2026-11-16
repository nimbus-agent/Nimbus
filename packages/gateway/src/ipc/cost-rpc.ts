import type { Database } from "bun:sqlite";

import { DEFAULT_FINOPS_CONFIG, loadNimbusFinopsFromConfigDir } from "../config/finops-toml.ts";
import {
  COST_ANOMALY_MAX_DAYS,
  type CostAnomalyResult,
  queryCostAnomalies,
} from "../finops/cost-anomaly-query.ts";
import { isCostServiceId } from "../finops/cost-item-contract.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class CostRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** What `cost.anomalies` needs: the local index and (optionally) the config dir for `[finops]`. */
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

export async function dispatchCostRpc(
  method: string,
  params: unknown,
  ctx: CostRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod(method, params, ctx, { "cost.anomalies": handleAnomalies });
}
