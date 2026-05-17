import { randomUUID } from "node:crypto";

import { MCPClient } from "@mastra/mcp";

import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import { transitionHealth } from "../health.ts";
import type { UserMcpConnectorRow } from "../user-mcp-store.ts";
import { userMcpMeshKey } from "./keys.ts";
import type { MeshSpawnContext } from "./slot.ts";
import { wrapServerSpec } from "./wrap-server-spec.ts";

/**
 * Default-deny manifest applied to every user-installed MCP at spawn
 * time (T2 PR 1, `I15`).
 *
 * **PR 1 posture (intentional):** user-MCP manifests are NOT loaded
 * from disk here. PR 1 ships every user MCP under a hard-coded
 * default-deny envelope — zero network, zero filesystem outside cwd —
 * which is the safest baseline and avoids broadening PR 1's scope to
 * include `nimbus.extension.json` disk loading for user MCPs.
 *
 * **Why this is safe at PR 1:** Task 15 lands the pre-T2 hard-disable
 * path — user MCPs installed before T2 (without a `permissions.*`
 * object in their manifest) are refused at registry-load time. New
 * user MCPs installed post-T2 must carry an object-form `permissions`
 * envelope (the manifest validator rejects unknown keys). Either way,
 * by the time a user MCP reaches this spawn site, the registry has
 * already validated it. PR 1's default-deny here is conservative — a
 * follow-up will plumb the registry-stored manifest into the spawn
 * context so users can actually exercise their declared network /
 * filesystem permissions.
 *
 * **TODO (Task 15 + post-PR 1 follow-up):** thread the registry-stored
 * manifest into `MeshSpawnContext` (probably as `ctx.lookupUserManifest`)
 * and replace `USER_MCP_DEFAULT_MANIFEST` with that lookup.
 */
function userMcpDefaultManifest(serviceId: string): ExtensionManifest {
  return {
    id: `user.${serviceId}`,
    version: "0.0.0",
    permissions: {
      network: [],
      filesystem: { read: [], write: [] },
    },
  };
}

/**
 * S8-F9 — central failure handler for malformed user_mcp_connector.args_json.
 * Logs a warn line (when a logger was supplied) and transitions connector
 * health to `persistent_error` (when a healthDb was supplied) so the
 * failure is observable via `nimbus connector status` instead of silently
 * leaving the slot unconfigured.
 */
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
      // S8-F9 — surface the failure instead of silently leaving the slot
      // unconfigured. Health transition makes it visible in
      // `nimbus connector status`.
      recordArgsJsonFailure(ctx, row.service_id, "expected string array");
      return;
    }
    args = parsed;
  } catch {
    recordArgsJsonFailure(ctx, row.service_id, "JSON parse failed");
    return;
  }
  const key = mcpServerKeyForUserConnector(row.service_id);
  // I15 (T2 PR 1) — user MCPs are sandboxed under a hard-coded
  // default-deny manifest. See `userMcpDefaultManifest` docblock for
  // why we don't load the registry-stored manifest at PR 1; Task 15 +
  // a follow-up will plumb that through.
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
