import type { LocalIndex } from "../../index/local-index.ts";
import type { SyncScheduler } from "../../sync/scheduler.ts";
import { ConnectorRpcError, requireRegisteredSchedulerServiceId } from "../connector-rpc-shared.ts";
import type { ConnectorRpcHandlerContext, ConnectorRpcHit } from "./context.ts";

export function emitConfigChanged(
  notify: ((method: string, params: Record<string, unknown>) => void) | undefined,
  localIndex: LocalIndex,
  serviceId: string,
): void {
  if (notify === undefined) return;
  const statuses = localIndex.persistedConnectorStatuses(serviceId);
  const current = statuses[0];
  if (current === undefined) return;
  notify("connector.configChanged", {
    service: serviceId,
    intervalMs: current.intervalMs,
    depth: current.depth,
    enabled: current.enabled,
  });
}

export function resumeConnector(
  id: string,
  syncScheduler: SyncScheduler | undefined,
  localIndex: LocalIndex,
): void {
  if (syncScheduler === undefined) {
    localIndex.resumeConnectorSync(id);
  } else {
    syncScheduler.resume(id);
  }
}

export function pauseConnector(
  id: string,
  syncScheduler: SyncScheduler | undefined,
  localIndex: LocalIndex,
): void {
  if (syncScheduler === undefined) {
    localIndex.pauseConnectorSync(id);
  } else {
    syncScheduler.pause(id);
  }
}

export function handleConnectorPause(ctx: ConnectorRpcHandlerContext): ConnectorRpcHit {
  const { rec, localIndex, syncScheduler, notify } = ctx;
  const id = requireRegisteredSchedulerServiceId(rec, localIndex);
  if (syncScheduler === undefined) {
    localIndex.pauseConnectorSync(id);
  } else {
    syncScheduler.pause(id);
  }
  emitConfigChanged(notify, localIndex, id);
  return { kind: "hit", value: { ok: true } };
}

export function handleConnectorResume(ctx: ConnectorRpcHandlerContext): ConnectorRpcHit {
  const { rec, localIndex, syncScheduler, notify } = ctx;
  const id = requireRegisteredSchedulerServiceId(rec, localIndex);
  if (syncScheduler === undefined) {
    localIndex.resumeConnectorSync(id);
  } else {
    syncScheduler.resume(id);
  }
  emitConfigChanged(notify, localIndex, id);
  return { kind: "hit", value: { ok: true } };
}

export async function handleConnectorSync(
  ctx: ConnectorRpcHandlerContext,
): Promise<ConnectorRpcHit> {
  const { rec, localIndex, syncScheduler } = ctx;
  const id = requireRegisteredSchedulerServiceId(rec, localIndex);
  if (rec?.["full"] === true) {
    localIndex.clearConnectorSyncCursor(id);
  }
  if (syncScheduler === undefined) {
    throw new ConnectorRpcError(-32603, "Sync scheduler is not available");
  }
  await syncScheduler.forceSync(id);
  return { kind: "hit", value: { ok: true } };
}
