import { readConnectorSecret } from "../../connectors/connector-vault.ts";
import { resolveGithubBase } from "../../connectors/github-api-base.ts";
import { getConnectorHealthHistory } from "../../connectors/health.ts";
import { listRecentSyncTelemetry } from "../../sync/scheduler-store.ts";
import type { SyncStatus } from "../../sync/types.ts";
import {
  ConnectorRpcError,
  parseServiceArg,
  requireRegisteredSchedulerServiceId,
  resolveConnectorListFilterServiceId,
} from "../connector-rpc-shared.ts";
import type { ConnectorRpcHandlerContext, ConnectorRpcHit } from "./context.ts";

export function handleConnectorListStatus(ctx: ConnectorRpcHandlerContext): ConnectorRpcHit {
  const { rec, localIndex } = ctx;
  const filter =
    rec !== undefined && typeof rec["serviceId"] === "string" ? rec["serviceId"] : undefined;
  let list: SyncStatus[];
  if (filter !== undefined && filter !== "") {
    const sid = resolveConnectorListFilterServiceId(filter);
    if (sid === null) {
      throw new ConnectorRpcError(-32602, "Invalid serviceId filter");
    }
    list = localIndex.persistedConnectorStatuses(sid);
  } else {
    list = localIndex.persistedConnectorStatuses();
  }
  return { kind: "hit", value: list };
}

export function handleConnectorStatus(ctx: ConnectorRpcHandlerContext): ConnectorRpcHit {
  const { rec, localIndex } = ctx;
  const id = requireRegisteredSchedulerServiceId(rec, localIndex);
  const rows = localIndex.persistedConnectorStatuses(id);
  if (rows.length === 0) {
    throw new ConnectorRpcError(-32602, `Unknown connector: ${id}`);
  }
  const row = rows[0];
  if (row === undefined) {
    throw new ConnectorRpcError(-32602, `Unknown connector: ${id}`);
  }
  const includeStats = rec?.["includeStats"] === true || rec?.["stats"] === true;
  if (includeStats) {
    const telemetry = listRecentSyncTelemetry(localIndex.getDatabase(), id, 15);
    return { kind: "hit", value: { ...row, telemetry } };
  }
  return { kind: "hit", value: row };
}

/**
 * `connector.status` for a GitHub service adds `instance`: the GitHub Enterprise Server HOST the
 * connector is connected to (never the URL, never a credential), only when a valid
 * `github.api_base` is stored. github.com, an absent or an invalid base shows no field. Read-only.
 */
export async function withConfiguredInstance(
  ctx: ConnectorRpcHandlerContext,
  hit: ConnectorRpcHit,
): Promise<ConnectorRpcHit> {
  const row = hit.value as { serviceId?: unknown } | null;
  if (row?.serviceId !== "github" && row?.serviceId !== "github_actions") return hit;
  const base = resolveGithubBase(await readConnectorSecret(ctx.vault, "github", "api_base"));
  if (!base.ok || base.host === null) return hit;
  return { kind: "hit", value: { ...row, instance: base.host } };
}

export function handleConnectorHealthHistory(ctx: ConnectorRpcHandlerContext): ConnectorRpcHit {
  const { rec, localIndex } = ctx;
  const id = parseServiceArg(rec);
  let limit = 100;
  if (rec !== undefined && typeof rec["limit"] === "number" && Number.isFinite(rec["limit"])) {
    limit = Math.min(500, Math.max(1, Math.floor(rec["limit"])));
  }
  const rows = getConnectorHealthHistory(localIndex.getDatabase(), id, limit);
  return {
    kind: "hit",
    value: rows.map((r) => ({
      id: r.id,
      connectorId: r.connectorId,
      fromState: r.fromState,
      toState: r.toState,
      reason: r.reason,
      occurredAtMs: r.occurredAt.getTime(),
    })),
  };
}
