import type { SynthesisRunner } from "../agents/_lib/synthesis-llm.ts";
import type { Investigation } from "../incident/investigate.ts";
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

/**
 * `incident.investigateSynthesize` (Phase 10 IC9a, `nimbus incident investigate --synthesize`).
 *
 *   incident.investigateSynthesize { id } -> { recordId, version, markdown, synthesis }
 *
 * Serves only a connection whose DECLARED kind is `cli` or `ui` (`requireOwnerKind`, before anything is read);
 * the `incident` namespace is LAN-forbidden (I5) and not renderer-callable (I7). The investigation is the
 * existing `incident.investigate` (index only: no model, no live call), obtained through that same handler so
 * a trigger with no stored record is assembled and resolved identically. A model is reached ONLY here, only on
 * this owner request, never unattended (OR-10-8); with no usable model the reply is the deterministic
 * investigation and `synthesis.attempted` is `false`.
 */

export interface InvestigationRpcCtx {
  readonly incident: IncidentRpcCtx;
  readonly now: () => number;
  /** Builds the synthesis runner for `agents.incident_investigation`; `undefined` when no model can be used. */
  readonly runner: () => SynthesisRunner | undefined;
}

export async function dispatchInvestigationRpc(
  method: string,
  params: unknown,
  ctx: InvestigationRpcCtx,
  caller: IncidentRpcCaller,
): Promise<RpcMissOrHit> {
  if (method !== "incident.investigateSynthesize") return { kind: "miss" };
  requireOwnerKind(caller.kind);
  const p = requireKeys(method, params, ["id"]);
  const id = stringParam(method, p, "id", 256);
  if (id === undefined) {
    throw new IncidentRpcError(-32602, `${method}: id must be a non-empty string`);
  }
  const hit = await dispatchIncidentRpc("incident.investigate", { id }, ctx.incident, caller);
  if (hit.kind !== "hit") throw new IncidentRpcError(-32603, `${method}: no investigation reader`);
  const investigation = (hit.value as { investigation: Investigation }).investigation;
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
