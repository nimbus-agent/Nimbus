import { randomUUID } from "node:crypto";

import { MCPClient } from "@mastra/mcp";

import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import { transitionHealth } from "../health.ts";
import type { UserMcpConnectorRow } from "../user-mcp-store.ts";
import { userMcpMeshKey } from "./keys.ts";
import type { MeshSpawnContext } from "./slot.ts";
import { wrapServerSpec } from "./wrap-server-spec.ts";

type StringArrayParse = { ok: true; value: string[] } | { ok: false; reason: string };

function parseStringArrayColumn(raw: string): StringArrayParse {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
      return { ok: false, reason: "expected string array" };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, reason: "JSON parse failed" };
  }
}

/**
 * The spawn manifest for a user MCP server: its owner-approved grants, nothing more. The id stays
 * `user.<service_id>` — it names the Windows AppContainer profile and the sandbox cwd leaf.
 */
export function userMcpManifestFromRow(
  row: UserMcpConnectorRow,
):
  | { ok: true; manifest: ExtensionManifest }
  | { ok: false; column: "read_paths_json" | "net_hosts_json"; reason: string } {
  const read = parseStringArrayColumn(row.read_paths_json);
  if (!read.ok) {
    return { ok: false, column: "read_paths_json", reason: read.reason };
  }
  const net = parseStringArrayColumn(row.net_hosts_json);
  if (!net.ok) {
    return { ok: false, column: "net_hosts_json", reason: net.reason };
  }
  return {
    ok: true,
    manifest: {
      id: `user.${row.service_id}`,
      version: "0.0.0",
      permissions: {
        network: net.value,
        filesystem: { read: read.value, write: [] },
      },
      updateChannel: "stable",
    },
  };
}

export function recordUserMcpRowFailure(
  ctx: MeshSpawnContext,
  serviceId: string,
  column: "args_json" | "read_paths_json" | "net_hosts_json",
  reason: string,
): void {
  if (ctx.logger !== undefined) {
    ctx.logger.warn(
      { serviceId, column, reason },
      `user MCP ${column} failed to parse — slot left unconfigured`,
    );
  }
  if (ctx.healthDb !== undefined) {
    transitionHealth(ctx.healthDb, serviceId, {
      type: "persistent_error",
      error: `malformed ${column} (${reason})`,
    });
  }
}

function mcpServerKeyForUserConnector(serviceId: string): string {
  return serviceId.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Registers the user MCP described by `row` in its mesh slot. Synchronous: the args parse, the
 * sandbox wrap and the `MCPClient` construction all complete here, and the client connects (spawns
 * its server) lazily, on first use.
 */
export function ensureUserMcpClient(ctx: MeshSpawnContext, row: UserMcpConnectorRow): void {
  const meshKey = userMcpMeshKey(row.service_id);
  ctx.clearLazyIdle(meshKey);
  if (ctx.getLazyClient(meshKey) !== undefined) {
    ctx.scheduleLazyDisconnect(meshKey);
    return;
  }
  const argsParsed = parseStringArrayColumn(row.args_json);
  if (!argsParsed.ok) {
    recordUserMcpRowFailure(ctx, row.service_id, "args_json", argsParsed.reason);
    return;
  }
  const args = argsParsed.value;
  const m = userMcpManifestFromRow(row);
  if (!m.ok) {
    recordUserMcpRowFailure(ctx, row.service_id, m.column, m.reason);
    return;
  }
  const key = mcpServerKeyForUserConnector(row.service_id);
  const client = new MCPClient({
    id: `nimbus-user-mcp-${row.service_id}-${randomUUID()}`,
    servers: {
      [key]: wrapServerSpec(
        {
          command: row.command,
          args,
          env: extensionProcessEnv({}),
        },
        m.manifest,
        ctx.sandboxCwd,
      ),
    },
  });
  ctx.setLazyClient(meshKey, client);
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(meshKey);
}
