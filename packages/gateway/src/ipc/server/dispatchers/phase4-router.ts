import { dispatchSessionRpc, SessionRpcError } from "../../session-rpc.ts";
import {
  deploymentRpcSkipped,
  metricsRpcSkipped,
  phase4RpcSkipped,
  preflightRpcSkipped,
  type ServerCtx,
  sessionRpcSkipped,
} from "../context.ts";
import { RpcMethodError } from "../rpc-error.ts";
import {
  tryDispatchApprovalsRpc,
  tryDispatchCaptureRpc,
  tryDispatchStandingRpc,
} from "./capture-rpcs.ts";
import {
  tryDispatchAgentsRpc,
  tryDispatchAuditRpc,
  tryDispatchFederationRpc,
  tryDispatchHitlRpc,
  tryDispatchIdentityRpc,
  tryDispatchLlmRpc,
  tryDispatchSecurityRpc,
  tryDispatchTeamVaultRpc,
  tryDispatchUpdaterRpc,
  tryDispatchVoiceRpc,
} from "./core-rpcs.ts";
import {
  tryDispatchDeploymentRpc,
  tryDispatchIndexRebodyRpc,
  tryDispatchIndexReembedRpc,
  tryDispatchMetricsRpc,
  tryDispatchPreflightRpc,
  tryDispatchReindexRpc,
} from "./index-rpcs.ts";
import {
  tryDispatchCatalogRpc,
  tryDispatchChatopsRpc,
  tryDispatchDataRpc,
  tryDispatchDemoRpc,
  tryDispatchFilesystemRpc,
  tryDispatchIndexDemoSymbolRpc,
  tryDispatchIndexRegraphRpc,
  tryDispatchLanRpc,
  tryDispatchLocalityRpc,
  tryDispatchPolicyRpc,
  tryDispatchProfileRpc,
  tryDispatchTourRpc,
} from "./local-surface-rpcs.ts";
import { tryDispatchMediaRpc } from "./media-rpcs.ts";
import { tryDispatchMigrationRpc } from "./migration-rpcs.ts";
import {
  tryDispatchBriefingRpc,
  tryDispatchCostRpc,
  tryDispatchIacDriftRpc,
  tryDispatchIncidentRpc,
  tryDispatchIncidentUpdateRpc,
  tryDispatchInvestigationRpc,
  tryDispatchNotificationsRpc,
  tryDispatchOncallNowRpc,
  tryDispatchOncallPushRpc,
  tryDispatchPostmortemRpc,
  tryDispatchStatuspageRpc,
  tryDispatchUpdateSynthesisRpc,
} from "./ops-rpcs.ts";
import {
  tryDispatchAdminRpc,
  tryDispatchClipRpc,
  tryDispatchDecisionsRpc,
  tryDispatchEgressRpc,
  tryDispatchGlossaryRpc,
  tryDispatchOwnershipRpc,
  tryDispatchPremortemRpc,
  tryDispatchShareRpc,
} from "./share-rpcs.ts";
import {
  tryDispatchComputerRpc,
  tryDispatchExecRpc,
  tryDispatchFleetRpc,
  tryDispatchToolgenRpc,
  tryDispatchTribalRpc,
} from "./tribal-compute-rpcs.ts";

/** First group of the phase-4 chain: llm → agents → voice → updater → audit → security → federation. */
async function dispatchPhase4CoreGroup(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  const llmOutcome = await tryDispatchLlmRpc(ctx, method, params);
  if (llmOutcome !== phase4RpcSkipped) return llmOutcome;
  const agentsOutcome = await tryDispatchAgentsRpc(ctx, method, params, clientId);
  if (agentsOutcome !== phase4RpcSkipped) return agentsOutcome;
  const voiceOutcome = await tryDispatchVoiceRpc(ctx, method, params);
  if (voiceOutcome !== phase4RpcSkipped) return voiceOutcome;
  const updaterOutcome = await tryDispatchUpdaterRpc(ctx, method, params);
  if (updaterOutcome !== phase4RpcSkipped) return updaterOutcome;
  const auditOutcome = await tryDispatchAuditRpc(ctx, method, params, clientId);
  if (auditOutcome !== phase4RpcSkipped) return auditOutcome;
  const securityOutcome = await tryDispatchSecurityRpc(ctx, method, params);
  if (securityOutcome !== phase4RpcSkipped) return securityOutcome;
  return tryDispatchFederationRpc(ctx, method, params);
}

/**
 * Second group: teamvault → hitl → identity → metrics → preflight → deployment → data.
 * Metrics/preflight/deployment carry their own skip sentinels (unique symbols), so a
 * non-sentinel outcome can never collide with `phase4RpcSkipped` in the caller.
 */
async function dispatchPhase4TeamMetricsGroup(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  const teamVaultOutcome = await tryDispatchTeamVaultRpc(ctx, method, params, clientId);
  if (teamVaultOutcome !== phase4RpcSkipped) return teamVaultOutcome;
  const hitlOutcome = await tryDispatchHitlRpc(ctx, method, params);
  if (hitlOutcome !== phase4RpcSkipped) return hitlOutcome;
  const identityOutcome = await tryDispatchIdentityRpc(ctx, method, params);
  if (identityOutcome !== phase4RpcSkipped) return identityOutcome;
  const metricsOutcome = await tryDispatchMetricsRpc(ctx, method, params);
  if (metricsOutcome !== metricsRpcSkipped) return metricsOutcome;
  const preflightOutcome = await tryDispatchPreflightRpc(ctx, method, params);
  if (preflightOutcome !== preflightRpcSkipped) return preflightOutcome;
  const deploymentOutcome = await tryDispatchDeploymentRpc(ctx, method, params);
  if (deploymentOutcome !== deploymentRpcSkipped) return deploymentOutcome;
  return tryDispatchDataRpc(ctx, method, params, clientId);
}

/** Third group: lan → profile → index-reembed → index-rebody → index-regraph → index-demoSymbol → tour → locality → demo → policy → chatops → tribal → share → egress → glossary → decisions → premortem → ownership → clip → admin. */
/**
 * The platform-group dispatchers, in probe order.
 *
 * ORDER IS THE CONTRACT and must not be reshuffled: each entry claims a method
 * namespace and returns `phase4RpcSkipped` when the method is not its own, so
 * the first one that recognises the method wins. Every dispatcher here owns a
 * disjoint namespace today, which is why the order is not currently
 * load-bearing for correctness — but nothing enforces that, so treat a
 * reordering as a behaviour change rather than a formatting one.
 *
 * Uniformly typed with the 4-arg signature: the several dispatchers that ignore
 * `clientId` are assignable to it, which is what lets this be a table at all.
 * It replaced eighteen hand-written `const x = await try…(); if (x !== skipped)
 * return x;` pairs — Sonar S3776 scored the result at 17 against a limit of 15,
 * and each new namespace made it worse.
 */
const PHASE4_PLATFORM_DISPATCHERS: ReadonlyArray<
  (ctx: ServerCtx, method: string, params: unknown, clientId: string) => Promise<unknown>
> = [
  tryDispatchLanRpc,
  tryDispatchProfileRpc,
  tryDispatchIndexReembedRpc,
  tryDispatchIndexRebodyRpc,
  tryDispatchIndexRegraphRpc,
  tryDispatchIndexDemoSymbolRpc,
  tryDispatchTourRpc,
  tryDispatchLocalityRpc,
  tryDispatchCatalogRpc,
  tryDispatchDemoRpc,
  tryDispatchFilesystemRpc,
  tryDispatchPolicyRpc,
  tryDispatchChatopsRpc,
  tryDispatchTribalRpc,
  tryDispatchShareRpc,
  tryDispatchExecRpc,
  tryDispatchToolgenRpc,
  tryDispatchComputerRpc,
  tryDispatchFleetRpc,
  tryDispatchOncallNowRpc,
  tryDispatchStatuspageRpc,
  tryDispatchCostRpc,
  tryDispatchOncallPushRpc,
  tryDispatchBriefingRpc,
  tryDispatchIncidentRpc,
  tryDispatchInvestigationRpc,
  tryDispatchUpdateSynthesisRpc,
  tryDispatchPostmortemRpc,
  tryDispatchIncidentUpdateRpc,
  tryDispatchNotificationsRpc,
  tryDispatchIacDriftRpc,
  tryDispatchCaptureRpc,
  tryDispatchApprovalsRpc,
  tryDispatchStandingRpc,
  tryDispatchMigrationRpc,
  tryDispatchMediaRpc,
  tryDispatchEgressRpc,
  tryDispatchGlossaryRpc,
  tryDispatchDecisionsRpc,
  tryDispatchPremortemRpc,
  tryDispatchOwnershipRpc,
  tryDispatchClipRpc,
];

async function dispatchPhase4PlatformGroup(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  for (const dispatch of PHASE4_PLATFORM_DISPATCHERS) {
    const outcome = await dispatch(ctx, method, params, clientId);
    if (outcome !== phase4RpcSkipped) return outcome;
  }
  // Admin is the terminal arm, not a table entry: its result is returned
  // whatever it is, including `phase4RpcSkipped`, which is how the caller
  // learns the whole group declined.
  return tryDispatchAdminRpc(ctx, method, params);
}

export async function tryDispatchPhase4Rpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  const coreOutcome = await dispatchPhase4CoreGroup(ctx, method, params, clientId);
  if (coreOutcome !== phase4RpcSkipped) return coreOutcome;
  const teamMetricsOutcome = await dispatchPhase4TeamMetricsGroup(ctx, method, params, clientId);
  if (teamMetricsOutcome !== phase4RpcSkipped) return teamMetricsOutcome;
  const platformOutcome = await dispatchPhase4PlatformGroup(ctx, method, params, clientId);
  if (platformOutcome !== phase4RpcSkipped) return platformOutcome;
  return tryDispatchReindexRpc(ctx, method, params, clientId);
}

export async function tryDispatchSessionRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("session.")) {
    return sessionRpcSkipped;
  }
  if (ctx.options.sessionMemoryStore === undefined) {
    throw new RpcMethodError(-32603, "Session memory is not available on this gateway");
  }
  try {
    const out = await dispatchSessionRpc({
      method,
      params,
      store: ctx.options.sessionMemoryStore,
    });
    if (out.kind === "hit") {
      return out.value;
    }
  } catch (e) {
    if (e instanceof SessionRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  throw new RpcMethodError(-32601, `Method not found: ${method}`);
}
