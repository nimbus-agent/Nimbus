import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionManifestForSolver, RegistryFetcher } from "./dependency-types.ts";
import { parseExtensionManifestJson } from "./manifest.ts";

export interface RegistryFetcherDeps {
  installed: ReadonlyMap<string, string>;
  extensionDir(id: string): string;
  remoteListVersions(id: string): Promise<readonly string[]>;
  remoteFetchManifest(id: string, version: string): Promise<ExtensionManifestForSolver>;
}

export function createRegistryFetcher(deps: RegistryFetcherDeps): RegistryFetcher {
  return {
    async listVersions(id) {
      const installed = deps.installed.get(id);
      if (installed !== undefined) return [installed];
      return deps.remoteListVersions(id);
    },
    async fetchManifest(id, version) {
      const installed = deps.installed.get(id);
      if (installed === version) {
        const manifestPath = join(deps.extensionDir(id), "nimbus.extension.json");
        const raw = await readFile(manifestPath, "utf8");
        const parsed = parseExtensionManifestJson(raw);
        return {
          id: parsed.id,
          version: parsed.version,
          ...(parsed.dependsOn !== undefined ? { dependsOn: parsed.dependsOn } : {}),
        };
      }
      return deps.remoteFetchManifest(id, version);
    },
  };
}
