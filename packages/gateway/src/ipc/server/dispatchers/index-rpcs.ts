import pino from "pino";
import { loadNimbusServiceConfigsFromConfigDir } from "../../../config/nimbus-toml.ts";
import { loadNimbusPreflightRiskFromConfigDir } from "../../../config/preflight-risk-toml.ts";
import { graphAnnotatedDeployment } from "../../../deployment/graph-annotated.ts";
import { NULL_EGRESS_SINK } from "../../../egress/egress-ledger.ts";
import { bindConsentChannel, NO_POLICY_OVERLAY, ToolExecutor } from "../../../engine/executor.ts";
import type { ConnectorDispatcher } from "../../../engine/types.ts";
import { DeploymentRpcError, dispatchDeploymentRpc } from "../../deployment-rpc.ts";
import { dispatchIndexRebodyRpc, IndexRebodyRpcError } from "../../index-rebody-rpc.ts";
import { dispatchIndexReembedRpc, IndexReembedRpcError } from "../../index-reembed-rpc.ts";
import { dispatchMetricsRpc, MetricsRpcError } from "../../metrics-rpc.ts";
import { dispatchPreflightRpc, PreflightRpcError } from "../../preflight-rpc.ts";
import { dispatchReindexRpc, ReindexRpcError } from "../../reindex-rpc.ts";
import {
  deploymentRpcSkipped,
  metricsRpcSkipped,
  phase4RpcSkipped,
  preflightRpcSkipped,
  type ServerCtx,
} from "../context.ts";
import { RpcMethodError } from "../rpc-error.ts";

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
      loadRiskConfig: () => loadNimbusPreflightRiskFromConfigDir(configDir),
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
    const db = ctx.options.localIndex.getDatabase();
    const out = await dispatchDeploymentRpc(method, params, {
      db,
      graphDeployment: (itemId) => graphAnnotatedDeployment(db, itemId),
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
      // `demo` is only ever assigned `true`, never `undefined` — `exactOptionalPropertyTypes`-safe.
      paths:
        ctx.options.demo === true
          ? { dataDir: ctx.options.dataDir, demo: true }
          : { dataDir: ctx.options.dataDir },
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
