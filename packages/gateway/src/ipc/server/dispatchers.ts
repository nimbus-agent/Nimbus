import pino from "pino";
import { loadNimbusServiceConfigsFromConfigDir } from "../../config/nimbus-toml.ts";
import { asRecord } from "../../connectors/unknown-record.ts";
import { bindConsentChannel, ToolExecutor } from "../../engine/executor.ts";
import type { ConnectorDispatcher } from "../../engine/types.ts";
import { CURRENT_SCHEMA_VERSION } from "../../index/local-index.ts";
import { GATEWAY_VERSION } from "../../version.ts";
import { AgentsRpcError, dispatchAgentsRpc } from "../agents-rpc.ts";
import { AuditRpcError, dispatchAuditRpc } from "../audit-rpc.ts";
import { AutomationRpcError, dispatchAutomationRpc } from "../automation-rpc.ts";
import { ConnectorRpcError, dispatchConnectorRpc } from "../connector-rpc.ts";
import { DataRpcError, dispatchDataRpc } from "../data-rpc.ts";
import { DeploymentRpcError, dispatchDeploymentRpc } from "../deployment-rpc.ts";
import { DiagnosticsRpcError, dispatchDiagnosticsRpc } from "../diagnostics-rpc.ts";
import { dispatchIndexReembedRpc, IndexReembedRpcError } from "../index-reembed-rpc.ts";
import { generatePairingCode } from "../lan-pairing.ts";
import { dispatchLlmRpc, LlmRpcError } from "../llm-rpc.ts";
import { dispatchMetricsRpc, MetricsRpcError } from "../metrics-rpc.ts";
import { dispatchPeopleRpc, PeopleRpcError } from "../people-rpc.ts";
import { dispatchPreflightRpc, PreflightRpcError } from "../preflight-rpc.ts";
import { dispatchProfileRpc, ProfileRpcError } from "../profile-rpc.ts";
import { dispatchReindexRpc, ReindexRpcError } from "../reindex-rpc.ts";
import type { ClientSession } from "../session.ts";
import { dispatchSessionRpc, SessionRpcError } from "../session-rpc.ts";
import { dispatchUpdaterRpc, UpdaterRpcError } from "../updater-rpc.ts";
import { dispatchVoiceRpc, VoiceRpcError } from "../voice-rpc.ts";
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

// File-private; only tryDispatchDiagnosticsRpc uses it.
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
): Promise<unknown> {
  if (!method.startsWith("agents.") || ctx.options.localIndex === undefined) {
    return phase4RpcSkipped;
  }
  try {
    const out = await dispatchAgentsRpc(method, params, {
      db: ctx.options.localIndex.getDatabase(),
      // No `llm` plumbing in PR 1 — synthesize() falls back to the deterministic
      // renderer. PR-N will pass ctx.options.llmRouter once a routing API for
      // built-in agents lands.
      notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
      // PR 3 — agents.catchup loads `[user] me_person_id` from the active
      // profile's nimbus.toml. Other branches ignore configDir.
      ...(ctx.options.configDir === undefined ? {} : { configDir: ctx.options.configDir }),
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
  if (method !== "audit.verify" && method !== "audit.exportAll") return phase4RpcSkipped;
  try {
    const out = await dispatchAuditRpc(method, params, { index: ctx.options.localIndex });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof AuditRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchMetricsRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<typeof metricsRpcSkipped | unknown> {
  // Only `metrics.dora` is handled today (Phase 5 T4 PR 2). Returning the
  // metrics-specific skip sentinel keeps the chain logic uniform with audit /
  // profile while reserving the namespace for future `metrics.*` methods.
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
): Promise<typeof preflightRpcSkipped | unknown> {
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
): Promise<typeof deploymentRpcSkipped | unknown> {
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
    // S1-F7 — bind a per-client `ToolExecutor` so `full`-depth reindex
    // routes through the HITL consent gate. The dispatcher used here is
    // a stub: gate() never calls dispatch().
    const stubDispatcher: ConnectorDispatcher = {
      dispatch(): Promise<unknown> {
        return Promise.reject(new Error("IPC-native gate does not dispatch to MCP"));
      },
    };
    const toolExecutor =
      ctx.options.localIndex === undefined
        ? undefined
        : new ToolExecutor(
            bindConsentChannel(ctx.consentImpl, clientId),
            ctx.options.localIndex,
            stubDispatcher,
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
    // A stub dispatcher is intentional — gate() for IPC-native ops never calls dispatch().
    const stubDispatcher: ConnectorDispatcher = {
      dispatch(): Promise<unknown> {
        return Promise.reject(new Error("IPC-native gate does not dispatch to MCP"));
      },
    };
    const toolExecutor =
      ctx.options.localIndex === undefined
        ? undefined
        : new ToolExecutor(
            bindConsentChannel(ctx.consentImpl, clientId),
            ctx.options.localIndex,
            stubDispatcher,
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

// File-private — used only by handleLanLocalRpc.
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
      // S3-F9 — derive expiresAt from the same PairingWindow instance whose
      // timer enforces consume(). Previously expiresAt was computed from a
      // separate `lanPairingWindowMs` option that could diverge from the
      // PairingWindow's configured windowMs (e.g. caller passes the option
      // here but constructs PairingWindow elsewhere with the default 300_000),
      // leaving the UI counting down to a moment when the gate has already
      // closed. The single source of truth is now PairingWindow.getExpiresAt().
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
  // Local IPC clients (not LAN peers) are permitted to call all lan.* methods.
  // checkLanMethodAllowed is only applied on the LAN HTTP path (lan-server.ts).
  return handleLanLocalRpc(ctx, method, params);
}

export async function tryDispatchPhase4Rpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  const llmOutcome = await tryDispatchLlmRpc(ctx, method, params);
  if (llmOutcome !== phase4RpcSkipped) return llmOutcome;
  const agentsOutcome = await tryDispatchAgentsRpc(ctx, method, params);
  if (agentsOutcome !== phase4RpcSkipped) return agentsOutcome;
  const voiceOutcome = await tryDispatchVoiceRpc(ctx, method, params);
  if (voiceOutcome !== phase4RpcSkipped) return voiceOutcome;
  const updaterOutcome = await tryDispatchUpdaterRpc(ctx, method, params);
  if (updaterOutcome !== phase4RpcSkipped) return updaterOutcome;
  const auditOutcome = await tryDispatchAuditRpc(ctx, method, params);
  if (auditOutcome !== phase4RpcSkipped) return auditOutcome;
  const metricsOutcome = await tryDispatchMetricsRpc(ctx, method, params);
  if (metricsOutcome !== metricsRpcSkipped) return metricsOutcome;
  const preflightOutcome = await tryDispatchPreflightRpc(ctx, method, params);
  if (preflightOutcome !== preflightRpcSkipped) return preflightOutcome;
  const deploymentOutcome = await tryDispatchDeploymentRpc(ctx, method, params);
  if (deploymentOutcome !== deploymentRpcSkipped) return deploymentOutcome;
  const dataOutcome = await tryDispatchDataRpc(ctx, method, params, clientId);
  if (dataOutcome !== phase4RpcSkipped) return dataOutcome;
  const lanOutcome = await tryDispatchLanRpc(ctx, method, params);
  if (lanOutcome !== phase4RpcSkipped) return lanOutcome;
  const profileOutcome = await tryDispatchProfileRpc(ctx, method, params);
  if (profileOutcome !== phase4RpcSkipped) return profileOutcome;
  const indexReembedOutcome = await tryDispatchIndexReembedRpc(ctx, method, params);
  if (indexReembedOutcome !== phase4RpcSkipped) return indexReembedOutcome;
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

  if (
    method.startsWith("watcher.") ||
    method.startsWith("workflow.") ||
    method.startsWith("extension.")
  ) {
    if (ctx.options.localIndex === undefined) {
      throw new RpcMethodError(-32603, "Local index is not available");
    }
    try {
      const out = await dispatchAutomationRpc({
        method,
        params,
        db: ctx.options.localIndex.getDatabase(),
        ...(ctx.options.extensionsDir === undefined
          ? {}
          : { extensionsDir: ctx.options.extensionsDir }),
        // S7-F10 — pass the mesh so extension.disable can terminate the
        // running child immediately (fire-and-forget inside the dispatcher).
        ...(ctx.options.connectorMesh === undefined ? {} : { mesh: ctx.options.connectorMesh }),
        // I16 — signed-extension install path needs the vault (publisher key cache),
        // a registry fetcher (when network is permitted), and the air-gap flag.
        vault: ctx.options.vault,
        ...(ctx.options.extensionsPublisherKeyFetcher === undefined
          ? {}
          : { fetcher: ctx.options.extensionsPublisherKeyFetcher }),
        ...(ctx.options.extensionsEnforceAirGap === undefined
          ? {}
          : { enforceAirGap: ctx.options.extensionsEnforceAirGap }),
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
    // A stub dispatcher is intentional — gate() for IPC-native ops never calls dispatch().
    const stubDispatcher: ConnectorDispatcher = {
      dispatch(): Promise<unknown> {
        return Promise.reject(new Error("IPC-native gate does not dispatch to MCP"));
      },
    };
    const toolExecutor = new ToolExecutor(
      bindConsentChannel(ctx.consentImpl, clientId),
      ctx.options.localIndex,
      stubDispatcher,
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
