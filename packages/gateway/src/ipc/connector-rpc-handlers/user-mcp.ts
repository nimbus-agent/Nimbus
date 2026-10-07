/**
 * `connector.userMcpTools` / `connector.userMcpCall` — list ONE owner-registered user MCP server's
 * tools, and call one of them. Both are CLI-only (LAN-forbidden in `ipc/lan-rpc.ts`, absent from
 * the Tauri allowlist).
 *
 * The call goes through a DISPATCHING `ToolExecutor` (built in `ipc/server/dispatchers.ts` for this
 * method only), never through the mesh directly: that executor's `gate()` is what writes the audit
 * row and the I29 egress row and, because the action type's service is `mcp_*`, asks the LOCAL
 * owner (I42). An unknown tool is refused HERE, before the executor is reached, so a typo never
 * raises a consent prompt for a tool that does not exist.
 */
import { z } from "zod";
import type { LazyConnectorMesh } from "../../connectors/lazy-mesh/index.ts";
import type { LazyMeshToolMap } from "../../connectors/lazy-mesh/tool-map.ts";
import { normalizeUserMcpServiceId } from "../../connectors/user-mcp-store.ts";
import type { ToolExecutor } from "../../engine/executor.ts";
import type { ActionResult } from "../../engine/types.ts";
import { ConnectorRpcError } from "../connector-rpc-shared.ts";

export interface UserMcpToolListing {
  name: string;
  description: string;
  inputSchema: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** A zod schema (v4 carries `_zod`; a v3 schema from another copy carries `_def`). */
function looksLikeZodSchema(v: unknown): v is z.ZodType {
  return typeof v === "object" && v !== null && ("_zod" in v || "_def" in v);
}

function renderInputSchema(schema: unknown): unknown {
  if (looksLikeZodSchema(schema)) {
    try {
      return z.toJSONSchema(schema);
    } catch {
      return null;
    }
  }
  return isPlainObject(schema) ? schema : null;
}

function requireMesh(mesh: LazyConnectorMesh | undefined, method: string): LazyConnectorMesh {
  if (mesh === undefined) {
    throw new ConnectorRpcError(-32603, `${method} requires the connector mesh`);
  }
  return mesh;
}

/** Resolves the id and lists ITS slot only; refuses an id with no `user_mcp_connector` row. */
async function listRegisteredTools(
  mesh: LazyConnectorMesh,
  rec: Record<string, unknown> | undefined,
): Promise<{ serviceId: string; tools: LazyMeshToolMap }> {
  const raw = typeof rec?.["serviceId"] === "string" ? rec["serviceId"] : "";
  const serviceId = normalizeUserMcpServiceId(raw);
  const tools = serviceId === null ? undefined : await mesh.listUserMcpTools(serviceId);
  if (serviceId === null || tools === undefined) {
    throw new ConnectorRpcError(
      -32602,
      `ERR_USER_MCP_NOT_REGISTERED: no user MCP server is registered as ${JSON.stringify(raw)}`,
    );
  }
  return { serviceId, tools };
}

export async function handleConnectorUserMcpTools(
  mesh: LazyConnectorMesh | undefined,
  rec: Record<string, unknown> | undefined,
): Promise<{ serviceId: string; tools: UserMcpToolListing[] }> {
  const { serviceId, tools } = await listRegisteredTools(
    requireMesh(mesh, "connector.userMcpTools"),
    rec,
  );
  const prefix = `${serviceId}_`;
  const listing: UserMcpToolListing[] = Object.entries(tools)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, tool]) => {
      const t: Record<string, unknown> = tool;
      return {
        name: key.slice(prefix.length),
        description: typeof t["description"] === "string" ? t["description"] : "",
        inputSchema: renderInputSchema(t["inputSchema"]),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { serviceId, tools: listing };
}

export async function handleConnectorUserMcpCall(
  mesh: LazyConnectorMesh | undefined,
  executor: ToolExecutor | undefined,
  rec: Record<string, unknown> | undefined,
): Promise<ActionResult> {
  const tool = rec?.["tool"];
  if (typeof tool !== "string" || tool === "") {
    throw new ConnectorRpcError(-32602, "connector.userMcpCall requires a non-empty tool name");
  }
  const rawInput = rec?.["input"] === undefined ? {} : rec["input"];
  if (!isPlainObject(rawInput)) {
    throw new ConnectorRpcError(-32602, "connector.userMcpCall input must be a JSON object");
  }
  const { serviceId, tools } = await listRegisteredTools(
    requireMesh(mesh, "connector.userMcpCall"),
    rec,
  );
  const mcpToolId = `${serviceId}_${tool}`;
  if (!Object.hasOwn(tools, mcpToolId)) {
    throw new ConnectorRpcError(
      -32602,
      `ERR_USER_MCP_UNKNOWN_TOOL: ${serviceId} has no tool ${JSON.stringify(tool)}`,
    );
  }
  if (executor === undefined) {
    throw new ConnectorRpcError(-32603, "connector.userMcpCall requires a userMcpExecutor");
  }
  return executor.execute({
    type: `${serviceId}.${tool}`,
    payload: { mcpToolId, input: rawInput },
  });
}
