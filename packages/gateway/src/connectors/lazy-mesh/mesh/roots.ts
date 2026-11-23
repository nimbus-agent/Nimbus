import type { PlatformPaths } from "../../../platform/paths.ts";

/**
 * Nimbus's own data, config and sandbox root — the set no user MCP (and, plus the extensions dir, no
 * extension run grant) may overlap. A function of the paths alone, so `platform/assemble.ts` can
 * build the extension runtime's grant env BEFORE the mesh it hands that runtime to exists.
 */
export function userMcpProtectedRootsFor(
  paths: Pick<PlatformPaths, "dataDir" | "configDir" | "sandboxDir">,
): readonly string[] {
  return [paths.dataDir, paths.configDir, paths.sandboxDir];
}
