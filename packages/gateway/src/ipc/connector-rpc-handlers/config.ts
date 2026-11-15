import { realpathSync } from "node:fs";
import { normalizeConnectorServiceId } from "../../connectors/connector-catalog.ts";
import { removeDoorApprovals } from "../../connectors/connector-writes/door-approval-store.ts";
import { registeredWriteDirsOf } from "../../connectors/lazy-mesh/user-mcp-write-deps.ts";
import { userMcpWriteConfineRefusal } from "../../connectors/lazy-mesh/user-mcp-write-grant.ts";
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
import { APPROVER_BY_KIND } from "../../mcp-sink/capture-client-policy.ts";
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

/** The host OS `connector.addMcp` resolves for; refuses rather than guessing when none was passed. */
function requireAddMcpPlatform(ctx: ConnectorRpcHandlerContext): NodeJS.Platform {
  if (ctx.platform === undefined) {
    throw new ConnectorRpcError(-32603, "connector.addMcp requires the host platform");
  }
  return ctx.platform;
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
  const writePaths = stringArrayParam(rec, "writePaths");
  const modelAccessRaw = rec?.["modelAccess"];
  if (modelAccessRaw !== undefined && typeof modelAccessRaw !== "boolean") {
    throw new ConnectorRpcError(-32602, "modelAccess must be a boolean");
  }
  const registered = listUserMcpConnectors(localIndex.getDatabase());
  try {
    return resolveUserMcpRegistration(
      { serviceId, argv, readPaths, netHosts, modelAccess: modelAccessRaw === true, writePaths },
      {
        // I15 (AD5b). The write-directory rule's facts are read only for a registration that names
        // one; every other server's write directories are read always (the reverse rule: this
        // server's code may not lie inside one).
        ...(writePaths.length === 0 ? {} : { writeDir: connectorMesh.userMcpWriteDirDeps() }),
        registeredWriteDirs: registeredWriteDirsOf(registered, serviceId),
        platform: requireAddMcpPlatform(ctx),
        protectedRoots: connectorMesh.userMcpProtectedRoots(),
        registeredServiceIds: registered.map((r) => r.service_id),
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

/** The fixed sentence a non-human approval of a write grant is declined with (OR-AD-33). */
export const WRITE_GRANT_NON_HUMAN_DECLINE =
  "a write directory can only be approved by a person answering at the terminal or the desktop app";

/**
 * A registration that carries a write directory (I15, AD5b), BEFORE the owner is asked:
 *  - only a connection that declared `cli` or `ui` may ask (owner ruling OR-AD-33; the consent
 *    channel is the human-only one, wrapped by the dispatcher);
 *  - the sandbox of this OS must be able to confine the grant (OR-AD-30), or nothing is stored.
 * A registration with no write directory is not touched by either check.
 */
export function assertWriteGrantRegistrable(
  ctx: ConnectorRpcHandlerContext,
  resolved: ResolvedUserMcpRegistration,
): void {
  if (resolved.writePaths.length === 0) return;
  if (!APPROVER_BY_KIND[ctx.clientKind ?? "unknown"]) {
    throw new ConnectorRpcError(
      -32000,
      "ERR_USER_MCP_WRITE_GRANT_CLIENT: registering a server with a write directory needs a terminal or desktop connection that declared itself",
    );
  }
  const { connectorMesh } = ctx;
  if (connectorMesh === undefined) {
    throw new ConnectorRpcError(-32603, "User MCP registration requires sync and connector mesh");
  }
  const cannot = userMcpWriteConfineRefusal(resolved, (policy) =>
    connectorMesh.userMcpWriteCanConfine(policy),
  );
  if (cannot !== null) {
    throw new ConnectorRpcError(-32602, `ERR_USER_MCP_WRITE_PATH_REFUSED: ${cannot}`);
  }
}

/**
 * Runs AFTER the owner approved: the registration is resolved AGAIN, against the registrations and
 * the file system as they are now, and must come out exactly as the owner was shown it. A prompt
 * can stay open for a long time; another registration approved meanwhile (a server whose code now
 * lies in this one's write directory, a write directory that now holds this one's code), a folder
 * that became a link or gained a marker, would otherwise be stored unchecked.
 */
export function assertRegistrationUnchanged(
  ctx: ConnectorRpcHandlerContext,
  approved: ResolvedUserMcpRegistration,
): void {
  const now = resolveConnectorAddMcp(ctx);
  assertWriteGrantRegistrable(ctx, now);
  if (JSON.stringify(now) !== JSON.stringify(approved)) {
    throw new ConnectorRpcError(
      -32602,
      "ERR_USER_MCP_CHANGED_DURING_APPROVAL: what this registration resolves to changed while you were deciding; run the command again",
    );
  }
}

/**
 * Runs AFTER the owner approved and BEFORE the row is stored: on Windows, every path an EARLIER
 * registration of this id was granted is revoked from the ledger, or the registration is REFUSED
 * and nothing is stored. A profile created again under the same name keeps its old permissions
 * (measured), so a re-registered id would otherwise inherit them. A no-op elsewhere.
 */
export async function assertUserMcpGrantsClean(
  ctx: ConnectorRpcHandlerContext,
  serviceId: string,
): Promise<void> {
  const { connectorMesh } = ctx;
  if (connectorMesh === undefined) {
    throw new ConnectorRpcError(-32603, "User MCP registration requires sync and connector mesh");
  }
  const released = await connectorMesh.releaseUserMcpGrantsUnlessRegistered(serviceId);
  if (released === "registered") {
    // Registered while this request waited for its approval: nothing of the live registration is
    // revoked, and this add is the duplicate.
    throw new ConnectorRpcError(-32602, `User MCP connector already exists: ${serviceId}`);
  }
  if (released) return;
  throw new ConnectorRpcError(
    -32602,
    "ERR_USER_MCP_GRANTS_NOT_CLEAN: file permissions left by an earlier registration of this id could not be removed; retry, or restart Nimbus and retry",
  );
}

/**
 * Runs AFTER the owner approved and BEFORE the row is stored: a sandbox leaf left over from an
 * earlier registration of the same id (its removal is best-effort, so a locked leaf can survive)
 * is cleared, or the registration is REFUSED and nothing is stored — the leaf is deterministic, so
 * a new server would otherwise inherit the previous one's files.
 */
export async function assertUserMcpSandboxClean(
  ctx: ConnectorRpcHandlerContext,
  serviceId: string,
): Promise<void> {
  const { connectorMesh } = ctx;
  if (connectorMesh === undefined) {
    throw new ConnectorRpcError(-32603, "User MCP registration requires sync and connector mesh");
  }
  if (await connectorMesh.ensureUserMcpSandboxClean(serviceId)) return;
  throw new ConnectorRpcError(
    -32602,
    `ERR_USER_MCP_SANDBOX_NOT_CLEAN: ${connectorMesh.userMcpSandboxLeaf(serviceId)} could not be cleared; stop any process using it and retry`,
  );
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
    // One transaction: leftover agent approvals of an earlier registration of this id are deleted
    // with the insert (AD5a, D-5), so a re-registered id starts with nothing approved for agents. A
    // duplicate add fails the insert and rolls the delete back: the live registration keeps its own.
    db.transaction(() => {
      removeDoorApprovals(db, serviceId);
      insertUserMcpConnector(db, {
        service_id: serviceId,
        command: resolved.command,
        args_json: JSON.stringify(resolved.args),
        read_paths_json: JSON.stringify(resolved.readPaths),
        net_hosts_json: JSON.stringify(resolved.netHosts),
        model_access: resolved.modelAccess ? 1 : 0,
        write_paths_json: JSON.stringify(resolved.writePaths),
      });
    })();
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
  // The reply states what was STORED (the CLI prints these, never what it sent): a client talking
  // to an older gateway sees no `writePaths` key and knows no write directory was granted.
  return {
    kind: "hit",
    value: {
      ok: true,
      serviceId,
      readPaths: resolved.readPaths,
      netHosts: resolved.netHosts,
      writePaths: resolved.writePaths,
      modelAccess: resolved.modelAccess,
    },
  };
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
