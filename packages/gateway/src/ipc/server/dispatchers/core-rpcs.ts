import { buildAgentSynthesisRunner } from "../../../agents/_lib/agent-synthesis-runner.ts";
import { getLayeredConfig } from "../../../config/layered-config.ts";
import { loadNimbusPreflightFromConfigDir } from "../../../config/nimbus-toml.ts";
import { asRecord } from "../../../connectors/unknown-record.ts";
import { NULL_EGRESS_SINK } from "../../../egress/egress-ledger.ts";
import { bindConsentChannel, NO_POLICY_OVERLAY, ToolExecutor } from "../../../engine/executor.ts";
import type { ConnectorDispatcher } from "../../../engine/types.ts";
import { NamespaceStore } from "../../../federation/namespace-store.ts";
import { preflightConsent } from "../../../federation/preflight-consent-broker.ts";
import { appendPreflightAudit, defaultRunCommand } from "../../../federation/preflight-gate.ts";
import { writeScimBearer } from "../../../identity/identity-vault.ts";
import { isOperatorValid } from "../../../identity/verifier.ts";
import { AgentsRpcError, dispatchAgentsRpc } from "../../agents-rpc.ts";
import { AuditRpcError, dispatchAuditRpc } from "../../audit-rpc.ts";
import { dispatchFederationRpc, FederationRpcError } from "../../federation-rpc.ts";
import { dispatchHitlRpc, HitlRpcError } from "../../hitl-rpc.ts";
import {
  dispatchIdentityRpc,
  type IdentityRpcContext,
  IdentityRpcError,
} from "../../identity-rpc.ts";
import { dispatchLlmRpc, LlmRpcError } from "../../llm-rpc.ts";
import { dispatchSecurityRpc, SecurityRpcError } from "../../security-rpc.ts";
import { dispatchTeamVaultRpc, TeamVaultRpcError } from "../../teamvault-rpc.ts";
import { dispatchUpdaterRpc, UpdaterRpcError } from "../../updater-rpc.ts";
import { dispatchVoiceRpc, VoiceRpcError } from "../../voice-rpc.ts";
import { phase4RpcSkipped, type ServerCtx } from "../context.ts";
import { RpcMethodError } from "../rpc-error.ts";

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
      // Only `llm.use` reads this (see `LlmRpcContext.tomlPath`'s doc) — the layered reader's
      // write target (the active profile file, created if absent, else `nimbus.toml`), so a
      // pin written here lands in a file the next layered read merges.
      ...(ctx.options.configDir === undefined
        ? {}
        : { tomlPath: getLayeredConfig(ctx.options.configDir).writeTargetPath() }),
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
      ...(ctx.options.agentLatencyRecorder === undefined
        ? {}
        : { agentLatencyRecorder: ctx.options.agentLatencyRecorder }),
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
  clientId: string,
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
    // The kind is the CONNECTION's, held by the server (Phase 28 AD4): only the proof methods read it.
    const out = await dispatchAuditRpc(method, params, {
      index: ctx.options.localIndex,
      callerKind: ctx.getClientKind(clientId),
    });
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
