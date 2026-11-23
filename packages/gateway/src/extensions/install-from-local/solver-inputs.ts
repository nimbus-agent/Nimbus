import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { listExtensions } from "../../automation/extension-store.ts";
import {
  type ExtensionManifestForSolver,
  type InstalledForSolver,
  type RegistryFetcher,
  sourceKey,
} from "../dependency-types.ts";
import { parseExtensionManifestJson, resolveExtensionManifestPath } from "../manifest.ts";
import { rangesOf } from "../manifest-support.ts";
import type { InstallFromLocalOptions } from "./types.ts";

/**
 * The solver's view of what is installed: each row's version and recorded source, and each
 * readable installed manifest's ranges as an active constraint.
 */
export function buildSolverInputs(db: Database): {
  installed: ReadonlyMap<string, InstalledForSolver>;
  activeConstraints: ReadonlyMap<string, ReadonlyMap<string, string>>;
} {
  const rows = listExtensions(db);
  const installed = new Map<string, InstalledForSolver>();
  const activeConstraints = new Map<string, ReadonlyMap<string, string>>();
  for (const row of rows) {
    installed.set(row.id, {
      version: row.version,
      source:
        row.source_registry && row.source_root_fingerprint
          ? sourceKey(row.source_registry, row.source_root_fingerprint)
          : null,
    });
    const manifestPath = resolveExtensionManifestPath(row.install_path);
    if (manifestPath === undefined) continue;
    try {
      const raw = readFileSync(manifestPath, "utf8");
      const mf = parseExtensionManifestJson(raw);
      const ranges = rangesOf(mf.dependsOn);
      if (Object.keys(ranges).length > 0) {
        activeConstraints.set(row.id, new Map(Object.entries(ranges)));
      }
    } catch {
      // Unreadable / malformed manifest — skip. The signature-verify startup
      // pass (I16) is the authoritative check; here we just skip gracefully.
    }
  }
  return { installed, activeConstraints };
}

/**
 * The solver's view of what exists: ONLY what is already installed. Nothing is fetched, so a
 * dependency that is not installed is unsatisfiable and the install refuses (spec § 8.6 step 8;
 * transitive fetching is a later project). `targetSource` is always null, so a dependency — an
 * object one naming a registry included — is satisfied by any installed copy.
 */
export function buildLocalSolverFetcher(
  db: Database,
  installedMap: ReadonlyMap<string, InstalledForSolver>,
): RegistryFetcher {
  return {
    targetSource: () => null,
    listVersions(id: string): Promise<readonly string[]> {
      const pinned = installedMap.get(id);
      return Promise.resolve(pinned === undefined ? [] : [pinned.version]);
    },
    fetchManifest(id: string, version: string): Promise<ExtensionManifestForSolver> {
      return Promise.try(() => {
        const extRow =
          installedMap.get(id)?.version === version
            ? listExtensions(db).find((r) => r.id === id)
            : undefined;
        const mfPath =
          extRow === undefined ? undefined : resolveExtensionManifestPath(extRow.install_path);
        if (mfPath === undefined) {
          throw new Error(`dependency ${id}@${version} is not installed`);
        }
        const mf = parseExtensionManifestJson(readFileSync(mfPath, "utf8"));
        return {
          id: mf.id,
          version: mf.version,
          ...(mf.dependsOn === undefined ? {} : { dependsOn: mf.dependsOn }),
        };
      });
    },
  };
}

/** The source key of the root package: its registry plan's, else its recorded registry, else none. */
export function rootSourceOf(options: InstallFromLocalOptions): string | null {
  if (options.registryPlan !== undefined) return options.registryPlan.resolver.rootSource;
  if (options.sourceRegistry !== undefined && options.rootFingerprint !== undefined) {
    return sourceKey(options.sourceRegistry, options.rootFingerprint);
  }
  return null;
}
