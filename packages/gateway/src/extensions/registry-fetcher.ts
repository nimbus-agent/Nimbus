import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionManifestForSolver, RegistryFetcher } from "./dependency-types.ts";
import { parseExtensionManifestJson } from "./manifest.ts";

export interface RegistryFetcherDeps {
  /** Map from installed extension id → on-disk version. */
  installed: ReadonlyMap<string, string>;
  /** Resolves the on-disk path of an installed extension's `active/` directory. */
  extensionDir(id: string): string;
  /** Network calls — the existing PR 3 registry client. */
  remoteListVersions(id: string): Promise<readonly string[]>;
  remoteFetchManifest(id: string, version: string): Promise<ExtensionManifestForSolver>;
}

/**
 * Local-first RegistryFetcher (spec §2.1, §2.3). An installed id resolves from on-disk
 * state without a network call; only unknown ids hit the remote registry.
 *
 * Review-fix #3: the on-disk read goes through `parseExtensionManifestJson` (the
 * canonical manifest parser). PR 2's startup signature-verify already catches
 * post-install tampering, but layering a lightweight schema check here closes
 * the window between two signature-verify passes — disk corruption or manual
 * tampering between Gateway starts produces a clear parse error instead of
 * feeding garbage to the solver.
 */
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
        // Validate through the canonical schema — throws on tampering / corruption.
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
