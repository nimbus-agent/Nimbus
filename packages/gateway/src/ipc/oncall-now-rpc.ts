import type { Database } from "bun:sqlite";

import { loadServiceConfigsOrEmpty } from "../config/service-configs.ts";
import { type OncallNowResult, queryOncallNow } from "../index/oncall-now-query.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class OncallNowRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** What `oncall.now` needs: the local index and (optionally) the config dir for `[ci.service.*]` bindings. */
export interface OncallNowRpcCtx {
  readonly db: Database;
  readonly configDir?: string;
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
}

export const ONCALL_NOW_MAX_SERVICE_CHARS = 128;

function parseService(params: unknown): string | undefined {
  if (params === undefined) return undefined;
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new OncallNowRpcError(-32602, "oncall.now requires an object payload");
  }
  const p = params as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (key !== "service") {
      throw new OncallNowRpcError(-32602, `oncall.now: unknown parameter "${key}"`);
    }
  }
  const raw = p["service"];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > ONCALL_NOW_MAX_SERVICE_CHARS) {
    throw new OncallNowRpcError(
      -32602,
      `oncall.now: service must be a non-empty string up to ${String(ONCALL_NOW_MAX_SERVICE_CHARS)} characters`,
    );
  }
  return raw.trim();
}

function handleNow(params: unknown, ctx: OncallNowRpcCtx): OncallNowResult {
  const term = parseService(params);
  const warn =
    ctx.warn ??
    ((m: string): void => {
      process.stderr.write(`oncall.now: ${m}\n`);
    });
  const serviceConfigs = loadServiceConfigsOrEmpty(ctx.configDir, warn).map((c) => ({
    serviceId: c.serviceId,
    pagerdutyServices: c.pagerdutyServices,
  }));
  return queryOncallNow(ctx.db, {
    nowMs: (ctx.now ?? Date.now)(),
    serviceConfigs,
    ...(term === undefined ? {} : { term }),
  });
}

export async function dispatchOncallNowRpc(
  method: string,
  params: unknown,
  ctx: OncallNowRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod(method, params, ctx, { "oncall.now": handleNow });
}
