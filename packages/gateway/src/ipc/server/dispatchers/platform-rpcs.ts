import { join } from "node:path";
import { createConnectorDispatcher, meshDispatcherClient } from "../../../connectors/registry.ts";
import { asRecord } from "../../../connectors/unknown-record.ts";
import { userMcpWriteGrantsReader } from "../../../connectors/user-mcp-write-reader.ts";
import { makeEgressSink, NULL_EGRESS_SINK } from "../../../egress/egress-ledger.ts";
import { bindConsentChannel, NO_POLICY_OVERLAY, ToolExecutor } from "../../../engine/executor.ts";
import type { ConnectorDispatcher } from "../../../engine/types.ts";
import type { PackOwnerGate } from "../../../packs/pack-install.ts";
import { isConnectorConfigured } from "../../../sync/connector-configured.ts";
import { ConnectorRpcError, dispatchConnectorRpc } from "../../connector-rpc.ts";
import { humanOnlyConsent } from "../../consent.ts";
import { DiagnosticsRpcError, dispatchDiagnosticsRpc } from "../../diagnostics-rpc.ts";
import { buildPackDeps, dispatchPackRpc } from "../../pack-rpc.ts";
import { dispatchPeopleRpc, PeopleRpcError } from "../../people-rpc.ts";
import { dispatchRegistryRpc, type RegistryOwnerGate } from "../../registry-rpc.ts";
import { dispatchTrustRpc } from "../../trust-rpc.ts";
import {
  connectorRpcSkipped,
  diagnosticsRpcSkipped,
  packRpcSkipped,
  peopleRpcSkipped,
  registryRpcSkipped,
  type ServerCtx,
  trustRpcSkipped,
} from "../context.ts";
import type { CreateIpcServerOptions } from "../options.ts";
import { RpcMethodError } from "../rpc-error.ts";
import { buildExtensionGateExecutor, extensionEvidenceDepsFor } from "./automation-rpcs.ts";

function assertDiagnosticsRpcAccess(
  method: string,
  wantsConfig: boolean,
  wantsTelemetry: boolean,
  wantsDiagnostics: boolean,
  wantsAskExplain: boolean,
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
  if (wantsAskExplain) {
    // This branch is unreachable-by-omission, not load-bearing: `wantsDiagnostics`'s own prefix
    // match (`db.` / `diag.` / `index.*`) is disjoint from the literal `ask.explainLast`, so the
    // `if (wantsDiagnostics && ...)` guard below already excludes this method on its own — this
    // early return exists so that fact is stated explicitly (ask.explainLast reads the in-memory
    // ring only and has no localIndex/dataDir dependency to enforce) rather than left implicit in
    // what the guard below happens not to match.
    return;
  }
  if (wantsDiagnostics && (opts.localIndex === undefined || opts.dataDir === undefined)) {
    throw new RpcMethodError(-32603, "Diagnostics require local index and dataDir");
  }
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

/**
 * I42 + I29: the executor of the owner's own `connector.userMcpCall`. Unlike the gate-only executor
 * of `tryDispatchConnectorRpc`, this one DISPATCHES, so it carries a real egress sink and the real
 * connector dispatcher. No delegation dep: I42 asks the local owner.
 */
function userMcpCallExecutor(
  ctx: ServerCtx,
  clientId: string,
  localIndex: NonNullable<ServerCtx["options"]["localIndex"]>,
  mesh: NonNullable<ServerCtx["options"]["connectorMesh"]>,
): ToolExecutor {
  return new ToolExecutor(
    bindConsentChannel(ctx.consentImpl, clientId),
    localIndex,
    createConnectorDispatcher(meshDispatcherClient(mesh)),
    undefined,
    makeEgressSink(localIndex.getDatabase()),
    ctx.options.policyHitl ?? NO_POLICY_OVERLAY,
    undefined,
    // I15 (AD5b): the owner's own call shows what the server's code may write.
    {
      userMcpWriteGrants: userMcpWriteGrantsReader(() => localIndex.getDatabase()),
    },
  );
}

/** `connector.auth` needs a way to open the browser; every other method runs without one. */
function requireOpenUrlFor(
  method: string,
  openUrl: CreateIpcServerOptions["openUrl"],
): NonNullable<CreateIpcServerOptions["openUrl"]> {
  if (openUrl === undefined && method === "connector.auth") {
    throw new RpcMethodError(-32603, "Gateway is not configured for OAuth (missing openUrl)");
  }
  return openUrl ?? (async () => {});
}

/** The dispatching executor of the owner's own `connector.userMcpCall`; no other method gets one. */
function userMcpExecutorFor(
  ctx: ServerCtx,
  method: string,
  clientId: string,
  localIndex: NonNullable<ServerCtx["options"]["localIndex"]>,
): ToolExecutor | undefined {
  const mesh = ctx.options.connectorMesh;
  return method === "connector.userMcpCall" && mesh !== undefined
    ? userMcpCallExecutor(ctx, clientId, localIndex, mesh)
    : undefined;
}

type ConnectorRpcOptionalDeps = Pick<
  Parameters<typeof dispatchConnectorRpc>[0],
  "connectorMesh" | "sandboxRunner" | "continuityTable"
>;

/** The connector RPC's members that exist only when the gateway was given them. */
function connectorRpcOptionalDeps(ctx: ServerCtx): ConnectorRpcOptionalDeps {
  const { connectorMesh, sandboxRunner, continuityTable } = ctx.options;
  return {
    ...(connectorMesh === undefined ? {} : { connectorMesh }),
    ...(sandboxRunner === undefined ? {} : { sandboxRunner }),
    ...(continuityTable === undefined ? {} : { continuityTable }),
  };
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
  const openUrl = requireOpenUrlFor(method, ctx.options.openUrl);
  try {
    const stubDispatcher: ConnectorDispatcher = {
      dispatch(): Promise<unknown> {
        return Promise.reject(new Error("IPC-native gate does not dispatch to MCP"));
      },
    };
    // Phase 28 AD3a-1: approving connector writes for OUTSIDE AGENTS takes a person. Only that
    // enable gets the human-only channel (`--yes`, a script, a delegate, a remote or an old client
    // answer becomes a decline); the model door's enable keeps the consent it always had.
    let agentAnswerNonHuman = false;
    const agentEnable =
      method === "connector.writesEnable" && asRecord(params)?.["door"] === "agent";
    // Phase 28 AD5b (owner ruling OR-AD-33): so does registering a user MCP server WITH a write
    // directory. A registration with none keeps the consent it always had.
    const writePathsParam = asRecord(params)?.["writePaths"];
    const writeGrantAdd =
      method === "connector.addMcp" && Array.isArray(writePathsParam) && writePathsParam.length > 0;
    const gateConsent =
      agentEnable || writeGrantAdd
        ? humanOnlyConsent(ctx.consentImpl, () => {
            agentAnswerNonHuman = true;
          })
        : ctx.consentImpl;
    // I29: gate-only executor — local mutation, no connector dispatch, so no egress to ledger.
    const toolExecutor = new ToolExecutor(
      bindConsentChannel(gateConsent, clientId),
      ctx.options.localIndex,
      stubDispatcher,
      undefined,
      NULL_EGRESS_SINK,
      ctx.options.policyHitl ?? NO_POLICY_OVERLAY,
    );
    const userMcpExecutor = userMcpExecutorFor(ctx, method, clientId, ctx.options.localIndex);
    const out = await dispatchConnectorRpc({
      method,
      params,
      vault: ctx.options.vault,
      localIndex: ctx.options.localIndex,
      openUrl,
      syncScheduler: ctx.options.syncScheduler,
      ...connectorRpcOptionalDeps(ctx),
      platform: process.platform,
      notify: (m, p) => ctx.broadcastNotification(m, p),
      getEnforcedPolicy: () => ctx.options.enforcedPolicy?.(),
      toolExecutor,
      clientKind: ctx.getClientKind(clientId),
      agentAnswerWasNonHuman: () => agentAnswerNonHuman,
      ...(userMcpExecutor === undefined ? {} : { userMcpExecutor }),
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
    method === "index.health" ||
    method === "index.queryItems" ||
    method === "index.querySql";
  const wantsAskExplain = method === "ask.explainLast";
  if (!wantsConfig && !wantsTelemetry && !wantsDiagnostics && !wantsAskExplain) {
    return diagnosticsRpcSkipped;
  }
  assertDiagnosticsRpcAccess(
    method,
    wantsConfig,
    wantsTelemetry,
    wantsDiagnostics,
    wantsAskExplain,
    ctx.options,
  );
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
      // ask.explainLast reads this ring directly; no other diagnostics method touches it.
      ...(ctx.options.askExplainRecorder === undefined
        ? {}
        : { askExplainRecorder: ctx.options.askExplainRecorder }),
      // telemetry.preview / telemetry.getStatus read the agent-invocation percentiles from it.
      ...(ctx.options.agentLatencyRecorder === undefined
        ? {}
        : { agentLatencyRecorder: ctx.options.agentLatencyRecorder }),
      ...(ctx.options.fleetDroppedJobs === undefined
        ? {}
        : { fleetDroppedJobs: ctx.options.fleetDroppedJobs }),
      ...(ctx.options.fleetJobCheck === undefined
        ? {}
        : { fleetJobCheck: ctx.options.fleetJobCheck }),
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

/**
 * `registry.*` (CLI-only). Only `registry.add` and `registry.install` ask the owner; it runs through the same gate-only
 * executor as the extension lifecycle approvals (no connector dispatch, so no egress row of its
 * own — the registry fetch it triggers is ledgered by the `registry` class).
 */
/** `trust.status` / `trust.refresh` (trust layer): CLI-only reads of the trust store and feed. */
export async function tryDispatchTrustRpc(ctx: ServerCtx, method: string): Promise<unknown> {
  if (!method.startsWith("trust.")) {
    return trustRpcSkipped;
  }
  const localIndex = ctx.options.localIndex;
  if (localIndex === undefined) {
    throw new RpcMethodError(-32603, "Local index is not available");
  }
  const out = await dispatchTrustRpc({
    method,
    db: localIndex.getDatabase(),
    trustFeed: ctx.options.trustFeed,
    now: Date.now,
  });
  if (out.kind === "hit") {
    return out.value;
  }
  throw new RpcMethodError(-32601, `Method not found: ${method}`);
}

export async function tryDispatchRegistryRpc(
  ctx: ServerCtx,
  clientId: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("registry.")) {
    return registryRpcSkipped;
  }
  const localIndex = ctx.options.localIndex;
  if (localIndex === undefined) {
    throw new RpcMethodError(-32603, "Local index is not available");
  }
  let ownerGate: RegistryOwnerGate | undefined;
  if (method === "registry.add" || method === "registry.install") {
    const toolExecutor = buildExtensionGateExecutor(ctx, localIndex, clientId);
    ownerGate = async (action) => (await toolExecutor.gate(action)) === "proceed";
  }
  const evidence = extensionEvidenceDepsFor(ctx, method);
  const out = await dispatchRegistryRpc({
    method,
    params,
    db: localIndex.getDatabase(),
    ...(evidence === undefined ? {} : { evidence }),
    ...(ctx.options.registryFetch === undefined ? {} : { fetch: ctx.options.registryFetch }),
    ...(ownerGate === undefined ? {} : { ownerGate }),
    ...(ctx.options.extensionsDir === undefined
      ? {}
      : { extensionsDir: ctx.options.extensionsDir }),
    vault: ctx.options.vault,
    ...(ctx.options.trustFeed === undefined ? {} : { trustFeed: ctx.options.trustFeed }),
    ...(ctx.options.continuityTable === undefined
      ? {}
      : { continuityTable: ctx.options.continuityTable }),
    // `registry.cloneSource` stages its archive here and nowhere else.
    ...(ctx.options.dataDir === undefined
      ? {}
      : { cloneStagingDir: join(ctx.options.dataDir, "registry-clone-staging") }),
  });
  if (out.kind === "hit") {
    return out.value;
  }
  throw new RpcMethodError(-32601, `Method not found: ${method}`);
}

/**
 * `pack.*`. `pack.list` and `pack.install` are renderer-callable (I47: bundled id only from a `ui`
 * connection, refused in `ipc/pack-rpc.ts`). Only `pack.install` asks the owner, through the same gate-only executor as
 * `registry.add` (a local config-layer write, no connector dispatch, so no egress row). This file
 * calls the install module only, never the store's write half.
 */
export async function tryDispatchPackRpc(
  ctx: ServerCtx,
  clientId: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("pack.")) {
    return packRpcSkipped;
  }
  const store = ctx.options.packLayerStore;
  const configDir = ctx.options.configDir;
  if (store === undefined || configDir === undefined) {
    throw new RpcMethodError(-32603, "pack.* needs the pack-layer store and configDir");
  }
  const vault = ctx.options.vault;
  const deps = buildPackDeps({
    store,
    configDir,
    isConfigured: (serviceId) => isConnectorConfigured(vault, serviceId),
  });
  let ownerGate: PackOwnerGate | undefined;
  const localIndex = ctx.options.localIndex;
  if (method === "pack.install" && localIndex !== undefined) {
    const toolExecutor = buildExtensionGateExecutor(ctx, localIndex, clientId);
    ownerGate = async (action) => (await toolExecutor.gate(action)) === "proceed";
  }
  const out = await dispatchPackRpc(
    method,
    params,
    deps,
    ownerGate,
    ctx.getClientKind(clientId) === "ui",
  );
  if (out.kind === "hit") {
    return out.value;
  }
  throw new RpcMethodError(-32601, `Method not found: ${method}`);
}
