import { ENGINE_PROPOSAL_ID_RE } from "../engine/incident-link.ts";
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
/** The top remediation proposal a push carried (IC5b): `nimbus oncall pushed <id> --remediate` acts on it. */
export type PushedBriefProposal = {
  recordId: string;
  proposalId: string;
  kind: string;
  toolId: string;
  reversibility: "reversible" | "irreversible" | "unknown";
  confidence: number | null;
  expiresAtMs: number;
};
export type PushedBriefDetail = PushedBriefSummary & {
  briefMarkdown: string | null;
  failureCode: string | null;
  delivery: Record<string, { outcome: string; reason?: string; at: number }>;
  /** Null when the push carried none, or the stored JSON does not hold a well-formed one. */
  proposal: PushedBriefProposal | null;
};

const LABEL_RE = /^[a-z0-9_]{1,64}$/;
const RECORD_ID_RE = /^inc_[0-9a-f]{16}$/;
const REVERSIBILITY = new Set(["reversible", "irreversible", "unknown"]);

/**
 * The proposal a stored brief carries, re-validated on every read: an id of the engine's own shape, a record id
 * of the record shape, labels from the gateway's own vocabulary. Anything else is null (no proposal), never an
 * error, so an older or damaged row still lists.
 */
export function pushedProposalOf(briefJson: string | null): PushedBriefProposal | null {
  if (briefJson === null) return null;
  let raw: unknown;
  try {
    raw = (JSON.parse(briefJson) as { proposal?: unknown }).proposal;
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const { recordId, id, kind, toolId, reversibility, confidence, expiresAtMs } = p;
  if (typeof id !== "string" || !ENGINE_PROPOSAL_ID_RE.test(id)) return null;
  if (typeof recordId !== "string" || !RECORD_ID_RE.test(recordId)) return null;
  if (typeof kind !== "string" || !LABEL_RE.test(kind)) return null;
  if (typeof toolId !== "string" || !LABEL_RE.test(toolId)) return null;
  if (typeof reversibility !== "string" || !REVERSIBILITY.has(reversibility)) return null;
  if (confidence !== null && (typeof confidence !== "number" || !Number.isFinite(confidence))) {
    return null;
  }
  if (typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs)) return null;
  return {
    recordId,
    proposalId: id,
    kind,
    toolId,
    reversibility: reversibility as PushedBriefProposal["reversibility"],
    confidence,
    expiresAtMs,
  };
}

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
    proposal: r.status === "ok" ? pushedProposalOf(r.briefJson) : null,
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
    enabled: ctx.runtime.isEnabled(),
    identity: (await ctx.runtime.identityResolved()) ? "resolved" : "unresolved",
    briefs: ctx.runtime.store
      .listWithIncident(limit)
      .map((l) => summarize(l.row, l.title, l.pagerdutyServiceId)),
    // For `nimbus doctor`: a namespace set while ChatOps is not running means every pushed brief
    // silently skips the channel (`delivery.chatops` = "ChatOps not running"). `namespace` is null
    // when unset, which is the intended "no chat sink" configuration, not a fault.
    chatops: {
      namespace:
        ctx.runtime.config.chatopsNamespace === "" ? null : ctx.runtime.config.chatopsNamespace,
      posting: ctx.runtime.chatopsSinkState() === "bound",
    },
    // Phase 10 IC3: the sources whose incident records may be pushed (default `["pagerduty"]`), whether the
    // incident engine assembles records automatically (a widened `sources` has no candidates without them),
    // and why records were NOT pushed on the last run (a silent non-push is diagnosable).
    sources: [...ctx.runtime.config.sources],
    incidentEngineEnabled: ctx.runtime.incidentEngineEnabled(),
    lastRun: ctx.runtime.lastRun(),
  };
}

function handleGet(params: unknown, ctx: OncallPushRpcCtx) {
  const id = incidentIdParam(obj(params, "oncall.pushedGet"), "oncall.pushedGet", false);
  const row = id === undefined ? ctx.runtime.store.newest() : ctx.runtime.store.get(id);
  return { brief: row === null ? null : detail(ctx, row) };
}

async function handleRetry(params: unknown, ctx: OncallPushRpcCtx) {
  const id = incidentIdParam(obj(params, "oncall.pushedRetry"), "oncall.pushedRetry", true);
  if (id === undefined)
    throw new OncallPushRpcError(-32602, "oncall.pushedRetry: incidentId is required");
  try {
    const { notDelivered, ...row } = await ctx.runtime.retry(id);
    return notDelivered === undefined
      ? { brief: detail(ctx, row) }
      : { brief: detail(ctx, row), notDelivered };
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
