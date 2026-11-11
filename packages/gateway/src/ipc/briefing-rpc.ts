import { BriefingBusyError, type BriefingRuntime } from "../briefing/briefing-runtime.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

/**
 * `briefing.*` (Phase 10 MB5): the morning briefing, read from the local index and delivered locally.
 *
 *   briefing.latest {}          -> { run }   newest successful run with its Markdown, or null
 *   briefing.list {limit?}      -> { runs }  newest first, no Markdown (1..100, default 20)
 *   briefing.get {id}           -> { run }   or -32602 ERR_BRIEFING_NOT_FOUND
 *   briefing.status {}          -> the config echo, next fire, last run, deadline scan, sources
 *   briefing.runNow {}          -> { run }   composes one now (CLI only), or -32000 ERR_BRIEFING_BUSY
 *
 * The four reads are renderer-callable (I7); `runNow` is CLI-only. The whole namespace is LAN-forbidden
 * (I5): the briefing restates the owner's PRs, incidents, mail subjects, calendar and on-call.
 */
export class BriefingRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface BriefingRpcCtx {
  readonly runtime: BriefingRuntime;
}

export const BRIEFING_LIST_DEFAULT = 20;
export const BRIEFING_LIST_MAX = 100;

function requireKeys(
  method: string,
  params: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (params === undefined) return {};
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new BriefingRpcError(-32602, `${method} requires an object payload`);
  }
  const p = params as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!allowed.includes(key)) {
      throw new BriefingRpcError(-32602, `${method}: unknown parameter "${key}"`);
    }
  }
  return p;
}

function parseLimit(p: Record<string, unknown>): number {
  const raw = p["limit"];
  if (raw === undefined) return BRIEFING_LIST_DEFAULT;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > BRIEFING_LIST_MAX) {
    throw new BriefingRpcError(
      -32602,
      `briefing.list: limit must be an integer 1..${String(BRIEFING_LIST_MAX)}`,
    );
  }
  return raw;
}

function parseId(p: Record<string, unknown>): string {
  const raw = p["id"];
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > 128) {
    throw new BriefingRpcError(-32602, "briefing.get: id must be a non-empty string");
  }
  return raw.trim();
}

export async function dispatchBriefingRpc(
  method: string,
  params: unknown,
  ctx: BriefingRpcCtx,
): Promise<RpcMissOrHit> {
  const rt = ctx.runtime;
  return dispatchByMethod<BriefingRpcCtx, unknown>(method, params, ctx, {
    "briefing.latest": (raw) => {
      requireKeys("briefing.latest", raw, []);
      return { run: rt.latest() };
    },
    "briefing.list": (raw) => ({
      runs: rt.list(parseLimit(requireKeys("briefing.list", raw, ["limit"]))),
    }),
    "briefing.get": (raw) => {
      const id = parseId(requireKeys("briefing.get", raw, ["id"]));
      const run = rt.get(id);
      if (run === null) {
        throw new BriefingRpcError(-32602, `ERR_BRIEFING_NOT_FOUND: no briefing run "${id}"`);
      }
      return { run };
    },
    "briefing.status": (raw) => {
      requireKeys("briefing.status", raw, []);
      return rt.status();
    },
    "briefing.runNow": async (raw) => {
      requireKeys("briefing.runNow", raw, []);
      try {
        return { run: await rt.runNow() };
      } catch (e) {
        if (e instanceof BriefingBusyError) {
          throw new BriefingRpcError(-32000, `${e.code}: ${e.message}`);
        }
        throw e;
      }
    },
  });
}
