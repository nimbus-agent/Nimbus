import { buildAgentSynthesisRunner } from "../../../agents/_lib/agent-synthesis-runner.ts";
import { BriefingRpcError, dispatchBriefingRpc } from "../../briefing-rpc.ts";
import { CostRpcError, dispatchCostRpc } from "../../cost-rpc.ts";
import { dispatchIacDriftRpc, IacDriftRpcError } from "../../iac-drift-rpc.ts";
import { dispatchIncidentRpc, IncidentRpcError, isOwnerKind } from "../../incident-rpc.ts";
import { dispatchIncidentUpdateRpc } from "../../incident-update-rpc.ts";
import { dispatchInvestigationRpc } from "../../investigation-rpc.ts";
import { dispatchNotificationsRpc } from "../../notifications-rpc.ts";
import { dispatchOncallHandoffRpc } from "../../oncall-handoff-rpc.ts";
import { dispatchOncallNowRpc, OncallNowRpcError } from "../../oncall-now-rpc.ts";
import { dispatchOncallPushRpc, OncallPushRpcError } from "../../oncall-push-rpc.ts";
import { dispatchPostmortemRpc } from "../../postmortem-rpc.ts";
import { dispatchPrereviewRpc, PrereviewRpcError } from "../../prreview-rpc.ts";
import { dispatchStatuspageRpc, StatuspageRpcError } from "../../statuspage-rpc.ts";
import { dispatchUpdateSynthesisRpc } from "../../update-synthesis-rpc.ts";
import { phase4RpcSkipped, type ServerCtx } from "../context.ts";
import { RpcMethodError } from "../rpc-error.ts";

/**
 * `oncall.now` (Phase 10 MB3) — who is on call, from the local index only, and `oncall.handoff` (Phase 17), the
 * shift handoff brief from the same index (read-only, no HITL). Separate from the push
 * dispatcher because that one needs the push runtime and this needs only the index and the config dir
 * (both on `ServerCtx.options`, so it also answers in a demo gateway, whose index is the synthetic
 * corpus). LAN-forbidden by the `oncall` namespace entry (I5); renderer-callable (I7).
 */
export async function tryDispatchOncallNowRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId?: string,
): Promise<unknown> {
  if (
    (method !== "oncall.now" && method !== "oncall.handoff") ||
    ctx.options.localIndex === undefined
  ) {
    return phase4RpcSkipped;
  }
  try {
    const rpcCtx = {
      db: ctx.options.localIndex.getDatabase(),
      ...(ctx.options.configDir === undefined ? {} : { configDir: ctx.options.configDir }),
      // IC9a: the incident-record sections of the handoff, for a connection that declared cli or ui only.
      includeRecords: clientId !== undefined && isOwnerKind(ctx.getClientKind(clientId)),
    };
    const out =
      method === "oncall.now"
        ? await dispatchOncallNowRpc(method, params, rpcCtx)
        : await dispatchOncallHandoffRpc(method, params, rpcCtx);
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof OncallNowRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

/**
 * `statuspage.model` (Phase 17) - the page model behind `nimbus statuspage draft`, from the local index
 * only (also answered by a demo gateway, whose index is the synthetic corpus). CLI-only: LAN-forbidden by
 * the `statuspage` namespace entry (I5) and absent from the Tauri allowlist (I7).
 */
export async function tryDispatchStatuspageRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (method !== "statuspage.model" || ctx.options.localIndex === undefined) {
    return phase4RpcSkipped;
  }
  try {
    const out = await dispatchStatuspageRpc(method, params, {
      db: ctx.options.localIndex.getDatabase(),
      ...(ctx.options.configDir === undefined ? {} : { configDir: ctx.options.configDir }),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof StatuspageRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

/**
 * `cost.anomalies` (Phase 10 FinOps) - the cost anomaly detector over the indexed daily cost series - and
 * `cost.waste` (the waste report over the indexed FinOps recommendations), local index only. Both also
 * answer in a demo gateway (no cost rows there: `no_data`). LAN-forbidden by the `cost`
 * namespace entry (I5); NOT renderer-callable (CLI only).
 */
export async function tryDispatchCostRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("cost.") || ctx.options.localIndex === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchCostRpc(method, params, {
      db: ctx.options.localIndex.getDatabase(),
      ...(ctx.options.configDir === undefined ? {} : { configDir: ctx.options.configDir }),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof CostRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

/**
 * `briefing.*` (Phase 10 MB5) - the morning briefing. Answered whenever the runtime exists, which includes
 * a demo gateway (its index is the synthetic corpus; `runNow` shows no toast there). The four reads are
 * renderer-callable (I7), `briefing.runNow` is CLI-only; the namespace is LAN-forbidden (I5).
 */
export async function tryDispatchBriefingRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("briefing.")) return phase4RpcSkipped;
  const rpc = ctx.options.briefingRpcCtx;
  if (rpc === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchBriefingRpc(method, params, rpc);
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof BriefingRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

/**
 * `incident.*` (Phase 10 IC3) - the incident records the engine assembled. Served only to a connection that
 * DECLARED `cli` or `ui` (the kind is the CONNECTION's, `getClientKind`, never a param; `requireOwnerKind`
 * answers every other kind with `ERR_INCIDENT_FORBIDDEN_CLIENT` before any query). The namespace is
 * LAN-forbidden (I5) and has no entry in the Tauri allowlist (I7); answered on a demo gateway too (its index is
 * the synthetic corpus, in its own database).
 */
export async function tryDispatchIncidentRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!method.startsWith("incident.")) return phase4RpcSkipped;
  const rpc = ctx.options.incidentRpcCtx;
  if (rpc === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchIncidentRpc(method, params, rpc, {
      kind: ctx.getClientKind(clientId),
      clientId,
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof IncidentRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

/**
 * `incident.updateSynthesize` (Phase 10 IC9b, owner ruling OR-S4-SCRIBE): an update draft whose lead paragraph a
 * model writes, only when the owner asked (`nimbus incident update --synthesize`). Owner kinds only; off the LAN
 * and the renderer like the rest of the `incident` namespace. It posts nothing; a send is a separate, approved call.
 */
export async function tryDispatchUpdateSynthesisRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (method !== "incident.updateSynthesize") return phase4RpcSkipped;
  const localIndex = ctx.options.localIndex;
  if (localIndex === undefined) return phase4RpcSkipped;
  const db = localIndex.getDatabase();
  try {
    const out = await dispatchUpdateSynthesisRpc(
      method,
      params,
      {
        db,
        now: () => Date.now(),
        runner: () =>
          buildAgentSynthesisRunner({
            configDir: ctx.options.configDir,
            db,
            router: ctx.options.llmRegistry?.llmRouter,
            method: "agents.incident_update",
          }),
      },
      { clientId, kind: ctx.getClientKind(clientId) },
    );
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof IncidentRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

/**
 * `incident.investigateSynthesize` (Phase 10 IC9a): the investigation of one record, offered to a model only
 * when the owner asked (`nimbus incident investigate --synthesize`). Owner kinds only (`requireOwnerKind`,
 * before anything is read); the incident namespace is LAN-forbidden (I5) and absent from the Tauri allowlist (I7).
 */
export async function tryDispatchInvestigationRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (method !== "incident.investigateSynthesize") return phase4RpcSkipped;
  const incident = ctx.options.incidentRpcCtx;
  const localIndex = ctx.options.localIndex;
  if (incident === undefined || localIndex === undefined) return phase4RpcSkipped;
  const db = localIndex.getDatabase();
  try {
    const out = await dispatchInvestigationRpc(
      method,
      params,
      {
        incident,
        now: () => Date.now(),
        runner: () =>
          buildAgentSynthesisRunner({
            configDir: ctx.options.configDir,
            db,
            router: ctx.options.llmRegistry?.llmRouter,
            method: "agents.incident_investigation",
          }),
      },
      { clientId, kind: ctx.getClientKind(clientId) },
    );
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof IncidentRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

/**
 * `incident.postmortem` and `incident.postmortemPush` (Phase 10 IC7a): the post-mortem draft and the owner's
 * HITL-gated page push. Owner kinds only (`requireOwnerKind`, before any query); the incident namespace is
 * LAN-forbidden (I5) and absent from the Tauri allowlist (I7). The push asks THIS connection's consent
 * channel; the draft reaches a model only when the request says `synthesize` (OR-10-8).
 */
export async function tryDispatchPostmortemRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (method !== "incident.postmortem" && method !== "incident.postmortemPush") {
    return phase4RpcSkipped;
  }
  const localIndex = ctx.options.localIndex;
  if (localIndex === undefined) return phase4RpcSkipped;
  const db = localIndex.getDatabase();
  const act = ctx.options.captureRpcCtx?.act;
  try {
    const out = await dispatchPostmortemRpc(
      method,
      params,
      {
        db,
        now: () => Date.now(),
        runner: () =>
          buildAgentSynthesisRunner({
            configDir: ctx.options.configDir,
            db,
            router: ctx.options.llmRegistry?.llmRouter,
            method: "agents.incident_postmortem",
          }),
        ...(act === undefined
          ? {}
          : {
              act: {
                dispatcher: act.dispatcher,
                egressSink: act.egressSink,
                audit: act.audit,
                policyHitl: act.policyHitl,
                getTribalKbConfig: act.getTribalKbConfig,
                ...(act.previewCredentialFor === undefined
                  ? {}
                  : { previewCredentialFor: act.previewCredentialFor }),
              },
            }),
      },
      { clientId, kind: ctx.getClientKind(clientId) },
      ctx.consentImpl,
    );
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof IncidentRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

/**
 * `incident.update`, `incident.updateSend` and `incident.updateQueue` (Phase 10 IC9b): the update draft, the
 * owner's HITL-gated Slack or Teams post and the scribe's queue. Owner kinds only (`requireOwnerKind`, before any
 * query); the incident namespace is LAN-forbidden (I5) and absent from the Tauri allowlist (I7). The send asks
 * THIS connection's consent channel and reads the ChatOps bindings of the LIVE enforced policy.
 */
export async function tryDispatchIncidentUpdateRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (
    method !== "incident.update" &&
    method !== "incident.updateSend" &&
    method !== "incident.updateQueue"
  ) {
    return phase4RpcSkipped;
  }
  const localIndex = ctx.options.localIndex;
  if (localIndex === undefined) return phase4RpcSkipped;
  const db = localIndex.getDatabase();
  const act = ctx.options.captureRpcCtx?.act;
  const enforced = ctx.options.enforcedPolicy;
  try {
    const out = await dispatchIncidentUpdateRpc(
      method,
      params,
      {
        db,
        now: () => Date.now(),
        dataDir: ctx.options.dataDir,
        chatops: () => enforced?.()?.chatops,
        ...(act === undefined
          ? {}
          : {
              act: {
                dispatcher: act.dispatcher,
                egressSink: act.egressSink,
                audit: act.audit,
                policyHitl: act.policyHitl,
                ...(act.previewCredentialFor === undefined
                  ? {}
                  : { previewCredentialFor: act.previewCredentialFor }),
              },
            }),
      },
      { clientId, kind: ctx.getClientKind(clientId) },
      ctx.consentImpl,
    );
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof IncidentRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchOncallPushRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("oncall.")) return phase4RpcSkipped;
  const rpc = ctx.options.oncallPushRpcCtx;
  if (rpc === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchOncallPushRpc(method, params, rpc);
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof OncallPushRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

/**
 * `notifications.*` (pre-S3 item E) — OS toast status and a fixed-text test toast. CLI-only:
 * LAN-forbidden (I5) and absent from the Tauri allowlist (I7). Neither method throws a domain error;
 * an undelivered test toast is reported as `{ delivered: false, reason }`.
 */
export async function tryDispatchNotificationsRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("notifications.")) return phase4RpcSkipped;
  const rpc = ctx.options.notificationsRpcCtx;
  if (rpc === undefined) return phase4RpcSkipped;
  const out = await dispatchNotificationsRpc(method, params, rpc);
  return out.kind === "hit" ? out.value : phase4RpcSkipped;
}

/**
 * `iac.*` (Phase 10 IaC drift D2, OR-DRIFT-1): the owner's read-only Terraform drift check. CLI only (the
 * CONNECTION's declared kind, never a param); LAN-forbidden (I5) and absent from the Tauri allowlist (I7).
 */
export async function tryDispatchIacDriftRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!method.startsWith("iac.")) return phase4RpcSkipped;
  const rpc = ctx.options.iacDriftRpcCtx;
  if (rpc === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchIacDriftRpc(method, params, rpc, {
      kind: ctx.getClientKind(clientId),
      clientId,
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof IacDriftRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

/**
 * `prreview.run` (Phase 10 "Automated PR pre-review"): the read-only pre-review brief. Owner kinds only (checked
 * in the module, before any query); the namespace is LAN-forbidden (I5) and absent from the Tauri allowlist
 * (I7). No model is reached.
 */
export async function tryDispatchPrereviewRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (method !== "prreview.run") return phase4RpcSkipped;
  const localIndex = ctx.options.localIndex;
  if (localIndex === undefined) return phase4RpcSkipped;
  const db = localIndex.getDatabase();
  try {
    const out = await dispatchPrereviewRpc(
      method,
      params,
      { db, now: () => Date.now() },
      { kind: ctx.getClientKind(clientId) },
    );
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof PrereviewRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}
