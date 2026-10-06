import { realpathSync } from "node:fs";
import { normalizeConnectorServiceId } from "../../connectors/connector-catalog.ts";
import {
  type ResolvedUserMcpRegistration,
  resolveUserMcpRegistration,
  UserMcpRegistrationError,
} from "../../connectors/user-mcp-registration.ts";
import {
  insertUserMcpConnector,
  listUserMcpConnectors,
  normalizeUserMcpServiceId,
  parseUserMcpCommandLine,
} from "../../connectors/user-mcp-store.ts";
import { createUserMcpSyncable } from "../../connectors/user-mcp-sync.ts";
import { MIN_SYNC_INTERVAL_MS } from "../../sync/constants.ts";
import { ConnectorRpcError, requireRegisteredSchedulerServiceId } from "../connector-rpc-shared.ts";
import type { ConnectorRpcHandlerContext, ConnectorRpcHit } from "./context.ts";
import { emitConfigChanged, pauseConnector, resumeConnector } from "./lifecycle.ts";

/**
 * Production `realpath` for `connector.addMcp`. The NATIVE variant on purpose: the JS
 * `realpathSync` returns the caller's spelling, not the on-disk case on a case-insensitive volume
 * (APFS, NTFS), and does not expand Windows 8.3 short names or trailing dots — so a protected
 * Nimbus directory could be named past the overlap check in a different spelling.
 */
export const defaultUserMcpRealpath: (p: string) => string = realpathSync.native;

/** Production `which` for `connector.addMcp`: resolves a bare command name on `PATH`. */
export const defaultUserMcpWhich: (cmd: string) => string | null = Bun.which;

function stringArrayParam(rec: Record<string, unknown> | undefined, key: string): string[] {
  const v = rec?.[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x): x is string => typeof x === "string")) {
    throw new ConnectorRpcError(-32602, `${key} must be an array of strings`);
  }
  return v;
}

function argvParam(rec: Record<string, unknown> | undefined): string[] {
  const argvRaw = rec?.["argv"];
  const cmdRaw = rec?.["commandLine"];
  if ((argvRaw === undefined) === (cmdRaw === undefined)) {
    throw new ConnectorRpcError(-32602, "Provide exactly one of argv or commandLine");
  }
  if (cmdRaw !== undefined) {
    if (typeof cmdRaw !== "string") {
      throw new ConnectorRpcError(-32602, "commandLine must be a string");
    }
    // Compatibility path: whitespace-split, so a path containing a space cannot be expressed here.
    try {
      const { command, args } = parseUserMcpCommandLine(cmdRaw);
      return [command, ...args];
    } catch (e) {
      throw new ConnectorRpcError(-32602, e instanceof Error ? e.message : String(e));
    }
  }
  // argv tokens are taken VERBATIM: `["C:\Users\Jane Doe\x.exe"]` stays one token.
  return stringArrayParam(rec, "argv");
}

/**
 * Parses `connector.addMcp`'s params and resolves them to the FINAL values the row will store
 * (absolute command, canonical read paths, normalised hosts) — BEFORE the HITL gate, so the owner
 * approves exactly what is stored and an invalid request never prompts. Every refusal is a
 * `ConnectorRpcError`; a resolver refusal carries its `ERR_USER_MCP_*` code as the message prefix.
 */
export function resolveConnectorAddMcp(
  ctx: ConnectorRpcHandlerContext,
): ResolvedUserMcpRegistration {
  const { rec, localIndex, syncScheduler, connectorMesh } = ctx;
  if (syncScheduler === undefined || connectorMesh === undefined) {
    throw new ConnectorRpcError(-32603, "User MCP registration requires sync and connector mesh");
  }
  const serviceRaw = rec?.["serviceId"];
  if (typeof serviceRaw !== "string") {
    throw new ConnectorRpcError(-32602, "Missing serviceId");
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
  const argv = argvParam(rec);
  const readPaths = stringArrayParam(rec, "readPaths");
  const netHosts = stringArrayParam(rec, "netHosts");
  const modelAccessRaw = rec?.["modelAccess"];
  if (modelAccessRaw !== undefined && typeof modelAccessRaw !== "boolean") {
    throw new ConnectorRpcError(-32602, "modelAccess must be a boolean");
  }
  try {
    return resolveUserMcpRegistration(
      { serviceId, argv, readPaths, netHosts, modelAccess: modelAccessRaw === true },
      {
        platform: process.platform,
        protectedRoots: connectorMesh.userMcpProtectedRoots(),
        registeredServiceIds: listUserMcpConnectors(localIndex.getDatabase()).map(
          (r) => r.service_id,
        ),
        which: ctx.resolveCommand ?? defaultUserMcpWhich,
        realpath: ctx.realpath ?? defaultUserMcpRealpath,
      },
    );
  } catch (e) {
    if (e instanceof UserMcpRegistrationError) {
      throw new ConnectorRpcError(-32602, `${e.code}: ${e.message}`);
    }
    throw e;
  }
}

/** Stores an ALREADY-APPROVED registration (resolved by `resolveConnectorAddMcp`) and registers its syncable. */
export function handleConnectorAddMcp(
  ctx: ConnectorRpcHandlerContext,
  resolved: ResolvedUserMcpRegistration,
): ConnectorRpcHit {
  const { localIndex, syncScheduler, connectorMesh } = ctx;
  if (syncScheduler === undefined || connectorMesh === undefined) {
    throw new ConnectorRpcError(-32603, "User MCP registration requires sync and connector mesh");
  }
  const { serviceId } = resolved;
  const db = localIndex.getDatabase();
  try {
    insertUserMcpConnector(db, {
      service_id: serviceId,
      command: resolved.command,
      args_json: JSON.stringify(resolved.args),
      read_paths_json: JSON.stringify(resolved.readPaths),
      net_hosts_json: JSON.stringify(resolved.netHosts),
      model_access: resolved.modelAccess ? 1 : 0,
    });
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
