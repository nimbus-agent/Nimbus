import pino from "pino";
import { buildAgentSynthesisRunner } from "../../agents/_lib/agent-synthesis-runner.ts";
import {
  loadNimbusPreflightFromConfigDir,
  loadNimbusServiceConfigsFromConfigDir,
  resolveNimbusTomlForProfile,
} from "../../config/nimbus-toml.ts";
import { asRecord } from "../../connectors/unknown-record.ts";
import { makeEgressSink, NULL_EGRESS_SINK } from "../../egress/egress-ledger.ts";
import { bindConsentChannel, NO_POLICY_OVERLAY, ToolExecutor } from "../../engine/executor.ts";
import type { ConnectorDispatcher } from "../../engine/types.ts";
import { NamespaceStore } from "../../federation/namespace-store.ts";
import { preflightConsent } from "../../federation/preflight-consent-broker.ts";
import { appendPreflightAudit, defaultRunCommand } from "../../federation/preflight-gate.ts";
import { writeScimBearer } from "../../identity/identity-vault.ts";
import { isOperatorValid } from "../../identity/verifier.ts";
import { CURRENT_SCHEMA_VERSION } from "../../index/local-index.ts";
import { GATEWAY_VERSION } from "../../version.ts";
import { buildStatus } from "../admin-status-rpc.ts";
import { AgentsRpcError, dispatchAgentsRpc } from "../agents-rpc.ts";
import { AuditRpcError, dispatchAuditRpc } from "../audit-rpc.ts";
import { AutomationRpcError, dispatchAutomationRpc } from "../automation-rpc.ts";
import { dispatchChatopsRpc } from "../chatops-rpc.ts";
import { dispatchClipRpc } from "../clip-rpc.ts";
import { ComputerRpcError, dispatchComputerRpc } from "../computer-rpc.ts";
import { ConnectorRpcError, dispatchConnectorRpc } from "../connector-rpc.ts";
import { DataRpcError, dispatchDataRpc } from "../data-rpc.ts";
import { DecisionsRpcError, dispatchDecisionsRpc } from "../decisions-rpc.ts";
import { DeploymentRpcError, dispatchDeploymentRpc } from "../deployment-rpc.ts";
import { DiagnosticsRpcError, dispatchDiagnosticsRpc } from "../diagnostics-rpc.ts";
import { dispatchEgressRpc, type EgressRpcCtx, EgressRpcError } from "../egress-rpc.ts";
import { dispatchExecRpc, ExecRpcError } from "../exec-rpc.ts";
import { dispatchFederationRpc, FederationRpcError } from "../federation-rpc.ts";
import { dispatchFilesystemRpc, FilesystemRpcError } from "../filesystem-rpc.ts";
import { dispatchGlossaryRpc, GlossaryRpcError } from "../glossary-rpc.ts";
import { dispatchHitlRpc, HitlRpcError } from "../hitl-rpc.ts";
import { dispatchIdentityRpc, type IdentityRpcContext, IdentityRpcError } from "../identity-rpc.ts";
import { dispatchIndexDemoSymbolRpc, IndexDemoSymbolRpcError } from "../index-demo-symbol-rpc.ts";
import { dispatchIndexRebodyRpc, IndexRebodyRpcError } from "../index-rebody-rpc.ts";
import { dispatchIndexReembedRpc, IndexReembedRpcError } from "../index-reembed-rpc.ts";
import { dispatchIndexRegraphRpc, IndexRegraphRpcError } from "../index-regraph-rpc.ts";
import { generatePairingCode } from "../lan-pairing.ts";
import { dispatchLlmRpc, LlmRpcError } from "../llm-rpc.ts";
import { dispatchMetricsRpc, MetricsRpcError } from "../metrics-rpc.ts";
import { dispatchOwnershipRpc } from "../ownership-rpc.ts";
import { dispatchPeopleRpc, PeopleRpcError } from "../people-rpc.ts";
import { dispatchPolicyRpc, PolicyRpcError } from "../policy-rpc.ts";
import { dispatchPreflightRpc, PreflightRpcError } from "../preflight-rpc.ts";
import { dispatchPremortemRpc, PremortemRpcError } from "../premortem-rpc.ts";
import { dispatchProfileRpc, ProfileRpcError } from "../profile-rpc.ts";
import { dispatchReindexRpc, ReindexRpcError } from "../reindex-rpc.ts";
import { dispatchSecurityRpc, SecurityRpcError } from "../security-rpc.ts";
import type { ClientSession } from "../session.ts";
import { dispatchSessionRpc, SessionRpcError } from "../session-rpc.ts";
import { dispatchShareRpc, ShareRpcError } from "../share-rpc.ts";
import { dispatchTeamVaultRpc, TeamVaultRpcError } from "../teamvault-rpc.ts";
import { dispatchTribalRpc } from "../tribal-rpc.ts";
import { dispatchUpdaterRpc, UpdaterRpcError } from "../updater-rpc.ts";
import { dispatchVoiceRpc, VoiceRpcError } from "../voice-rpc.ts";
import { createWorkflowCancelHandler } from "../workflow-cancel.ts";
import {
  automationRpcSkipped,
  connectorRpcSkipped,
  deploymentRpcSkipped,
  diagnosticsRpcSkipped,
  metricsRpcSkipped,
  peopleRpcSkipped,
  phase4RpcSkipped,
  preflightRpcSkipped,
  type ServerCtx,
  sessionRpcSkipped,
} from "./context.ts";
import { dispatchWorkflowRunRpc } from "./inline-handlers.ts";
import type { CreateIpcServerOptions } from "./options.ts";
import { RpcMethodError } from "./rpc-error.ts";

function assertDiagnosticsRpcAccess(
  method: string,
  wantsConfig: boolean,
  wantsTelemetry: boolean,
  wantsDiagnostics: boolean,
  opts: Pick<CreateIpcServerOptions, "configDir" | "dataDir" | "localIndex">,
): void {
  if (wantsConfig) {
    if (opts.configDir === undefined) {
      throw new RpcMethodError(-32603, "configDir is required for config.* RPCs");
    }
    return;
  }
  if (wantsTelemetry) {
    if (opts.dataDir === undefined) {
      throw new RpcMethodError(-32603, "dataDir is required for telemetry.* RPCs");
    }
    if (method === "telemetry.preview" && opts.localIndex === undefined) {
      throw new RpcMethodError(-32603, "telemetry.preview requires local index");
    }
    return;
  }
  if (wantsDiagnostics && (opts.localIndex === undefined || opts.dataDir === undefined)) {
    throw new RpcMethodError(-32603, "Diagnostics require local index and dataDir");
  }
}

export async function tryDispatchLlmRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("llm.") || ctx.options.llmRegistry === undefined) {
    return phase4RpcSkipped;
  }
  try {
    const out = await dispatchLlmRpc(method, params, {
      registry: ctx.options.llmRegistry,
      notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
      // Only `llm.use` reads this (see `LlmRpcContext.tomlPath`'s doc) — resolved the same
      // way `platform/assemble.ts` resolves the router's own `activeTomlPath`, so a pin
      // written here lands in the exact file boot re-reads.
      ...(ctx.options.configDir === undefined
        ? {}
        : { tomlPath: resolveNimbusTomlForProfile(ctx.options.configDir) }),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof LlmRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  throw new RpcMethodError(-32601, `Method not found: ${method}`);
}

export async function tryDispatchAgentsRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!method.startsWith("agents.") || ctx.options.localIndex === undefined) {
    return phase4RpcSkipped;
  }
  try {
    const db = ctx.options.localIndex.getDatabase();
    // The SAME factory `agent-runs/agent-http-invoke.ts` calls for the HTTP path — see its doc
    // comment for why that makes a socket brief and an HTTP brief the same answer to the same
    // question, under every `[agents].synthesis` mode.
    const runner = buildAgentSynthesisRunner({
      configDir: ctx.options.configDir,
      db,
      router: ctx.options.llmRegistry?.llmRouter,
      method,
    });
    const out = await dispatchAgentsRpc(method, params, {
      db,
      notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
      ...(ctx.options.configDir === undefined ? {} : { configDir: ctx.options.configDir }),
      index: ctx.options.localIndex,
      ...(ctx.options.federationIdentity === undefined
        ? {}
        : { selfIdentity: ctx.options.federationIdentity }),
      caller: { clientId, kind: ctx.getClientKind(clientId) },
      ...(runner === undefined ? {} : { runner }),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof AgentsRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  throw new RpcMethodError(-32601, `Method not found: ${method}`);
}

export async function tryDispatchVoiceRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("voice.") || ctx.options.voiceService === undefined) {
    return phase4RpcSkipped;
  }
  try {
    const out = await dispatchVoiceRpc(method, params, { voiceService: ctx.options.voiceService });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof VoiceRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  throw new RpcMethodError(-32601, `Method not found: ${method}`);
}

export async function tryDispatchUpdaterRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("updater.")) {
    return phase4RpcSkipped;
  }
  try {
    return await dispatchUpdaterRpc(method, params, { updater: ctx.options.updater });
  } catch (e) {
    if (e instanceof UpdaterRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
}

export async function tryDispatchAuditRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  // Namespace check, not a two-name list. This arm used to read
  //   `if (method !== "audit.verify" && method !== "audit.exportAll") return phase4RpcSkipped;`
  // while `dispatchAuditRpc`'s handler map served FIVE methods, so three were stranded: a call
  // reached this guard, was skipped, fell through the rest of the chain and came back -32601 even
  // though its handler existed and was registered. Two of them — `audit.export` and
  // `audit.getSummary` — are on the Tauri renderer allowlist (I7), so the desktop audit panel's
  // summary tile silently never populated and its export failed AFTER the user picked a save path.
  //
  // The immediate cause is a two-places-one-updated split: `handleAuditExport` was aliased to
  // `audit.export` alongside `audit.exportAll` in the leaf map, and the guard was never mirrored.
  // Letting the leaf map be the single source of truth for WHICH audit methods are served removes
  // the second place. An unknown `audit.*` still returns a miss from `dispatchByMethod` and falls
  // through to `phase4RpcSkipped` below, exactly as before.
  if (!method.startsWith("audit.")) return phase4RpcSkipped;
  try {
    const out = await dispatchAuditRpc(method, params, { index: ctx.options.localIndex });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof AuditRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchSecurityRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (
    (method !== "security.scan" && method !== "security.scanCancel") ||
    ctx.options.localIndex === undefined
  ) {
    return phase4RpcSkipped;
  }
  try {
    const out = await dispatchSecurityRpc(method, params, {
      db: ctx.options.localIndex.getDatabase(),
      notify: (m, p) => ctx.broadcastNotification(m, p),
      ...(ctx.options.configDir === undefined ? {} : { configDir: ctx.options.configDir }),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof SecurityRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchFederationRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  const index = ctx.options.localIndex;
  const discovery = ctx.options.federationDiscovery;
  const pairing = ctx.options.federationPairing;
  // Federation needs the index + its long-lived services; skip cleanly if not configured.
  if (index === undefined || discovery === undefined || pairing === undefined) {
    return phase4RpcSkipped;
  }
  const idStore = ctx.options.identityStore;
  const idIssuer = ctx.options.identityIssuer;
  const idGrace = ctx.options.identityGraceSeconds ?? 0;
  try {
    const out = await dispatchFederationRpc(method, params, {
      db: index.getDatabase(),
      consentTimeoutMs: (ctx.options.federationConsentTimeoutSeconds ?? 30) * 1000,
      notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
      discovery,
      pairing,
      index,
      ...(ctx.options.federationIdentity === undefined
        ? {}
        : { selfIdentity: ctx.options.federationIdentity }),
      ...(ctx.options.teamVault === undefined ? {} : { teamVault: ctx.options.teamVault }),
      ...(idStore !== undefined && idIssuer !== undefined
        ? {
            identityGuard: {
              enabled: true,
              isOperatorValid: () => isOperatorValid(idStore, idIssuer, Date.now(), idGrace),
            },
          }
        : {}),
      // I24 (Slice 6b): serve inbound preflights only when a config dir exists (the command comes
      // from local nimbus.toml). The command runs behind the LOCAL owner's HITL approval.
      ...(ctx.options.configDir === undefined
        ? {}
        : {
            preflight: {
              isPeerGranted: (ns: string, peerId: string) =>
                new NamespaceStore(index.getDatabase()).getActiveGrant(ns, peerId) !== undefined,
              resolveCommand: (ns: string) =>
                loadNimbusPreflightFromConfigDir(ctx.options.configDir as string).get(ns),
              requestApproval: (input) =>
                preflightConsent.request(
                  input,
                  (ctx.options.federationConsentTimeoutSeconds ?? 30) * 1000 + 5000,
                ),
              runCommand: defaultRunCommand,
              audit: (e) => appendPreflightAudit(index.getDatabase(), e),
            },
          }),
      // Share forwarding (Slice 8d): asker-side deps for federation.shareForward (local-only, I5).
      // Absent → ERR_SHARE_FORWARD_UNAVAILABLE (fail-closed).
      ...(ctx.options.federationForwardShareDeps === undefined
        ? {}
        : { forwardShareDeps: ctx.options.federationForwardShareDeps }),
      ...(ctx.options.federationResolvePeerPubkey === undefined
        ? {}
        : { resolvePeerPubkey: ctx.options.federationResolvePeerPubkey }),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof FederationRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchTeamVaultRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!method.startsWith("teamvault.")) return phase4RpcSkipped;
  const index = ctx.options.localIndex;
  if (index === undefined) return phase4RpcSkipped;
  // I2: HITL-gate the secret-writing methods before any vault write (mirrors dispatchVaultGated).
  if (method === "teamvault.put" || method === "teamvault.delete") {
    const stubDispatcher: ConnectorDispatcher = {
      dispatch: () => Promise.reject(new Error("team-vault gate does not dispatch to MCP")),
    };
    // I29: gate-only executor — local mutation, no connector dispatch, so no egress to ledger.
    const toolExecutor = new ToolExecutor(
      bindConsentChannel(ctx.consentImpl, clientId),
      index,
      stubDispatcher,
      undefined,
      NULL_EGRESS_SINK,
      ctx.options.policyHitl ?? NO_POLICY_OVERLAY,
    );
    const rec = asRecord(params);
    const entry = rec !== undefined && typeof rec["entry"] === "string" ? rec["entry"] : "";
    const gateResult = await toolExecutor.gate({ type: method, payload: { entry } });
    if (gateResult !== "proceed" && gateResult.status === "rejected") {
      throw new RpcMethodError(-32000, gateResult.reason);
    }
  }
  try {
    const out = await dispatchTeamVaultRpc(method, params, {
      db: index.getDatabase(),
      vault: ctx.options.vault,
      operator: "owner",
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof TeamVaultRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchHitlRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("hitl.")) return phase4RpcSkipped;
  const index = ctx.options.localIndex;
  if (index === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchHitlRpc(method, params, { db: index.getDatabase() });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof HitlRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

/** scim.setToken writes a credential to the Vault — handled here, not in the pure dispatcher. */
async function handleScimSetToken(ctx: ServerCtx, params: unknown): Promise<{ ok: true }> {
  const vault = ctx.options.identityVault;
  const rec = params as Record<string, unknown>;
  if (vault === undefined || typeof rec?.["token"] !== "string") {
    throw new RpcMethodError(-32602, "ERR_INVALID_PARAMS: token required");
  }
  await writeScimBearer(vault, rec["token"]);
  return { ok: true };
}

/** Assembles the per-call identity RPC context (keeps the `??` / conditional-spread out of the dispatcher hot path). */
function buildIdentityRpcContext(
  ctx: ServerCtx,
  issuer: string,
  store: NonNullable<ServerCtx["options"]["identityStore"]>,
  index: NonNullable<ServerCtx["options"]["localIndex"]>,
): IdentityRpcContext {
  return {
    db: index.getDatabase(),
    issuer,
    identityStore: store,
    notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
    now: () => Date.now(),
    startLogin:
      ctx.options.identityStartLogin ??
      (() => {
        throw new RpcMethodError(-32000, "identity login not wired");
      }),
    ...(ctx.options.identityGraceSeconds === undefined
      ? {}
      : { graceSeconds: ctx.options.identityGraceSeconds }),
  };
}

export async function tryDispatchIdentityRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  const store = ctx.options.identityStore;
  const issuer = ctx.options.identityIssuer;
  const index = ctx.options.localIndex;
  if (store === undefined || issuer === undefined || index === undefined) return phase4RpcSkipped;
  if (method === "scim.setToken") return handleScimSetToken(ctx, params);
  try {
    const out = await dispatchIdentityRpc(
      method,
      params,
      buildIdentityRpcContext(ctx, issuer, store, index),
    );
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof IdentityRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchMetricsRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("metrics.") || ctx.options.localIndex === undefined) {
    return metricsRpcSkipped;
  }
  if (ctx.options.configDir === undefined) {
    throw new RpcMethodError(-32603, "configDir is required for metrics.* RPCs");
  }
  const configDir = ctx.options.configDir;
  try {
    const out = await dispatchMetricsRpc(method, params, {
      db: ctx.options.localIndex.getDatabase(),
      loadConfig: () => loadNimbusServiceConfigsFromConfigDir(configDir),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof MetricsRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return metricsRpcSkipped;
}

export async function tryDispatchPreflightRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("deploy.") || ctx.options.localIndex === undefined) {
    return preflightRpcSkipped;
  }
  if (ctx.options.configDir === undefined) {
    throw new RpcMethodError(-32603, "configDir is required for deploy.* RPCs");
  }
  const configDir = ctx.options.configDir;
  try {
    const out = await dispatchPreflightRpc(method, params, {
      db: ctx.options.localIndex.getDatabase(),
      loadConfig: () => loadNimbusServiceConfigsFromConfigDir(configDir),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof PreflightRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  return preflightRpcSkipped;
}

export async function tryDispatchDeploymentRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (method !== "deployment.annotate" || ctx.options.localIndex === undefined) {
    return deploymentRpcSkipped;
  }
  try {
    const out = await dispatchDeploymentRpc(method, params, {
      db: ctx.options.localIndex.getDatabase(),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof DeploymentRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  return deploymentRpcSkipped;
}

export async function tryDispatchReindexRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (method !== "connector.reindex") return phase4RpcSkipped;
  try {
    const stubDispatcher: ConnectorDispatcher = {
      dispatch(): Promise<unknown> {
        return Promise.reject(new Error("IPC-native gate does not dispatch to MCP"));
      },
    };
    // I29: gate-only executor — local mutation, no connector dispatch, so no egress to ledger.
    const toolExecutor =
      ctx.options.localIndex === undefined
        ? undefined
        : new ToolExecutor(
            bindConsentChannel(ctx.consentImpl, clientId),
            ctx.options.localIndex,
            stubDispatcher,
            undefined,
            NULL_EGRESS_SINK,
            ctx.options.policyHitl ?? NO_POLICY_OVERLAY,
          );
    const out = await dispatchReindexRpc(method, params, {
      index: ctx.options.localIndex,
      ...(toolExecutor === undefined ? {} : { toolExecutor }),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof ReindexRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchIndexReembedRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (method !== "index.reembed" && method !== "index.reembedCancel") {
    return phase4RpcSkipped;
  }
  if (ctx.options.localIndex === undefined) {
    throw new RpcMethodError(-32603, "index.reembed requires LocalIndex");
  }
  if (ctx.options.dataDir === undefined) {
    throw new RpcMethodError(-32603, "index.reembed requires dataDir");
  }
  try {
    const out = await dispatchIndexReembedRpc(method, params, {
      db: ctx.options.localIndex.getDatabase(),
      vault: ctx.options.vault,
      paths: { dataDir: ctx.options.dataDir },
      logger: pino({ level: "info" }),
      notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof IndexReembedRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchIndexRebodyRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (method !== "index.rebody" && method !== "index.rebodyCancel") {
    return phase4RpcSkipped;
  }
  if (ctx.options.localIndex === undefined) {
    throw new RpcMethodError(-32603, "index.rebody requires LocalIndex");
  }
  try {
    const out = await dispatchIndexRebodyRpc(method, params, {
      db: ctx.options.localIndex.getDatabase(),
      logger: pino({ level: "info" }),
      notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
      ...(ctx.options.syncScheduler === undefined
        ? {}
        : { syncScheduler: ctx.options.syncScheduler }),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof IndexRebodyRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchIndexDemoSymbolRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (method !== "index.demoSymbol") {
    return phase4RpcSkipped;
  }
  if (ctx.options.localIndex === undefined) {
    throw new RpcMethodError(-32603, "index.demoSymbol requires LocalIndex");
  }
  try {
    const out = await dispatchIndexDemoSymbolRpc(method, params, {
      db: ctx.options.localIndex.getDatabase(),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof IndexDemoSymbolRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchIndexRegraphRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (method !== "index.regraph") {
    return phase4RpcSkipped;
  }
  if (ctx.options.localIndex === undefined) {
    throw new RpcMethodError(-32603, "index.regraph requires LocalIndex");
  }
  try {
    const out = await dispatchIndexRegraphRpc(method, params, {
      db: ctx.options.localIndex.getDatabase(),
      ...(ctx.options.configDir === undefined ? {} : { configDir: ctx.options.configDir }),
      logger: pino({ level: "info" }),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof IndexRegraphRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchFilesystemRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("filesystem.")) return phase4RpcSkipped;
  if (ctx.options.configDir === undefined) {
    throw new RpcMethodError(-32603, "configDir is required for filesystem.* RPCs");
  }
  try {
    const out = await dispatchFilesystemRpc(method, params, {
      configDir: ctx.options.configDir,
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof FilesystemRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchProfileRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("profile.")) return phase4RpcSkipped;
  if (ctx.options.profileManager === undefined) {
    throw new RpcMethodError(-32603, "Profile manager is not available on this gateway");
  }
  try {
    const out = await dispatchProfileRpc(method, params, {
      manager: ctx.options.profileManager,
      notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof ProfileRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchDataRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!method.startsWith("data.")) return phase4RpcSkipped;
  try {
    let rpcPlatform: "win32" | "darwin" | "linux";
    if (process.platform === "win32") rpcPlatform = "win32";
    else if (process.platform === "darwin") rpcPlatform = "darwin";
    else rpcPlatform = "linux";
    const stubDispatcher: ConnectorDispatcher = {
      dispatch(): Promise<unknown> {
        return Promise.reject(new Error("IPC-native gate does not dispatch to MCP"));
      },
    };
    // I29: gate-only executor — local mutation, no connector dispatch, so no egress to ledger.
    const toolExecutor =
      ctx.options.localIndex === undefined
        ? undefined
        : new ToolExecutor(
            bindConsentChannel(ctx.consentImpl, clientId),
            ctx.options.localIndex,
            stubDispatcher,
            undefined,
            NULL_EGRESS_SINK,
            ctx.options.policyHitl ?? NO_POLICY_OVERLAY,
          );
    const out = await dispatchDataRpc(method, params, {
      index: ctx.options.localIndex,
      vault: ctx.options.vault,
      platform: rpcPlatform,
      nimbusVersion: ctx.options.version ?? GATEWAY_VERSION,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      ...(toolExecutor === undefined ? {} : { toolExecutor }),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof DataRpcError) throw new RpcMethodError(e.rpcCode, e.message, e.rpcData);
    throw e;
  }
  return phase4RpcSkipped;
}

function requireLanIndex(ctx: ServerCtx) {
  if (ctx.options.localIndex === undefined)
    throw new RpcMethodError(-32603, "Local index is not available");
  return ctx.options.localIndex;
}

function requireLanPairingWindow(ctx: ServerCtx) {
  if (ctx.options.lanPairingWindow === undefined)
    throw new RpcMethodError(-32603, "LAN pairing window not configured");
  return ctx.options.lanPairingWindow;
}

function extractPeerId(rec: Record<string, unknown> | undefined): string {
  const peerId = rec !== undefined && typeof rec["peerId"] === "string" ? rec["peerId"] : "";
  if (!peerId) throw new RpcMethodError(-32602, "Missing peerId");
  return peerId;
}

function handleLanLocalRpc(ctx: ServerCtx, method: string, params: unknown): unknown {
  const rec = asRecord(params);
  switch (method) {
    case "lan.openPairingWindow": {
      const pw = requireLanPairingWindow(ctx);
      const pairingCode = generatePairingCode();
      pw.open(pairingCode);
      const expiresAt = pw.getExpiresAt() ?? Date.now();
      return { pairingCode, expiresAt };
    }
    case "lan.closePairingWindow": {
      requireLanPairingWindow(ctx).close();
      return { ok: true };
    }
    case "lan.listPeers": {
      return { peers: requireLanIndex(ctx).listLanPeers() };
    }
    case "lan.grantWrite": {
      requireLanIndex(ctx).grantLanWrite(extractPeerId(rec));
      return { ok: true };
    }
    case "lan.revokeWrite": {
      requireLanIndex(ctx).revokeLanWrite(extractPeerId(rec));
      return { ok: true };
    }
    case "lan.removePeer": {
      requireLanIndex(ctx).removeLanPeer(extractPeerId(rec));
      return { ok: true };
    }
    case "lan.getStatus": {
      const pw = ctx.options.lanPairingWindow;
      return {
        enabled: ctx.options.lanServer !== undefined,
        pairingOpen: pw?.isOpen() ?? false,
        listenAddr: ctx.options.lanServer?.listenAddr() ?? null,
      };
    }
    default:
      throw new RpcMethodError(-32601, `Method not found: ${method}`);
  }
}

export async function tryDispatchLanRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("lan.")) return phase4RpcSkipped;
  return handleLanLocalRpc(ctx, method, params);
}

export async function tryDispatchPolicyRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  // policy.* + the team.purge GDPR entrypoint share one dependency seam.
  if (!method.startsWith("policy.") && method !== "team.purge") return phase4RpcSkipped;
  if (ctx.options.policyRpcCtx === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchPolicyRpc(method, params, ctx.options.policyRpcCtx);
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof PolicyRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchChatopsRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("chatops.")) return phase4RpcSkipped;
  if (ctx.options.chatopsRpcCtx === undefined) return phase4RpcSkipped;
  const out = await dispatchChatopsRpc(method, params, ctx.options.chatopsRpcCtx);
  if (out.kind === "hit") return out.value;
  return phase4RpcSkipped;
}

function tribalParamString(params: unknown, key: string): string | undefined {
  const rec = asRecord(params);
  const v = rec === undefined ? undefined : rec[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Extract a stable pageRef (`notion:<id>` / `confluence:<id>`) from a KB-append connector result.
 * The result is the MCP tool envelope wrapping the created page JSON; tolerant of shapes, returns
 * "" if no id is found (→ the write-gate reports write_failed, never a false success).
 */
/** Recursively dig a page `id` out of a KB-append result envelope (top-level or nested in JSON text). */
function findKbPageId(v: unknown): string | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const rec = v as Record<string, unknown>;
  if (typeof rec["id"] === "string") return rec["id"];
  const content = rec["content"];
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const text = (block as { text?: unknown } | null)?.text;
    if (typeof text !== "string") continue;
    const id = findKbPageIdInText(text);
    if (id !== undefined) return id;
  }
  return undefined;
}

/** Parse a content-block's text as JSON and recurse; non-JSON text yields no id. */
function findKbPageIdInText(text: string): string | undefined {
  try {
    return findKbPageId(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

export function extractKbPageRef(actionType: string, result: unknown): string {
  const prefix = actionType.startsWith("notion") ? "notion" : "confluence";
  const id = findKbPageId(result);
  return id === undefined ? "" : `${prefix}:${id}`;
}

export async function tryDispatchTribalRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!method.startsWith("tribal.")) return phase4RpcSkipped;
  const rpc = ctx.options.tribalRpcCtx;
  if (rpc === undefined) return phase4RpcSkipped;

  // I25: capture is special-cased — it needs a per-call HITL consent channel bound to the
  // initiating client (the local owner who ran `nimbus tribal capture`), which only the dispatcher
  // has. The submitAction runs the KB write through the executor gate; the destination comes from
  // local config inside the write-gate, never from these params.
  if (method === "tribal.capture") {
    const clusterId = tribalParamString(params, "clusterId");
    if (clusterId === undefined || clusterId === "") {
      throw new RpcMethodError(-32602, "ERR_INVALID_PARAMS: clusterId (string) required");
    }
    const target = tribalParamString(params, "target");
    const dispatcher = ctx.options.tribalConnectorDispatcher;
    const index = ctx.options.localIndex;
    if (dispatcher === undefined || index === undefined) {
      return rpc.capture(clusterId, target, async () => ({ status: "rejected" }));
    }
    // I29: tribal capture dispatches a real connector write (notion/confluence KB append) — an
    // outbound event — so this executor carries the egress sink (append-before-dispatch).
    const executor = new ToolExecutor(
      bindConsentChannel(ctx.consentImpl, clientId),
      index,
      dispatcher,
      undefined,
      makeEgressSink(index.getDatabase()),
      ctx.options.policyHitl ?? NO_POLICY_OVERLAY,
    );
    return rpc.capture(clusterId, target, async (action) => {
      const result = await executor.execute({ type: action.type, payload: action.payload });
      if (result.status !== "ok") return { status: "rejected" };
      return {
        status: "approved",
        result: { pageRef: extractKbPageRef(action.type, result.result) },
      };
    });
  }

  const out = await dispatchTribalRpc(method, params, rpc);
  if (out.kind === "hit") return out.value;
  return phase4RpcSkipped;
}

/**
 * Share & Virality (Phase 6 Slice 8). The 3-arg form (no per-client `clientId`): share's HITL is the
 * broadcast consent broker (a prompt to ALL connected clients answered by the local owner), NOT a
 * per-client `ToolExecutor` channel like tribal.capture. So every share.* method (incl. share.create)
 * lives in the HANDLERS map and is dispatched here uniformly.
 */
/**
 * Sandboxed code execution (Spine S2 slice 1, invariant I33). Like share, the 3-arg form: the HITL
 * here is the broadcast consent broker answered by the local owner, not a per-client `ToolExecutor`
 * channel. Present only when assembled at boot, so the dispatcher skips cleanly when the capability
 * is not wired. `exec.run` is RCE-class and is NOT Tauri-exposed (I7).
 */
export async function tryDispatchExecRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("exec.")) return phase4RpcSkipped;
  const rpc = ctx.options.execRpcCtx;
  if (rpc === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchExecRpc(method, params, rpc);
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof ExecRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

/**
 * Computer-use browser lane (Spine S2 slice 2, invariant I35). Same 3-arg shape as exec: the
 * HITL here is the two broadcast consent brokers (envelope-open + per-action) answered by the
 * local owner, not a per-client `ToolExecutor` channel. Present only when assembled at boot, so
 * the dispatcher skips cleanly when the capability is not wired. The whole namespace is RCE-class
 * and is NOT Tauri-exposed (I7).
 */
export async function tryDispatchComputerRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("computer.")) return phase4RpcSkipped;
  const rpc = ctx.options.computerRpcCtx;
  if (rpc === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchComputerRpc(method, params, rpc);
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof ComputerRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchShareRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("share.")) return phase4RpcSkipped;
  const rpc = ctx.options.shareRpcCtx;
  if (rpc === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchShareRpc(method, params, rpc);
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof ShareRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchEgressRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!method.startsWith("egress.")) return phase4RpcSkipped;
  const base = ctx.options.egressRpcCtx;
  if (base === undefined) return phase4RpcSkipped;
  // I2: bind `egress.prune` (the sole mutation, in the HITL frozen set) to the LOCAL owner's consent
  // gate via the calling client's channel — the teamvault.put/delete pattern. A gate-only stub
  // executor (no egress sink: prune is a local mutation, NOT outbound) prompts the owner; deny /
  // disconnect → not approved → nothing pruned. The assemble-built default is fail-closed.
  const rpc: EgressRpcCtx =
    method === "egress.prune" && ctx.options.localIndex !== undefined
      ? { ...base, requestPruneApproval: makePruneApproval(ctx, clientId) }
      : base;
  try {
    const out = await dispatchEgressRpc(method, params, rpc);
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof EgressRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchGlossaryRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("glossary.")) return phase4RpcSkipped;
  const refresher = ctx.options.glossaryRefresher;
  if (refresher === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchGlossaryRpc(method, params, {
      refresher,
      notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof GlossaryRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchDecisionsRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("decisions.")) return phase4RpcSkipped;
  const refresher = ctx.options.decisionsRefresher;
  if (refresher === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchDecisionsRpc(method, params, {
      refresher,
      notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof DecisionsRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

/**
 * Unlike decisions/glossary/ownership, this dispatcher does NOT skip cleanly when
 * `ctx.options.premortemRefresher` is unset — it always calls `dispatchPremortemRpc`, which
 * throws an explicit `ERR_PREMORTEM_DISABLED` in that case. A `premortem.refresh` call must
 * fail loudly when `[premortem].enabled = false`, not surface as a generic "Method not found"
 * one level up: a silent miss here would look identical to the method never having existed,
 * which is not the honest answer for "this subsystem is switched off".
 */
export async function tryDispatchPremortemRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("premortem.")) return phase4RpcSkipped;
  try {
    const out = await dispatchPremortemRpc(method, params, {
      ...(ctx.options.premortemRefresher === undefined
        ? {}
        : { premortemRefresher: ctx.options.premortemRefresher }),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof PremortemRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchOwnershipRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("ownership.")) return phase4RpcSkipped;
  const refresher = ctx.options.ownershipRefresher;
  if (refresher === undefined) return phase4RpcSkipped;
  // Unlike glossary/decisions, there is no try/catch + <X>RpcError remap here: the sole
  // handler (`ownership.refresh` → `startPass` → `LongRunningJobRegistry.start()`) always
  // returns `{ jobId }` synchronously and never throws — there is no rebuild verb and no
  // params to validate, so `dispatchOwnershipRpc` cannot reject before returning a "hit" or
  // "miss". A try/catch around an await that can never reject is dead code, not defense.
  const out = await dispatchOwnershipRpc(method, params, {
    refresher,
    notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
  });
  if (out.kind === "hit") return out.value;
  return phase4RpcSkipped;
}

/** Owner-HITL approval for `egress.prune`, gated through the calling client's consent channel. */
function makePruneApproval(
  ctx: ServerCtx,
  clientId: string,
): (beforeTs: number) => Promise<boolean> {
  return async (beforeTs) => {
    const index = ctx.options.localIndex;
    if (index === undefined) return false;
    const stubDispatcher: ConnectorDispatcher = {
      dispatch(): Promise<unknown> {
        return Promise.reject(new Error("egress prune gate does not dispatch to MCP"));
      },
    };
    // I29: gate-only executor — local mutation, no connector dispatch, so no egress to ledger.
    const executor = new ToolExecutor(
      bindConsentChannel(ctx.consentImpl, clientId),
      index,
      stubDispatcher,
      undefined,
      NULL_EGRESS_SINK,
      ctx.options.policyHitl ?? NO_POLICY_OVERLAY,
    );
    const gate = await executor.gate({ type: "egress.prune", payload: { beforeTs } });
    return gate === "proceed";
  };
}

export function tryDispatchAdminRpc(ctx: ServerCtx, method: string, _params: unknown): unknown {
  if (method !== "admin.status" || ctx.options.statusReaders === undefined) {
    return phase4RpcSkipped;
  }
  return buildStatus(ctx.options.statusReaders);
}

export async function tryDispatchClipRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("clip.") || ctx.options.clipPairingController === undefined) {
    return phase4RpcSkipped;
  }
  const out = await dispatchClipRpc(method, params, {
    pairing: ctx.options.clipPairingController,
    vault: ctx.options.vault,
    ...(ctx.options.localIndex === undefined ? {} : { db: ctx.options.localIndex.getDatabase() }),
    ...(ctx.options.clipHttpBaseUrl === undefined
      ? {}
      : { httpBaseUrl: ctx.options.clipHttpBaseUrl }),
    briefsEnabled: ctx.options.briefsEnabled ?? false,
  });
  if (out.kind === "hit") return out.value;
  throw new RpcMethodError(-32601, `Method not found: ${method}`);
}

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
  const auditOutcome = await tryDispatchAuditRpc(ctx, method, params);
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

/** Third group: lan → profile → index-reembed → index-rebody → index-regraph → index-demoSymbol → policy → chatops → tribal → share → egress → glossary → decisions → premortem → ownership → clip → admin. */
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
  tryDispatchFilesystemRpc,
  tryDispatchPolicyRpc,
  tryDispatchChatopsRpc,
  tryDispatchTribalRpc,
  tryDispatchShareRpc,
  tryDispatchExecRpc,
  tryDispatchComputerRpc,
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

function buildAutoUpdateDeps(
  ctx: ServerCtx,
  clientId: string,
  method: string,
): Parameters<typeof dispatchAutomationRpc>[0]["autoUpdate"] {
  if (
    ctx.options.extensionsAutoUpdate === undefined ||
    (method !== "extension.checkForUpdates" && method !== "extension.update") ||
    ctx.options.localIndex === undefined
  ) {
    return undefined;
  }
  const stubDispatcher: ConnectorDispatcher = {
    dispatch(): Promise<unknown> {
      return Promise.reject(new Error("auto-update gate does not dispatch to MCP"));
    },
  };
  // I29: gate-only executor — local mutation, no connector dispatch, so no egress to ledger.
  const toolExecutor = new ToolExecutor(
    bindConsentChannel(ctx.consentImpl, clientId),
    ctx.options.localIndex,
    stubDispatcher,
    undefined,
    NULL_EGRESS_SINK,
    ctx.options.policyHitl ?? NO_POLICY_OVERLAY,
  );
  return {
    ...ctx.options.extensionsAutoUpdate,
    gate: async (action) => {
      const r = await toolExecutor.gate(action);
      if (r === "proceed") return "proceed";
      return { status: "rejected" };
    },
  };
}

async function dispatchExtensionAutomationRpc(
  ctx: ServerCtx,
  clientId: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (ctx.options.localIndex === undefined) {
    throw new RpcMethodError(-32603, "Local index is not available");
  }
  try {
    const autoUpdateDeps = buildAutoUpdateDeps(ctx, clientId, method);
    const out = await dispatchAutomationRpc({
      method,
      params,
      db: ctx.options.localIndex.getDatabase(),
      ...(ctx.options.extensionsDir === undefined
        ? {}
        : { extensionsDir: ctx.options.extensionsDir }),
      ...(ctx.options.connectorMesh === undefined ? {} : { mesh: ctx.options.connectorMesh }),
      vault: ctx.options.vault,
      ...(ctx.options.extensionsPublisherKeyFetcher === undefined
        ? {}
        : { fetcher: ctx.options.extensionsPublisherKeyFetcher }),
      ...(ctx.options.extensionsEnforceAirGap === undefined
        ? {}
        : { enforceAirGap: ctx.options.extensionsEnforceAirGap }),
      ...(autoUpdateDeps === undefined ? {} : { autoUpdate: autoUpdateDeps }),
    });
    if (out.kind === "hit") {
      return out.value;
    }
  } catch (e) {
    if (e instanceof AutomationRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  throw new RpcMethodError(-32601, `Method not found: ${method}`);
}

export async function tryDispatchAutomationRpc(
  ctx: ServerCtx,
  clientId: string,
  session: ClientSession,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (method === "workflow.run") {
    return dispatchWorkflowRunRpc(ctx, clientId, session, params);
  }

  if (method === "workflow.cancel") {
    return createWorkflowCancelHandler(ctx.streamRegistry)(clientId, params);
  }

  if (
    method.startsWith("watcher.") ||
    method.startsWith("workflow.") ||
    method.startsWith("extension.")
  ) {
    return dispatchExtensionAutomationRpc(ctx, clientId, method, params);
  }

  return automationRpcSkipped;
}

export function tryDispatchPeopleRpc(ctx: ServerCtx, method: string, params: unknown): unknown {
  if (!method.startsWith("people.") || ctx.options.localIndex === undefined) {
    return peopleRpcSkipped;
  }
  try {
    const out = dispatchPeopleRpc({
      method,
      params,
      localIndex: ctx.options.localIndex,
    });
    if (out.kind === "hit") {
      return out.value;
    }
  } catch (e) {
    if (e instanceof PeopleRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  return peopleRpcSkipped;
}

export async function tryDispatchConnectorRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!method.startsWith("connector.") || ctx.options.localIndex === undefined) {
    return connectorRpcSkipped;
  }
  const openUrl = ctx.options.openUrl;
  if (openUrl === undefined && method === "connector.auth") {
    throw new RpcMethodError(-32603, "Gateway is not configured for OAuth (missing openUrl)");
  }
  try {
    const stubDispatcher: ConnectorDispatcher = {
      dispatch(): Promise<unknown> {
        return Promise.reject(new Error("IPC-native gate does not dispatch to MCP"));
      },
    };
    // I29: gate-only executor — local mutation, no connector dispatch, so no egress to ledger.
    const toolExecutor = new ToolExecutor(
      bindConsentChannel(ctx.consentImpl, clientId),
      ctx.options.localIndex,
      stubDispatcher,
      undefined,
      NULL_EGRESS_SINK,
      ctx.options.policyHitl ?? NO_POLICY_OVERLAY,
    );
    const out = await dispatchConnectorRpc({
      method,
      params,
      vault: ctx.options.vault,
      localIndex: ctx.options.localIndex,
      openUrl: openUrl ?? (async () => {}),
      syncScheduler: ctx.options.syncScheduler,
      ...(ctx.options.connectorMesh === undefined
        ? {}
        : { connectorMesh: ctx.options.connectorMesh }),
      notify: (m, p) => ctx.broadcastNotification(m, p),
      toolExecutor,
    });
    if (out.kind === "hit") {
      return out.value;
    }
  } catch (e) {
    if (e instanceof ConnectorRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  return connectorRpcSkipped;
}

export async function tryDispatchDiagnosticsRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<typeof diagnosticsRpcSkipped | object> {
  const wantsConfig = method.startsWith("config.");
  const wantsTelemetry = method.startsWith("telemetry.");
  const wantsDiagnostics =
    method.startsWith("db.") ||
    method.startsWith("diag.") ||
    method === "index.metrics" ||
    method === "index.queryItems" ||
    method === "index.querySql";
  if (!wantsConfig && !wantsTelemetry && !wantsDiagnostics) {
    return diagnosticsRpcSkipped;
  }
  assertDiagnosticsRpcAccess(method, wantsConfig, wantsTelemetry, wantsDiagnostics, ctx.options);
  try {
    const ctxBase = {
      dataDir: ctx.options.dataDir ?? "",
      configDir: ctx.options.configDir ?? "",
      consent: ctx.consentImpl,
      gatewayVersion: ctx.options.version,
      startedAtMs: ctx.startedAtMs,
      ...(ctx.options.sandboxRunner === undefined
        ? {}
        : { sandboxRunner: ctx.options.sandboxRunner }),
      ...(ctx.options.extensionsAutoUpdateDiag === undefined
        ? {}
        : { autoUpdateDiag: ctx.options.extensionsAutoUpdateDiag }),
      // Forwarded so `diag.snapshot` can report embedding readiness and `nimbus doctor` can say
      // when semantic search is dead. Omitted when the gateway has no embedding runtime, which
      // the CLI renders as silence rather than a verdict (#1396).
      ...(ctx.options.embeddingReadiness === undefined
        ? {}
        : { embeddingReadiness: ctx.options.embeddingReadiness }),
    };
    const diagCtx =
      ctx.options.localIndex === undefined
        ? ctxBase
        : { ...ctxBase, localIndex: ctx.options.localIndex };
    const out = await dispatchDiagnosticsRpc(method, params, diagCtx);
    if (out.kind === "hit") {
      return out.value as object;
    }
  } catch (e) {
    if (e instanceof DiagnosticsRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  return diagnosticsRpcSkipped;
}
