import type { MCPClient } from "@mastra/mcp";

import { CONNECTOR_SERVICE_IDS } from "../connector-catalog.ts";

export function mergeToolMapsOrThrow(
  sources: ReadonlyArray<{ map: LazyMeshToolMap; name: string }>,
): LazyMeshToolMap {
  const merged: LazyMeshToolMap = {};
  const owners: Record<string, string> = {};
  for (const { map, name } of sources) {
    for (const [key, value] of Object.entries(map)) {
      if (key in merged) {
        throw new Error(
          `MCP tool-name collision: ${key} provided by both ${owners[key]} and ${name}`,
        );
      }
      merged[key] = value;
      owners[key] = name;
    }
  }
  return merged;
}

export type LazyMeshToolMap = Record<
  string,
  { execute?: (input: unknown, context?: unknown) => Promise<unknown> }
>;

export async function listLazyMeshClientTools(
  client: MCPClient | undefined,
): Promise<LazyMeshToolMap> {
  if (client === undefined) {
    return {};
  }
  return (await client.listTools()) as LazyMeshToolMap;
}

// Service ids longest-first so a multi-underscore id (e.g. "google_drive") is matched before a
// shorter prefix ("google_*" tools must not be mis-attributed). A tool key belongs to service `s`
// when it equals `s` or starts with `s_` (the mesh names each MCP server by its service id, and
// the MCP client prefixes every tool with `<serverKey>_`).
const SERVICE_IDS_BY_LENGTH_DESC: readonly string[] = [...CONNECTOR_SERVICE_IDS].sort(
  (a, b) => b.length - a.length,
);

/**
 * The connector service id that owns a dispatcher tool key, or undefined if none matches. The ONE
 * ownership rule for `<server>_<tool>` keys: the mesh's org-policy filter (I22) attributes a key to
 * a connector with it, and {@link resolveServerTool} will only hand a bare id a key it attributes to
 * the caller's own server, so the two can never disagree about whose tool a key is.
 */
export function serviceIdForToolKey(toolKey: string): string | undefined {
  for (const id of SERVICE_IDS_BY_LENGTH_DESC) {
    if (toolKey === id || toolKey.startsWith(`${id}_`)) return id;
  }
  return undefined;
}

/**
 * The key `@mastra/mcp`'s `MCPClient.listTools()` files a server's tool under: `<server>_<tool>`.
 * Both halves are used verbatim — `listToolsWithErrors` builds it as `` `${serverName}_${toolName}` ``
 * with no normalisation of either — and `serverName` is the key the server was given in
 * `new MCPClient({ servers })`, which every first-party spawner sets to the connector's service id.
 * A server name may itself contain `_` (`github_actions`), so a key cannot be split back into its
 * two halves; that is why the ownership check in {@link resolveServerTool} exists.
 */
export function mcpClientToolKey(serverName: string, toolName: string): string {
  return `${serverName}_${toolName}`;
}

/**
 * Find the tool a caller names by `toolId` in a map keyed the way `MCPClient.listTools()` keys it,
 * for a caller talking to the connector server `serverName`. The gateway names a connector tool by
 * its own MCP name (`snowflake_list`, `github_pr_list`), but a real session lists it as
 * `snowflake_snowflake_list`, so a verbatim lookup found nothing outside a test fake.
 *
 * 1. The exact key, as before: a caller already holding a `<server>_<tool>` key, or a map keyed by
 *    bare ids (a test fake, an e2e sink), is answered verbatim.
 * 2. Otherwise `<serverName>_<toolId>`, the bare tool on the caller's OWN server, and only when
 *    {@link serviceIdForToolKey} attributes that key to `serverName`. One server name can extend
 *    another — the github spawner registers `github` and `github_actions` in one client — so
 *    `github_` + `actions_gha_run_trigger` spells github_actions' `gha_run_trigger`; the ownership
 *    check refuses that rather than hand a bare id another server's tool. It also confines this
 *    step to first-party connector servers, the only names the rule knows.
 *
 * Step 2 makes no new TOOL reachable: every key it can return could already be named exactly. It
 * lets the bare id name it, and only ever a tool whose MCP name IS `toolId`, so a check made on
 * `toolId` before the lookup (the I26 write predicate at the federated invoke gate) is a check on
 * the tool that runs. Stated bound: a first-party tool whose own name began with a longer sibling
 * server's suffix (`github` registering `actions_x`) would be filed under the same key as that
 * sibling's tool by MCPClient itself; no connector does, and the integration test pins the real
 * key sets.
 */
export function resolveServerTool<T>(
  tools: Readonly<Record<string, T>>,
  serverName: string,
  toolId: string,
): T | undefined {
  const exact = ownEntry(tools, toolId);
  if (exact !== undefined) return exact;
  const key = mcpClientToolKey(serverName, toolId);
  if (serviceIdForToolKey(key) !== serverName) return undefined;
  return ownEntry(tools, key);
}

/** `tools[key]` for an OWN key only — a prototype member (`constructor`, `toString`) is no tool. */
function ownEntry<T>(tools: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(tools, key) ? tools[key] : undefined;
}
