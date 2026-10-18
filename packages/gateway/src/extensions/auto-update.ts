import { readFile } from "node:fs/promises";
import { join } from "node:path";

import semver from "semver";

import type { AutoUpdateCache } from "./auto-update-cache.ts";
import type { AvailableUpdate, InstalledExtensionManifestSlice } from "./auto-update-types.ts";
import { DependencyConflictError, isDependencyConflictError } from "./dependency-errors.ts";
import { resolveClosure } from "./dependency-graph.ts";
import type {
  DependencyConflict,
  ExtensionManifestForSolver,
  RegistryFetcher,
} from "./dependency-types.ts";
import { parseExtensionManifestJson } from "./manifest.ts";
import type { ExtensionSource } from "./registry/registry-store.ts";
import type {
  CollectedRegistryUpdates,
  InstalledRegistryRow,
} from "./registry/registry-update-source.ts";

export interface InstalledExtensionRow {
  id: string;
  version: string;
  install_path: string;
  enabled: number;
  /** The registry the extension was installed from; absent for a local-path install. */
  source?: ExtensionSource;
  manifest: InstalledExtensionManifestSlice;
}

export interface ExtensionAutoUpdaterOpts {
  cache: AutoUpdateCache;
  listInstalled: () => Promise<InstalledExtensionRow[]>;
  /**
   * Detects updates for registry-sourced extensions, each against its OWN source registry
   * (`registry/registry-update-source.ts`). The single air-gap switch lives in the registry fetch
   * deps this closes over and is read per request, so a local registry still answers under
   * air-gap while a remote one is refused.
   */
  collect: (rows: InstalledRegistryRow[], signal: AbortSignal) => Promise<CollectedRegistryUpdates>;
  appendAudit: (type: string, payload: Record<string, unknown>) => Promise<void>;
  intervalHours: number;
  now: () => number;
  random: () => number;
}

/** The rows a tick polls: enabled, signed, and installed from a registry. A local-path install never is. */
function registryRows(installed: readonly InstalledExtensionRow[]): InstalledRegistryRow[] {
  const out: InstalledRegistryRow[] = [];
  for (const r of installed) {
    if (r.enabled !== 1 || r.source === undefined || r.manifest.publisher === undefined) continue;
    out.push({
      id: r.id,
      version: r.version,
      enabled: r.enabled,
      source: r.source,
      publisherId: r.manifest.publisher.id,
      manifest: r.manifest,
    });
  }
  return out;
}

function assertRootConstraintsSatisfied(
  rootId: string,
  toVersion: string,
  activeConstraints: ReadonlyMap<string, Map<string, string>>,
): void {
  const constraintsOnRoot: Array<{ from: string; range: string }> = [];
  for (const [dependent, depMap] of activeConstraints) {
    if (dependent === rootId) continue;
    const range = depMap.get(rootId);
    if (range !== undefined) {
      constraintsOnRoot.push({ from: dependent, range });
    }
  }
  const unsatisfiedConstraints = constraintsOnRoot.filter(
    (c) => !semver.satisfies(toVersion, c.range),
  );
  if (unsatisfiedConstraints.length > 0) {
    throw new DependencyConflictError({
      kind: "unsatisfiable",
      id: rootId,
      constraints: unsatisfiedConstraints,
      availableVersions: [toVersion],
    });
  }
}

export class ExtensionAutoUpdater {
  private readonly abort = new AbortController();
  private running = false;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private periodicTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: ExtensionAutoUpdaterOpts) {}

  isRunning(): boolean {
    return this.running;
  }

  // `start`/`stop` only arm and clear timers — nothing suspends — but stay Promise-returning,
  // the shape the gateway (`void daemon.start()`) and the tests (`await`) consume.
  start(): Promise<void> {
    // `Promise.try` keeps a throw from the injected `random` a rejection, as `async` did.
    return Promise.try(() => {
      if (this.running) return;
      this.running = true;

      const jitterMs = 30_000 + Math.floor(this.opts.random() * 270_000);
      this.startupTimer = setTimeout(() => {
        this.pollOnce().catch(() => {});
      }, jitterMs);

      const periodMs = this.opts.intervalHours * 3_600_000;
      this.periodicTimer = setInterval(() => {
        this.pollOnce().catch(() => {});
      }, periodMs);
    });
  }

  stop(): Promise<void> {
    if (this.running) {
      this.running = false;
      if (this.startupTimer) clearTimeout(this.startupTimer);
      if (this.periodicTimer) clearInterval(this.periodicTimer);
      this.abort.abort();
    }
    return Promise.resolve();
  }

  /**
   * One tick: reads the CURRENT install table (so a registry added or removed at runtime is picked
   * up on the next tick) and asks `collect` for the updates. A registry that fails is skipped by
   * `collect` without blocking the others.
   */
  async pollOnce(): Promise<void> {
    const installed = await this.opts.listInstalled();
    const rows = registryRows(installed);
    if (rows.length === 0) return;
    const collected = await this.opts.collect(rows, this.abort.signal);
    for (const found of collected.updates) {
      const conflicts = await this.computeUpdateConflicts(
        found.id,
        found.toVersion,
        collected.dependsOn.get(found.id),
        installed,
      );
      const update: AvailableUpdate = {
        ...found,
        ...(conflicts !== undefined && conflicts.length > 0 ? { conflicts } : {}),
      };
      const isNew = this.opts.cache.isNewDetection(update);
      this.opts.cache.upsert(update);
      if (isNew) {
        await this.opts.appendAudit("extension.autoUpdate.detected", {
          id: update.id,
          fromVersion: update.fromVersion,
          toVersion: update.toVersion,
          channel: update.channel,
          source_registry: update.sourceRegistry,
          verification_status: update.verificationStatus,
        });
      }
    }
  }

  /**
   * Whether the bump fits the dependency graph of what is ALREADY installed. Nothing is fetched:
   * a dependency is satisfied only by an installed version (spec § 8.6 step 8), so a new dependency
   * that is not installed is reported as a conflict rather than resolved from a registry.
   */
  private async computeUpdateConflicts(
    id: string,
    toVersion: string,
    newDependsOn: Readonly<Record<string, string>> | undefined,
    installed: readonly InstalledExtensionRow[],
  ): Promise<readonly DependencyConflict[] | undefined> {
    try {
      const installedMap = new Map<string, string>();
      const activeConstraints = new Map<string, Map<string, string>>();
      const dirById = new Map<string, string>();
      for (const r of installed) {
        installedMap.set(r.id, r.version);
        dirById.set(r.id, r.install_path);
        if (r.manifest.dependsOn !== undefined && Object.keys(r.manifest.dependsOn).length > 0) {
          activeConstraints.set(r.id, new Map(Object.entries(r.manifest.dependsOn)));
        }
      }
      installedMap.set(id, toVersion);
      if (newDependsOn !== undefined && Object.keys(newDependsOn).length > 0) {
        activeConstraints.set(id, new Map(Object.entries(newDependsOn)));
      } else {
        activeConstraints.delete(id);
      }

      const proposedManifest: ExtensionManifestForSolver = {
        id,
        version: toVersion,
        ...(newDependsOn === undefined ? {} : { dependsOn: newDependsOn }),
      };
      const fetcher: RegistryFetcher = {
        listVersions: (depId: string): Promise<readonly string[]> => {
          const v = installedMap.get(depId);
          return Promise.resolve(v === undefined ? [] : [v]);
        },
        fetchManifest: async (depId: string, version: string) => {
          if (depId === id && version === toVersion) return proposedManifest;
          const dir = dirById.get(depId);
          if (dir === undefined || installedMap.get(depId) !== version) {
            throw new Error(`${depId}@${version} is not installed`);
          }
          const parsed = parseExtensionManifestJson(
            await readFile(join(dir, "nimbus.extension.json"), "utf8"),
          );
          return {
            id: parsed.id,
            version: parsed.version,
            ...(parsed.dependsOn === undefined ? {} : { dependsOn: parsed.dependsOn }),
          };
        },
      };

      assertRootConstraintsSatisfied(id, toVersion, activeConstraints);
      await resolveClosure(proposedManifest, fetcher, {
        installed: installedMap,
        activeConstraints,
      });
      return undefined;
    } catch (e) {
      if (isDependencyConflictError(e)) {
        return [e.conflict];
      }
      // An unreadable installed manifest (or similar IO): the bump is still surfaced, with no
      // conflict info.
      return undefined;
    }
  }
}
