import pino from "pino";

import { serviceOf } from "../engine/service-of.ts";
import type { ConnectorDispatcher, PlannedAction } from "../engine/types.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { createLazyConnectorMesh, type LazyConnectorMesh } from "./lazy-mesh/index.ts";
import { mcpClientToolKey, resolveServerTool } from "./lazy-mesh/tool-map.ts";
import { isUserMcpToolKey, userMcpToolKeyForActionType } from "./user-mcp-store.ts";

const registryLog = pino({
  name: "connector-registry",
  level: process.env["NIMBUS_LOG_LEVEL"] ?? "info",
});

export { createLazyConnectorMesh, LazyConnectorMesh } from "./lazy-mesh/index.ts";

/**
 * Filesystem MCP (always) + lazy Google bundle (Drive, Gmail, Photos) when any Google OAuth vault key exists +
 * audit-ignore-next-line D11-vault-key (JSDoc reference, not vault-key construction)
 * lazy Microsoft bundle (OneDrive, Outlook, Teams) when `microsoft.oauth` exists.
 */
export async function buildConnectorMesh(
  paths: PlatformPaths,
  vault: NimbusVault,
): Promise<LazyConnectorMesh> {
  return createLazyConnectorMesh(paths, vault);
}

export type McpToolListingClient = {
  listTools(): Promise<
    Record<
      string,
      {
        execute?: (input: unknown, context?: unknown) => Promise<unknown>;
      }
    >
  >;
  getToolsEpoch?: () => number;
  /**
   * The tools of ONE registered user MCP server (`undefined` when no such server is registered).
   * When present, a user-MCP action (`mcp_<id>.<tool>`) is resolved against this listing ALONE, so
   * running one user tool never lists — and so never spawns — every connector in the mesh.
   */
  listUserMcpTools?: (
    serviceId: string,
  ) => Promise<
    | Record<string, { execute?: (input: unknown, context?: unknown) => Promise<unknown> }>
    | undefined
  >;
};

type DispatcherToolMap = Record<
  string,
  { execute?: (a: unknown, b?: unknown) => Promise<unknown> }
>;

/**
 * The dispatcher client every production mesh dispatcher uses: the whole merged map for a
 * first-party action, the action's OWN server for a user-MCP one.
 */
export function meshDispatcherClient(mesh: {
  listToolsForDispatcher(): Promise<DispatcherToolMap>;
  getToolsEpoch(): number;
  listUserMcpToolsForDispatcher(serviceId: string): Promise<DispatcherToolMap | undefined>;
}): McpToolListingClient {
  return {
    listTools: () => mesh.listToolsForDispatcher(),
    getToolsEpoch: () => mesh.getToolsEpoch(),
    listUserMcpTools: (serviceId) => mesh.listUserMcpToolsForDispatcher(serviceId),
  };
}

export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export const MAX_TOOL_RESULT_BYTES = 4 * 1024 * 1024;

export function createConnectorDispatcher(
  client: McpToolListingClient,
  options?: { toolTimeoutMs?: number; maxResultBytes?: number },
): ConnectorDispatcher {
  const toolTimeoutMs = options?.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const maxResultBytes = options?.maxResultBytes ?? MAX_TOOL_RESULT_BYTES;
  let toolsPromise: ReturnType<McpToolListingClient["listTools"]> | undefined;
  let cachedEpoch = -1;

  async function tools(): Promise<DispatcherToolMap> {
    const epoch = client.getToolsEpoch?.() ?? 0;
    if (toolsPromise === undefined || epoch !== cachedEpoch) {
      cachedEpoch = epoch;
      toolsPromise = client.listTools();
    }
    return toolsPromise;
  }

  /**
   * A user-MCP action lists its OWN server only, when the client offers that listing. The I42
   * pairing is checked on the INPUT first: the per-server map holds only `<serviceId>_*` keys, so a
   * smuggled key from another server would otherwise surface as "Tool not found" instead of the
   * mismatch refusal the whole-mesh listing gave. The post-resolution check below still runs.
   */
  async function toolsFor(action: PlannedAction, toolId: string): Promise<DispatcherToolMap> {
    const expected = userMcpToolKeyForActionType(action.type);
    const listOne = client.listUserMcpTools;
    if (expected === undefined || listOne === undefined) {
      return tools();
    }
    const serviceId = serviceOf(action.type);
    if (toolId !== expected && mcpClientToolKey(serviceId, toolId) !== expected) {
      assertUserMcpKeyMatchesActionType(action.type, toolId);
    }
    return (await listOne(serviceId)) ?? {};
  }

  return {
    async dispatch(action: PlannedAction): Promise<unknown> {
      const fromPayload = action.payload?.["mcpToolId"];
      const toolId =
        typeof fromPayload === "string" && fromPayload.length > 0 ? fromPayload : action.type;
      const map = await toolsFor(action, toolId);
      // The mesh lists every tool as `<server>_<tool>`, so a bare id (the tribal KB capture's
      // `mcpToolId`) is resolved on the server of the action type the HITL gate approved (I3:
      // the gate consults action.type), never on another connector's server. An exact mesh key
      // is answered as it always was.
      const tool = resolveServerTool(map, serviceOf(action.type), toolId);
      if (tool === undefined) {
        const available = Object.keys(map).sort((a, b) => a.localeCompare(b));
        registryLog.warn(
          { toolId, availableToolCount: available.length, availableTools: available },
          "Unknown MCP tool",
        );
        throw new Error("Tool not found");
      }
      assertUserMcpKeyMatchesActionType(
        action.type,
        Object.hasOwn(map, toolId) ? toolId : mcpClientToolKey(serviceOf(action.type), toolId),
      );
      const execute = tool.execute;
      if (execute === undefined) {
        throw new Error(`MCP tool "${toolId}" has no execute implementation`);
      }
      const input = extractToolInput(action);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        execute(input, {}),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Tool ${toolId} exceeded ${toolTimeoutMs}ms timeout`));
          }, toolTimeoutMs);
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });

      const serialized = JSON.stringify(result);
      if (serialized !== undefined && serialized.length > maxResultBytes) {
        throw new Error(
          `Tool ${toolId} result size ${serialized.length} bytes exceeds cap ${maxResultBytes}`,
        );
      }
      return result;
    },
  };
}

/**
 * I42 at the dispatcher: a user-registered MCP server’s tool runs only under its OWN action type
 * (`mcp_<id>.<tool>` <-> key `mcp_<id>_<tool>`), and a user-MCP action type runs only that key.
 * The executor gate decides owner approval from `action.type` alone (I3) and never reads the
 * payload, so without this a payload `mcpToolId` naming a user-MCP key could ride an action of any
 * other type — one a delegate approved (I20), or one needing no approval — past I42. The check
 * stays HERE, on the key the dispatcher actually resolved, so the gate keeps reading the type only.
 * Exact equality refuses a user-MCP key under a first-party or different action type, and a
 * first-party key under a user-MCP type, in both directions. It does NOT by itself separate
 * `mcp_a.b_tool` from server `mcp_a_b`’s `tool` (both map to key `mcp_a_b_tool`); that ambiguity
 * cannot arise because registration (`resolveUserMcpRegistration`,
 * `connectors/user-mcp-registration.ts`) refuses a user-MCP id that extends another registered id
 * by `_` (or is extended by one), so `mcp_a` and `mcp_a_b` are never both registered.
 */
function assertUserMcpKeyMatchesActionType(actionType: string, resolvedKey: string): void {
  const expected = userMcpToolKeyForActionType(actionType);
  if (expected === undefined && !isUserMcpToolKey(resolvedKey)) return;
  if (expected === resolvedKey) return;
  throw new Error(
    `ERR_USER_MCP_ACTION_MISMATCH: action type ${JSON.stringify(actionType)} may not dispatch tool ${JSON.stringify(resolvedKey)}`,
  );
}

export function extractToolInput(action: PlannedAction): unknown {
  const p = action.payload;
  if (p === undefined) {
    return {};
  }
  if (Object.hasOwn(p, "input")) {
    return p["input"];
  }
  const rest: Record<string, unknown> = { ...p };
  delete rest["mcpToolId"];
  return rest;
}
