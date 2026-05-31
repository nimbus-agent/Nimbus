import { randomUUID } from "node:crypto";

import { MCPClient } from "@mastra/mcp";

import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import { transitionHealth } from "../health.ts";
import type { UserMcpConnectorRow } from "../user-mcp-store.ts";
import { userMcpMeshKey } from "./keys.ts";
import type { MeshSpawnContext } from "./slot.ts";
import { wrapServerSpec } from "./wrap-server-spec.ts";

function userMcpDefaultManifest(serviceId: string): ExtensionManifest {
  return {
    id: `user.${serviceId}`,
    version: "0.0.0",
    permissions: {
      network: [],
      filesystem: { read: [], write: [] },
    },
    updateChannel: "stable",
  };
}

export function recordArgsJsonFailure(
  ctx: MeshSpawnContext,
  serviceId: string,
  reason: string,
): void {
  if (ctx.logger !== undefined) {
    ctx.logger.warn(
      { serviceId, reason },
      "user MCP args_json failed to parse — slot left unconfigured",
    );
  }
  if (ctx.healthDb !== undefined) {
    transitionHealth(ctx.healthDb, serviceId, {
      type: "persistent_error",
      error: `malformed args_json (${reason})`,
    });
  }
}

function mcpServerKeyForUserConnector(serviceId: string): string {
  return serviceId.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
}

export async function ensureUserMcpClient(
  ctx: MeshSpawnContext,
  row: UserMcpConnectorRow,
): Promise<void> {
  const meshKey = userMcpMeshKey(row.service_id);
  ctx.clearLazyIdle(meshKey);
  if (ctx.getLazyClient(meshKey) !== undefined) {
    ctx.scheduleLazyDisconnect(meshKey);
    return;
  }
  let args: string[];
  try {
    const parsed: unknown = JSON.parse(row.args_json);
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
      recordArgsJsonFailure(ctx, row.service_id, "expected string array");
      return;
    }
    args = parsed;
  } catch {
    recordArgsJsonFailure(ctx, row.service_id, "JSON parse failed");
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
        userMcpDefaultManifest(row.service_id),
        ctx.sandboxCwd,
      ),
    },
  });
  ctx.setLazyClient(meshKey, client);
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(meshKey);
}
