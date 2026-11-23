import { homedir } from "node:os";
import { NULL_EGRESS_SINK } from "../../../egress/egress-ledger.ts";
import { bindConsentChannel, NO_POLICY_OVERLAY, ToolExecutor } from "../../../engine/executor.ts";
import { createOwnerOnlyAsk } from "../../../engine/owner-only-approval.ts";
import type { ConnectorDispatcher } from "../../../engine/types.ts";
import { resolveRuntimeById } from "../../../exec/exec-runtimes.ts";
import {
  type ExtensionEvidenceDeps,
  updateAccessEvidence,
} from "../../../extensions/extension-evidence.ts";
import type { ExtensionRunGrantEnv } from "../../../extensions/extension-run-grants.ts";
import { extensionObservationDirFor } from "../../../extensions/observation/observation-ingest.ts";
import { buildExtensionRunGrantEnv } from "../../../extensions/run-grant-env.ts";
import { AutomationRpcError, dispatchAutomationRpc } from "../../automation-rpc.ts";
import type { ClientSession } from "../../session.ts";
import { createWorkflowCancelHandler } from "../../workflow-cancel.ts";
import { dispatchWorkflowImportRpc, isWorkflowImportMethod } from "../../workflow-import-rpc.ts";
import { automationRpcSkipped, type ServerCtx } from "../context.ts";
import { dispatchWorkflowResumeRpc, dispatchWorkflowRunRpc } from "../inline-handlers.ts";
import { RpcMethodError } from "../rpc-error.ts";

function buildAutoUpdateDeps(
  ctx: ServerCtx,
  clientId: string,
  method: string,
  evidence: ExtensionEvidenceDeps | undefined,
): Parameters<typeof dispatchAutomationRpc>[0]["autoUpdate"] {
  if (
    ctx.options.extensionsAutoUpdate === undefined ||
    (method !== "extension.checkForUpdates" && method !== "extension.update") ||
    ctx.options.localIndex === undefined
  ) {
    return undefined;
  }
  const toolExecutor = buildExtensionGateExecutor(ctx, ctx.options.localIndex, clientId);
  const db = ctx.options.localIndex.getDatabase();
  return {
    ...ctx.options.extensionsAutoUpdate,
    updateAccess: (cached, addedUnion, direction) =>
      updateAccessEvidence(db, evidence, cached, addedUnion, direction, ctx.options.extensionsDir),
    gate: async (action) => {
      const r = await toolExecutor.gate(action);
      if (r === "proceed") return "proceed";
      return { status: "rejected" };
    },
  };
}

/**
 * The gate-only executor every extension-lifecycle approval runs through (auto-update, install,
 * rehash).
 * I29: gate-only — a local mutation with no connector dispatch, so there is no egress to ledger;
 * its dispatcher rejects, so nothing can reach a connector through it.
 */
export function buildExtensionGateExecutor(
  ctx: ServerCtx,
  localIndex: NonNullable<ServerCtx["options"]["localIndex"]>,
  clientId: string,
): ToolExecutor {
  const stubDispatcher: ConnectorDispatcher = {
    dispatch(): Promise<unknown> {
      return Promise.reject(new Error("extension gate does not dispatch to MCP"));
    },
  };
  return new ToolExecutor(
    bindConsentChannel(ctx.consentImpl, clientId),
    localIndex,
    stubDispatcher,
    undefined,
    NULL_EGRESS_SINK,
    ctx.options.policyHitl ?? NO_POLICY_OVERLAY,
  );
}

/** Methods whose handler asks the local owner through {@link buildExtensionGateExecutor}. */
const OWNER_GATED_EXTENSION_METHODS: ReadonlySet<string> = new Set([
  "extension.install",
  "extension.rehash",
  "extension.approveRun",
  "extension.credentialSet",
  "extension.eval",
]);

function buildExtensionOwnerGate(
  ctx: ServerCtx,
  clientId: string,
  method: string,
): Parameters<typeof dispatchAutomationRpc>[0]["ownerGate"] {
  if (!OWNER_GATED_EXTENSION_METHODS.has(method) || ctx.options.localIndex === undefined) {
    return undefined;
  }
  const toolExecutor = buildExtensionGateExecutor(ctx, ctx.options.localIndex, clientId);
  return async (action) => (await toolExecutor.gate(action)) === "proceed";
}

/**
 * What `extension.approveRun` resolves grants against: the protected roots user MCP refuses
 * (`[dataDir, configDir, sandboxDir]`) plus the configured extensions dir — a sibling of the data
 * dir on Windows — and the Bun runtime's read paths, shown in the prompt. No mesh
 * means no protected roots to check against, so the method refuses rather than skipping the check.
 */
function extensionRunGrantEnvFor(ctx: ServerCtx, method: string): ExtensionRunGrantEnv | undefined {
  const mesh = ctx.options.connectorMesh;
  if ((method !== "extension.approveRun" && method !== "extension.eval") || mesh === undefined) {
    return undefined;
  }
  // The SAME builder the runtime's pre-spawn verifier is given in `platform/assemble.ts`, so the
  // grant approved here is resolved identically before every spawn.
  return buildExtensionRunGrantEnv(mesh.userMcpProtectedRoots(), ctx.options.extensionsDir);
}

/** The methods whose approval or info states reach and the predicted file outcome. */
const EXTENSION_EVIDENCE_METHODS: ReadonlySet<string> = new Set([
  "extension.install",
  "extension.info",
  "extension.update",
  "registry.install",
  "registry.info",
]);

/**
 * What an install or update approval describes this machine with: the live sandbox runner and the
 * SAME run-grant environment `extension.approveRun` checks paths against, so the predicted file
 * outcome is the approval's own check. No mesh means no environment: the paths are then reported
 * as not checked, never as passing.
 */
export function extensionEvidenceDepsFor(
  ctx: ServerCtx,
  method: string,
): ExtensionEvidenceDeps | undefined {
  if (!EXTENSION_EVIDENCE_METHODS.has(method)) return undefined;
  const mesh = ctx.options.connectorMesh;
  return {
    homeDir: homedir(),
    ...(ctx.options.sandboxRunner === undefined ? {} : { sandbox: ctx.options.sandboxRunner }),
    ...(mesh === undefined
      ? {}
      : {
          grantEnv: buildExtensionRunGrantEnv(
            mesh.userMcpProtectedRoots(),
            ctx.options.extensionsDir,
          ),
        }),
  };
}

/** What `extension.eval` runs with: the Bun runtime's read paths, the sandbox dir and the runner. */
function extensionEvalDepsFor(
  ctx: ServerCtx,
  method: string,
): Parameters<typeof dispatchAutomationRpc>[0]["evalDeps"] {
  const runner = ctx.options.sandboxRunner;
  const sandboxDir = ctx.options.sandboxDir;
  if (method !== "extension.eval" || runner === undefined || sandboxDir === undefined) {
    return undefined;
  }
  return {
    sandboxDir,
    runtimeReadPaths: resolveRuntimeById("bun").requiredReadPaths(),
    canConfine: (p) => runner.canConfine(p),
  };
}

/** The gateway's observation directory, when this server knows its data directory. */
function observationDirOf(dataDir: string | undefined): string | undefined {
  return dataDir === undefined ? undefined : extensionObservationDirFor(dataDir);
}

/** The automation dispatcher's inputs that come straight from the server's options, each present only when set. */
function automationServerOptions(
  ctx: ServerCtx,
): Partial<Parameters<typeof dispatchAutomationRpc>[0]> {
  const o = ctx.options;
  return {
    ...(o.extensionsDir === undefined ? {} : { extensionsDir: o.extensionsDir }),
    ...(o.connectorMesh === undefined ? {} : { mesh: o.connectorMesh }),
    ...(o.sandboxRunner === undefined ? {} : { sandboxRunner: o.sandboxRunner }),
    ...(o.extensionsRuntimeEnabled === undefined
      ? {}
      : { extensionsRuntimeEnabled: o.extensionsRuntimeEnabled }),
    ...(o.extensionSync === undefined ? {} : { extensionSync: o.extensionSync }),
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
    const evidence = extensionEvidenceDepsFor(ctx, method);
    const autoUpdateDeps = buildAutoUpdateDeps(ctx, clientId, method, evidence);
    const ownerGate = buildExtensionOwnerGate(ctx, clientId, method);
    const runGrantEnv = extensionRunGrantEnvFor(ctx, method);
    const evalDeps = extensionEvalDepsFor(ctx, method);
    const out = await dispatchAutomationRpc({
      method,
      params,
      db: ctx.options.localIndex.getDatabase(),
      // SA4: the CONNECTION's declared kind (server-held), so `workflow.save` can refuse a
      // schedule from any client that is not the owner's CLI or desktop. Never from params.
      clientKind: ctx.getClientKind(clientId),
      ...automationServerOptions(ctx),
      ...(ctx.options.continuityTable === undefined
        ? {}
        : { continuityTable: ctx.options.continuityTable }),
      vault: ctx.options.vault,
      ...(autoUpdateDeps === undefined ? {} : { autoUpdate: autoUpdateDeps }),
      ...(ownerGate === undefined ? {} : { ownerGate }),
      ...(runGrantEnv === undefined ? {} : { runGrantEnv }),
      ...(evalDeps === undefined ? {} : { evalDeps }),
      ...(evidence === undefined ? {} : { evidence }),
      observationDir: observationDirOf(ctx.options.dataDir),
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

/**
 * `workflow.export` and `workflow.import` (I59): the owner's signed workflow bundles. Both answer only a
 * connection that declared `cli` or `ui` (`getClientKind`, never a param), are LAN-forbidden and
 * demo-refused, and the import asks the LOCAL owner through the gate-only executor with no delegation on
 * THIS connection's consent channel (a human answer only).
 */
async function dispatchWorkflowImportRpcFor(
  ctx: ServerCtx,
  clientId: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  const localIndex = ctx.options.localIndex;
  if (localIndex === undefined) {
    throw new RpcMethodError(-32603, "Local index is not available");
  }
  const out = await dispatchWorkflowImportRpc(method, params, {
    db: localIndex.getDatabase(),
    callerKind: ctx.getClientKind(clientId),
    askOwner: createOwnerOnlyAsk({
      consent: bindConsentChannel(ctx.consentImpl, clientId),
      audit: localIndex,
      policyHitl: ctx.options.policyHitl,
    }),
    vault: ctx.options.vault,
    recordAudit: (actionType, actionJson) =>
      localIndex.recordAudit({
        actionType,
        hitlStatus: "not_required",
        actionJson,
        timestamp: Date.now(),
      }),
  });
  if (out.kind === "hit") return out.value;
  throw new RpcMethodError(-32601, `Method not found: ${method}`);
}

export async function tryDispatchAutomationRpc(
  ctx: ServerCtx,
  clientId: string,
  session: ClientSession,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (isWorkflowImportMethod(method)) {
    return dispatchWorkflowImportRpcFor(ctx, clientId, method, params);
  }

  if (method === "workflow.run") {
    return dispatchWorkflowRunRpc(ctx, clientId, session, params);
  }

  if (method === "workflow.resume") {
    return dispatchWorkflowResumeRpc(ctx, clientId, session, params);
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
