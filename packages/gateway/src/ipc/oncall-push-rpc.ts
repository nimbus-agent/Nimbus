import { parseHeadlineBrief, resolvePushService } from "../oncall-push/push-headline.ts";
import { PushRetryRefusedError } from "../oncall-push/push-runner.ts";
import type { OncallPushRuntime } from "../oncall-push/push-runtime.ts";
import type { PushedBriefRow } from "../oncall-push/push-store.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class OncallPushRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}
export interface OncallPushRpcCtx {
  readonly runtime: OncallPushRuntime;
}
export type PushedBriefSummary = {
  incidentId: string;
  status: "ok" | "failed";
  createdAt: number;
  retriedAt: number | null;
  title: string | null;
  service: string | null;
};
export type PushedBriefDetail = PushedBriefSummary & {
  briefMarkdown: string | null;
  failureCode: string | null;
  delivery: Record<string, { outcome: string; reason?: string; at: number }>;
};

const MAX_ID = 512;

function obj(params: unknown, method: string): Record<string, unknown> {
  if (params === undefined) return {};
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new OncallPushRpcError(-32602, `${method} requires an object payload`);
  }
  return params as Record<string, unknown>;
}
function incidentIdParam(
  p: Record<string, unknown>,
  method: string,
  required: boolean,
): string | undefined {
  const v = p["incidentId"];
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || v.trim() === "" || v.length > MAX_ID) {
    throw new OncallPushRpcError(
      -32602,
      `${method}: incidentId must be a non-empty string up to ${MAX_ID} characters`,
    );
  }
  return v.trim();
}

function summarize(
  r: PushedBriefRow,
  title: string | null,
  pagerdutyServiceId: string | null,
): PushedBriefSummary {
  // Same rule as the ChatOps headline: a failed row has no usable brief.
  const brief = r.status === "ok" ? parseHeadlineBrief(r.briefJson) : null;
  return {
    incidentId: r.incidentId,
    status: r.status,
    createdAt: r.createdAt,
    retriedAt: r.retriedAt,
    title,
    service: resolvePushService(brief, pagerdutyServiceId),
  };
}
function detail(ctx: OncallPushRpcCtx, r: PushedBriefRow): PushedBriefDetail {
  const store = ctx.runtime.store;
  return {
    ...summarize(
      r,
      store.incidentTitle(r.incidentId),
      store.incidentPagerdutyServiceId(r.incidentId),
    ),
    briefMarkdown: r.briefMarkdown,
    failureCode: r.failureCode,
    delivery: { ...r.delivery },
  };
}

async function handleList(params: unknown, ctx: OncallPushRpcCtx) {
  const p = obj(params, "oncall.pushedList");
  const raw = p["limit"];
  let limit = 20;
  if (raw !== undefined) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 200) {
      throw new OncallPushRpcError(-32602, "oncall.pushedList: limit must be an integer 1..200");
    }
    limit = raw;
  }
  return {
    enabled: ctx.runtime.config.enabled,
    identity: (await ctx.runtime.identityResolved()) ? "resolved" : "unresolved",
    briefs: ctx.runtime.store
      .listWithIncident(limit)
      .map((l) => summarize(l.row, l.title, l.pagerdutyServiceId)),
  };
}

async function handleGet(params: unknown, ctx: OncallPushRpcCtx) {
  const id = incidentIdParam(obj(params, "oncall.pushedGet"), "oncall.pushedGet", false);
  const row = id === undefined ? ctx.runtime.store.newest() : ctx.runtime.store.get(id);
  return { brief: row === null ? null : detail(ctx, row) };
}

async function handleRetry(params: unknown, ctx: OncallPushRpcCtx) {
  const id = incidentIdParam(obj(params, "oncall.pushedRetry"), "oncall.pushedRetry", true);
  if (id === undefined)
    throw new OncallPushRpcError(-32602, "oncall.pushedRetry: incidentId is required");
  try {
    return { brief: detail(ctx, await ctx.runtime.retry(id)) };
  } catch (e) {
    if (e instanceof PushRetryRefusedError) {
      throw new OncallPushRpcError(
        e.code === "ERR_ONCALL_PUSH_NOT_FOUND" ? -32001 : -32002,
        e.message,
      );
    }
    throw e;
  }
}

export async function dispatchOncallPushRpc(
  method: string,
  params: unknown,
  ctx: OncallPushRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<OncallPushRpcCtx>(method, params, ctx, {
    "oncall.pushedList": handleList,
    "oncall.pushedGet": handleGet,
    "oncall.pushedRetry": handleRetry,
  });
}
