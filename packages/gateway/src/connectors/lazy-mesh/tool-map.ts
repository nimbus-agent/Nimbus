import type { MCPClient } from "@mastra/mcp";

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
