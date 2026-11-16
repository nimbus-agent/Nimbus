import type { Database } from "bun:sqlite";

import { loadNimbusServiceConfigsFromConfigDir } from "../config/nimbus-toml.ts";
import type { ServiceConfig } from "../metrics/dora-config.ts";
import { buildStatuspageModel, type StatuspageModel } from "../statuspage/statuspage-model.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class StatuspageRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** What `statuspage.model` needs: the local index and the config dir for `[ci.service.*]` blocks. */
export interface StatuspageRpcCtx {
  readonly db: Database;
  readonly configDir?: string;
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
}

export const STATUSPAGE_MAX_SERVICE_PARAMS = 20;
export const STATUSPAGE_MAX_SERVICE_CHARS = 128;

type Parsed = { services: string[]; titles: boolean; links: boolean };

function parseBool(p: Record<string, unknown>, key: string): boolean {
  const v = p[key];
  if (v === undefined) return false;
  if (typeof v !== "boolean") {
    throw new StatuspageRpcError(-32602, `statuspage.model: ${key} must be a boolean`);
  }
  return v;
}

function parseServices(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > STATUSPAGE_MAX_SERVICE_PARAMS) {
    throw new StatuspageRpcError(
      -32602,
      `statuspage.model: services must be an array of at most ${String(STATUSPAGE_MAX_SERVICE_PARAMS)} strings`,
    );
  }
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s !== "string" || s.trim() === "" || s.length > STATUSPAGE_MAX_SERVICE_CHARS) {
      throw new StatuspageRpcError(
        -32602,
        `statuspage.model: each service must be a non-empty string up to ${String(STATUSPAGE_MAX_SERVICE_CHARS)} characters`,
      );
    }
    out.push(s.trim());
  }
  return out;
}

function parseParams(params: unknown): Parsed {
  if (params === undefined) return { services: [], titles: false, links: false };
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new StatuspageRpcError(-32602, "statuspage.model requires an object payload");
  }
  const p = params as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (key !== "services" && key !== "titles" && key !== "links") {
      throw new StatuspageRpcError(-32602, `statuspage.model: unknown parameter "${key}"`);
    }
  }
  return {
    services: parseServices(p["services"]),
    titles: parseBool(p, "titles"),
    links: parseBool(p, "links"),
  };
}

function loadConfigs(
  configDir: string | undefined,
  warn: (m: string) => void,
): { configs: ReadonlyMap<string, ServiceConfig>; configError: boolean } {
  if (configDir === undefined) return { configs: new Map(), configError: false };
  try {
    return { configs: loadNimbusServiceConfigsFromConfigDir(configDir), configError: false };
  } catch (err) {
    warn(`failed to load [metrics.dora.*]/[ci.service.*] from nimbus.toml (${String(err)})`);
    return { configs: new Map(), configError: true };
  }
}

function handleModel(params: unknown, ctx: StatuspageRpcCtx): StatuspageModel {
  const p = parseParams(params);
  const warn =
    ctx.warn ??
    ((m: string): void => {
      process.stderr.write(`statuspage.model: ${m}\n`);
    });
  const { configs, configError } = loadConfigs(ctx.configDir, warn);
  return buildStatuspageModel(ctx.db, {
    nowMs: (ctx.now ?? Date.now)(),
    services: p.services,
    titles: p.titles,
    links: p.links,
    serviceConfigs: configs,
    configError,
  });
}

export async function dispatchStatuspageRpc(
  method: string,
  params: unknown,
  ctx: StatuspageRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod(method, params, ctx, { "statuspage.model": handleModel });
}
