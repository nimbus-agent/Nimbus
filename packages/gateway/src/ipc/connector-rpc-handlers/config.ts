import { normalizeConnectorServiceId } from "../../connectors/connector-catalog.ts";
import {
  insertUserMcpConnector,
  normalizeUserMcpServiceId,
  parseUserMcpCommandLine,
  validateUserMcpArgsJson,
} from "../../connectors/user-mcp-store.ts";
import { createUserMcpSyncable } from "../../connectors/user-mcp-sync.ts";
import { MIN_SYNC_INTERVAL_MS } from "../../sync/constants.ts";
import { ConnectorRpcError, requireRegisteredSchedulerServiceId } from "../connector-rpc-shared.ts";
import type { ConnectorRpcHandlerContext, ConnectorRpcHit } from "./context.ts";
import { emitConfigChanged, pauseConnector, resumeConnector } from "./lifecycle.ts";

export async function handleConnectorAddMcp(
  ctx: ConnectorRpcHandlerContext,
): Promise<ConnectorRpcHit> {
  const { rec, localIndex, syncScheduler, connectorMesh } = ctx;
  if (syncScheduler === undefined || connectorMesh === undefined) {
    throw new ConnectorRpcError(-32603, "User MCP registration requires sync and connector mesh");
  }
  const serviceRaw = rec?.["serviceId"];
  const cmdRaw = rec?.["commandLine"];
  if (typeof serviceRaw !== "string" || typeof cmdRaw !== "string") {
    throw new ConnectorRpcError(-32602, "Missing serviceId or commandLine");
  }
  const serviceId = normalizeUserMcpServiceId(serviceRaw);
  if (serviceId === null) {
    throw new ConnectorRpcError(
      -32602,
      "serviceId must match mcp_<lowercase_letters_numbers_underscores> (1–62 chars after prefix)",
    );
  }
  if (normalizeConnectorServiceId(serviceId) !== null) {
    throw new ConnectorRpcError(-32602, "serviceId conflicts with a built-in connector id");
  }
  const { command, args } = parseUserMcpCommandLine(cmdRaw);
  const argsJson = validateUserMcpArgsJson(args);
  const db = localIndex.getDatabase();
  try {
    insertUserMcpConnector(db, { service_id: serviceId, command, args_json: argsJson });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE") || msg.includes("unique")) {
      throw new ConnectorRpcError(-32602, `User MCP connector already exists: ${serviceId}`);
    }
    throw new ConnectorRpcError(-32603, `Failed to save user MCP connector: ${msg}`);
  }
  syncScheduler.register(
    createUserMcpSyncable(serviceId, () => connectorMesh.ensureUserMcpRunning(serviceId)),
  );
  return { kind: "hit", value: { ok: true, serviceId } };
}

export function handleConnectorSetInterval(ctx: ConnectorRpcHandlerContext): ConnectorRpcHit {
  const { rec, localIndex, syncScheduler, notify } = ctx;
  const id = requireRegisteredSchedulerServiceId(rec, localIndex);
  const msRaw = rec?.["intervalMs"];
  if (typeof msRaw !== "number" || !Number.isFinite(msRaw) || msRaw < 1) {
    throw new ConnectorRpcError(-32602, "Invalid intervalMs");
  }
  const ms = Math.floor(msRaw);
  localIndex.setConnectorSyncIntervalMs(id, ms, Date.now());
  if (syncScheduler !== undefined) {
    syncScheduler.setInterval(id, ms);
  }
  emitConfigChanged(notify, localIndex, id);
  return { kind: "hit", value: { ok: true } };
}

const VALID_DEPTHS = ["metadata_only", "summary", "full"] as const;

export function handleConnectorSetConfig(ctx: ConnectorRpcHandlerContext): ConnectorRpcHit {
  const { rec, localIndex, syncScheduler, notify } = ctx;
  const id = requireRegisteredSchedulerServiceId(rec, localIndex);
  const intervalMs = rec?.["intervalMs"];
  const depth = rec?.["depth"];
  const enabled = rec?.["enabled"];
  if (typeof intervalMs === "number") {
    if (!Number.isFinite(intervalMs)) {
      throw new ConnectorRpcError(-32602, "Invalid intervalMs");
    }
    const ms = Math.floor(intervalMs);
    if (ms < MIN_SYNC_INTERVAL_MS) {
      throw new ConnectorRpcError(
        -32602,
        `intervalMs must be >= ${MIN_SYNC_INTERVAL_MS} (60 seconds)`,
      );
    }
    localIndex.setConnectorSyncIntervalMs(id, ms, Date.now());
    if (syncScheduler !== undefined) {
      syncScheduler.setInterval(id, ms);
    }
  }

  if (typeof depth === "string") {
    if (!VALID_DEPTHS.includes(depth as (typeof VALID_DEPTHS)[number])) {
      throw new ConnectorRpcError(-32602, `Invalid depth: must be ${VALID_DEPTHS.join("|")}`);
    }
    localIndex.setConnectorDepth(id, depth as "metadata_only" | "summary" | "full");
  }

  if (enabled === true) {
    resumeConnector(id, syncScheduler, localIndex);
  } else if (enabled === false) {
    pauseConnector(id, syncScheduler, localIndex);
  }

  emitConfigChanged(notify, localIndex, id);

  return {
    kind: "hit",
    value: {
      service: id,
      intervalMs: typeof intervalMs === "number" ? Math.floor(intervalMs) : null,
      depth: typeof depth === "string" ? depth : null,
      enabled: typeof enabled === "boolean" ? enabled : null,
    },
  };
}
