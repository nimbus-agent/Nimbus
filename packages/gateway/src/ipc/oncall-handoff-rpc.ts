import type { Database } from "bun:sqlite";

import { loadServiceConfigsOrEmpty } from "../config/service-configs.ts";
import {
  HANDOFF_MAX_WINDOW_MS,
  type OncallHandoffResult,
  queryOncallHandoff,
} from "../index/oncall-handoff-query.ts";
import { AtTimeError, parseAtTime } from "../util/point-in-time-parse.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import { OncallNowRpcError } from "./oncall-now-rpc.ts";

/**
 * `oncall.handoff` (Phase 17): the on-call handoff brief, from the local index only. Read-only, no HITL,
 * no connector, no model. LAN-forbidden by the whole `oncall` namespace entry (I5); renderer-callable (I7).
 */
export interface OncallHandoffRpcCtx {
  readonly db: Database;
  readonly configDir?: string;
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
}

export const ONCALL_HANDOFF_MAX_SERVICE_CHARS = 128;
const PARAMS = new Set(["since", "until", "service"]);

type Parsed = { since?: string; until?: string; service?: string };

function parseParams(params: unknown): Parsed {
  if (params === undefined) return {};
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new OncallNowRpcError(-32602, "oncall.handoff requires an object payload");
  }
  const p = params as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!PARAMS.has(key)) {
      throw new OncallNowRpcError(-32602, `oncall.handoff: unknown parameter "${key}"`);
    }
  }
  const out: Parsed = {};
  for (const key of ["since", "until"] as const) {
    const raw = p[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string" || raw.trim() === "" || raw.length > 64) {
      throw new OncallNowRpcError(-32602, `oncall.handoff: ${key} must be a time string`);
    }
    out[key] = raw.trim();
  }
  const service = p["service"];
  if (service !== undefined) {
    if (
      typeof service !== "string" ||
      service.trim() === "" ||
      service.length > ONCALL_HANDOFF_MAX_SERVICE_CHARS
    ) {
      throw new OncallNowRpcError(
        -32602,
        `oncall.handoff: service must be a non-empty string up to ${String(ONCALL_HANDOFF_MAX_SERVICE_CHARS)} characters`,
      );
    }
    out.service = service.trim();
  }
  return out;
}

function parseTime(name: string, raw: string, nowMs: number): number {
  try {
    return parseAtTime(raw, nowMs);
  } catch (e) {
    if (e instanceof AtTimeError) {
      throw new OncallNowRpcError(-32602, `oncall.handoff: ${name}: ${e.message}`);
    }
    throw e;
  }
}

function handleHandoff(params: unknown, ctx: OncallHandoffRpcCtx): OncallHandoffResult {
  const p = parseParams(params);
  const nowMs = (ctx.now ?? Date.now)();
  const sinceMs = p.since === undefined ? undefined : parseTime("since", p.since, nowMs);
  const untilMs = p.until === undefined ? undefined : parseTime("until", p.until, nowMs);
  if (sinceMs !== undefined && untilMs !== undefined && sinceMs >= untilMs) {
    throw new OncallNowRpcError(-32602, "oncall.handoff: since must be earlier than until");
  }
  if (sinceMs !== undefined && (untilMs ?? nowMs) - sinceMs > HANDOFF_MAX_WINDOW_MS) {
    throw new OncallNowRpcError(
      -32602,
      `oncall.handoff: the window may be at most ${String(HANDOFF_MAX_WINDOW_MS / 86_400_000)} days`,
    );
  }
  const warn =
    ctx.warn ??
    ((m: string): void => {
      process.stderr.write(`oncall.handoff: ${m}\n`);
    });
  const serviceConfigs = loadServiceConfigsOrEmpty(ctx.configDir, warn).map((c) => ({
    serviceId: c.serviceId,
    pagerdutyServices: c.pagerdutyServices,
    jsmAlertTags: c.jsmAlertTags,
    incidentWindowMinutes: c.incidentWindowMinutes,
  }));
  return queryOncallHandoff(ctx.db, {
    nowMs,
    serviceConfigs,
    ...(sinceMs === undefined ? {} : { sinceMs }),
    ...(untilMs === undefined ? {} : { untilMs }),
    ...(p.service === undefined ? {} : { service: p.service }),
  });
}

export async function dispatchOncallHandoffRpc(
  method: string,
  params: unknown,
  ctx: OncallHandoffRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod(method, params, ctx, { "oncall.handoff": handleHandoff });
}
