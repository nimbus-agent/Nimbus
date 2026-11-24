import { renderInvestigation } from "../agents/_lib/investigation-render.ts";
import type { SynthesisRunner } from "../agents/_lib/synthesis-llm.ts";
import type { Investigation } from "../incident/investigate.ts";
import type { LiveInvestigator } from "../investigation/investigation-live.ts";
import { LiveInvestigateError } from "../investigation/investigation-live.ts";
import { draftInvestigation } from "../investigation/investigation-synthesis.ts";
import type { RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import {
  dispatchIncidentRpc,
  type IncidentRpcCaller,
  type IncidentRpcCtx,
  IncidentRpcError,
  requireOwnerKind,
} from "./incident-rpc.ts";
import { requireKeys, stringParam } from "./incident-rpc-params.ts";
import type { ClientKind } from "./server/client-kind.ts";

/**
 * `incident.investigateSynthesize` (Phase 10 IC9a, `nimbus incident investigate --synthesize`) and
 * `incident.investigateLive` (owner ruling 9, `nimbus incident investigate --live`).
 *
 *   incident.investigateSynthesize { id, live?, budgetSeconds? } -> { recordId, version, markdown, synthesis }
 *   incident.investigateLive { id, budgetSeconds? }              -> { investigation, markdown }
 *
 * Both serve only a connection whose DECLARED kind is `cli` or `ui` (`requireOwnerKind`, before anything is read);
 * the `incident` namespace is LAN-forbidden (I5) and not renderer-callable (I7). The investigation is the
 * existing `incident.investigate` (index only: no model, no live call), obtained through that same handler so
 * a trigger with no stored record is assembled and resolved identically. A model is reached ONLY by
 * `incident.investigateSynthesize`, only on this owner request, never unattended (OR-10-8); with no usable model
 * the reply is the deterministic investigation and `synthesis.attempted` is `false`.
 *
 * A LIVE read is stricter than the owner kinds: only a connection that declared `cli` (`requireLiveKind`; the
 * desktop is refused, its renderer cannot reach the method at all), and only for the request that names it
 * (`incident.investigateLive`, or `live: true` on the synthesize call, whose model then sees the live rows only
 * through the I11 envelope `synthesize()` wraps the brief in). Without a model request the live rows go to no
 * model. The live rows are returned to the asking terminal once and never stored.
 */

export interface InvestigationRpcCtx {
  readonly incident: IncidentRpcCtx;
  readonly now: () => number;
  /** Builds the synthesis runner for `agents.incident_investigation`; `undefined` when no model can be used. */
  readonly runner: () => SynthesisRunner | undefined;
  /** The live investigator (`gateway-main.ts` binds it; `undefined` on a demo gateway, I41). */
  readonly live?: LiveInvestigator | undefined;
}

const LIVE_BUDGET_MAX_SECONDS = 60;

/** Only a connection that DECLARED `cli` may start a live read; the desktop and every other kind is refused. */
export function requireLiveKind(kind: ClientKind): void {
  if (kind !== "cli") {
    throw new IncidentRpcError(
      -32000,
      "ERR_INVESTIGATE_LIVE_CLI_ONLY: a live investigation can be started only from the terminal (nimbus incident investigate --live), on a connection that declared its kind",
    );
  }
}

function budgetMsOf(method: string, p: Record<string, unknown>): number | undefined {
  const v = p["budgetSeconds"];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > LIVE_BUDGET_MAX_SECONDS) {
    throw new IncidentRpcError(
      -32602,
      `${method}: budgetSeconds must be an integer 1..${String(LIVE_BUDGET_MAX_SECONDS)}`,
    );
  }
  return v * 1000;
}

async function investigationOf(
  ctx: InvestigationRpcCtx,
  caller: IncidentRpcCaller,
  id: string,
  live: { readonly budgetMs: number | undefined } | undefined,
): Promise<Investigation> {
  const hit = await dispatchIncidentRpc("incident.investigate", { id }, ctx.incident, caller);
  if (hit.kind !== "hit") throw new IncidentRpcError(-32603, "incident.investigate: no reader");
  const base = (hit.value as { investigation: Investigation }).investigation;
  if (live === undefined) return base;
  if (ctx.live === undefined || caller.clientId === undefined || caller.clientId === "") {
    throw new IncidentRpcError(
      -32000,
      "ERR_INVESTIGATE_LIVE_UNAVAILABLE: this gateway cannot make a live read (a demo gateway, or one still starting)",
    );
  }
  try {
    return await ctx.live.run({
      investigation: base,
      clientId: caller.clientId,
      ...(live.budgetMs === undefined ? {} : { budgetMs: live.budgetMs }),
    });
  } catch (e) {
    if (e instanceof LiveInvestigateError)
      throw new IncidentRpcError(-32000, `${e.code}: ${e.message}`);
    throw e;
  }
}

export async function dispatchInvestigationRpc(
  method: string,
  params: unknown,
  ctx: InvestigationRpcCtx,
  caller: IncidentRpcCaller,
): Promise<RpcMissOrHit> {
  if (method !== "incident.investigateSynthesize" && method !== "incident.investigateLive") {
    return { kind: "miss" };
  }
  requireOwnerKind(caller.kind);
  const isLive = method === "incident.investigateLive";
  const p = requireKeys(
    method,
    params,
    isLive ? ["id", "budgetSeconds"] : ["id", "live", "budgetSeconds"],
  );
  const id = stringParam(method, p, "id", 256);
  if (id === undefined) {
    throw new IncidentRpcError(-32602, `${method}: id must be a non-empty string`);
  }
  if (!isLive && p["live"] !== undefined && typeof p["live"] !== "boolean") {
    throw new IncidentRpcError(-32602, `${method}: live must be a boolean`);
  }
  const wantsLive = isLive || p["live"] === true;
  if (wantsLive) requireLiveKind(caller.kind);
  const budgetMs = wantsLive ? budgetMsOf(method, p) : undefined;
  if (!wantsLive && p["budgetSeconds"] !== undefined) {
    throw new IncidentRpcError(-32602, `${method}: budgetSeconds applies only with live`);
  }
  const investigation = await investigationOf(
    ctx,
    caller,
    id,
    wantsLive ? { budgetMs } : undefined,
  );
  if (isLive) {
    return {
      kind: "hit",
      value: { investigation, markdown: renderInvestigation(investigation) },
    };
  }
  const draft = await draftInvestigation({
    investigation,
    nowMs: ctx.now(),
    runner: ctx.runner(),
  });
  return {
    kind: "hit",
    value: {
      recordId: draft.recordId,
      version: draft.version,
      markdown: draft.markdown,
      synthesis: draft.synthesis,
    },
  };
}
