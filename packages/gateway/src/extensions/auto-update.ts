import { readFile } from "node:fs/promises";
import { join } from "node:path";

import semver from "semver";

import type { AutoUpdateCache } from "./auto-update-cache.ts";
import { diffPermissions } from "./auto-update-permissions-diff.ts";
import type { AvailableUpdate, UpdateChannel, VerificationStatus } from "./auto-update-types.ts";
import { DependencyConflictError, isDependencyConflictError } from "./dependency-errors.ts";
import { resolveClosure } from "./dependency-graph.ts";
import type {
  DependencyConflict,
  ExtensionManifestForSolver,
  RegistryFetcher,
} from "./dependency-types.ts";
import { parseExtensionManifestJson } from "./manifest.ts";

interface InstalledExtensionManifestSlice {
  id: string;
  version: string;
  name?: string;
  updateChannel: UpdateChannel;
  publisher?: { id: string; key: string };
  signature?: string;
  permissions: {
    network: string[];
    filesystem: { read: string[]; write: string[] };
  };
  dependsOn?: Readonly<Record<string, string>>;
}

export interface InstalledExtensionRow {
  id: string;
  version: string;
  install_path: string;
  enabled: number;
  manifest: InstalledExtensionManifestSlice;
}

export interface FetchLatestVersionResult {
  version: string;
  channel: UpdateChannel;
}

export interface FetchManifestResult {
  manifest: InstalledExtensionManifestSlice & { signature: string; changelog?: string };
  manifestRaw: Record<string, unknown>;
  manifestHash: string;
  entryHash: string;
  tarballUrl: string;
  tarballSizeBytes?: number;
}

export interface ExtensionAutoUpdaterOpts {
  cache: AutoUpdateCache;
  listInstalled: () => Promise<InstalledExtensionRow[]>;
  fetchLatestVersion: (
    id: string,
    channel: UpdateChannel,
    signal: AbortSignal,
  ) => Promise<FetchLatestVersionResult | null>;
  fetchManifest: (id: string, version: string, signal: AbortSignal) => Promise<FetchManifestResult>;
  verifyManifestSignature: (manifest: object, pubkey: Uint8Array) => Promise<void>;
  lookupPublisherKey: (publisherId: string) => Promise<Uint8Array | null>;
  appendAudit: (type: string, payload: Record<string, unknown>) => Promise<void>;
  intervalHours: number;
  enforceAirGap: boolean;
  now: () => number;
  random: () => number;
  solverRemoteFetchManifest?: (
    id: string,
    version: string,
  ) => Promise<{ id: string; version: string; dependsOn?: Readonly<Record<string, string>> }>;
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

  async start(): Promise<void> {
    if (this.opts.enforceAirGap) return;
    if (this.running) return;
    this.running = true;

    const jitterMs = 30_000 + Math.floor(this.opts.random() * 270_000);
    this.startupTimer = setTimeout(() => {
      this.pollOnce().catch(() => {});
    }, jitterMs);

    const periodMs = this.opts.intervalHours * 3600_000;
    this.periodicTimer = setInterval(() => {
      this.pollOnce().catch(() => {});
    }, periodMs);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.abort.abort();
  }

  async pollOnce(): Promise<void> {
    const installed = await this.opts.listInstalled();
    for (const row of installed) {
      if (row.enabled !== 1) continue;
      if (row.manifest.publisher === undefined) continue;
      try {
        await this.pollOne(row, installed);
      } catch {
        // Per-extension failure does not stop the loop.
      }
    }
  }

  private computeVerificationStatus(
    pubkey: Uint8Array | null,
    manifestRaw: Record<string, unknown>,
  ): Promise<{
    verificationStatus: VerificationStatus;
    publisherStatus: "verified" | "unverified";
  }> {
    if (pubkey === null) {
      return Promise.resolve({ verificationStatus: "needs_sync", publisherStatus: "unverified" });
    }
    return this.opts
      .verifyManifestSignature(manifestRaw, pubkey)
      .then(() => ({ verificationStatus: "verified", publisherStatus: "verified" }) as const)
      .catch(
        () => ({ verificationStatus: "signature_failed", publisherStatus: "unverified" }) as const,
      );
  }

  private async computeUpdateConflicts(
    row: InstalledExtensionRow,
    installed: readonly InstalledExtensionRow[],
    newManifest: InstalledExtensionManifestSlice,
    toVersion: string,
  ): Promise<readonly DependencyConflict[] | undefined> {
    const solverRemoteFetchManifest = this.opts.solverRemoteFetchManifest;
    if (solverRemoteFetchManifest === undefined) return undefined;
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
      installedMap.set(row.id, toVersion);
      if (newManifest.dependsOn !== undefined && Object.keys(newManifest.dependsOn).length > 0) {
        activeConstraints.set(row.id, new Map(Object.entries(newManifest.dependsOn)));
      } else {
        activeConstraints.delete(row.id);
      }

      const fetchLatestVersion = this.opts.fetchLatestVersion;
      const abortSignal = this.abort.signal;

      const fetcher: RegistryFetcher = {
        listVersions: async (id: string): Promise<readonly string[]> => {
          const installedVersion = installedMap.get(id);
          if (installedVersion !== undefined) return [installedVersion];
          const latest = await fetchLatestVersion(id, "stable", abortSignal);
          return latest === null ? [] : [latest.version];
        },
        fetchManifest: async (id: string, version: string): Promise<ExtensionManifestForSolver> => {
          if (id === row.id && version === toVersion) {
            return {
              id: row.id,
              version: toVersion,
              ...(newManifest.dependsOn === undefined ? {} : { dependsOn: newManifest.dependsOn }),
            };
          }
          const installedVersion = installedMap.get(id);
          if (installedVersion === version) {
            const dir = dirById.get(id);
            if (dir !== undefined) {
              try {
                const raw = await readFile(join(dir, "nimbus.extension.json"), "utf8");
                const parsed = parseExtensionManifestJson(raw);
                return {
                  id: parsed.id,
                  version: parsed.version,
                  ...(parsed.dependsOn === undefined ? {} : { dependsOn: parsed.dependsOn }),
                };
              } catch {
                // Fall through to remote fetch.
              }
            }
          }
          return await solverRemoteFetchManifest(id, version);
        },
      };

      assertRootConstraintsSatisfied(row.id, toVersion, activeConstraints);

      const proposedManifest: ExtensionManifestForSolver = {
        id: row.id,
        version: toVersion,
        ...(newManifest.dependsOn === undefined ? {} : { dependsOn: newManifest.dependsOn }),
      };

      await resolveClosure(proposedManifest, fetcher, {
        installed: installedMap,
        activeConstraints,
      });
      return undefined;
    } catch (e) {
      if (isDependencyConflictError(e)) {
        return [e.conflict];
      }
      // OfflineDependencyResolutionError or other network/IO errors:
      // leave conflicts undefined so the bump is still surfaced without conflict info.
      return undefined;
    }
  }

  private async pollOne(
    row: InstalledExtensionRow,
    installed: readonly InstalledExtensionRow[],
  ): Promise<void> {
    const channel = row.manifest.updateChannel;
    const latest = await this.opts.fetchLatestVersion(row.id, channel, this.abort.signal);
    if (latest === null) return;
    if (latest.version === row.version) return;

    const manifestResult = await this.opts.fetchManifest(row.id, latest.version, this.abort.signal);
    const newManifest = manifestResult.manifest;
    const fromVersion = row.version;
    const toVersion = newManifest.version;

    const publisherId = newManifest.publisher?.id;
    if (publisherId === undefined) return;
    const pubkey = await this.opts.lookupPublisherKey(publisherId);

    const { verificationStatus, publisherStatus } = await this.computeVerificationStatus(
      pubkey,
      manifestResult.manifestRaw,
    );

    const permissionDiff = diffPermissions(row.manifest.permissions, newManifest.permissions);

    const conflicts = await this.computeUpdateConflicts(row, installed, newManifest, toVersion);

    const update: AvailableUpdate = {
      id: row.id,
      displayName: newManifest.name ?? row.id,
      fromVersion,
      toVersion,
      channel: newManifest.updateChannel,
      changelog: newManifest.changelog ?? "",
      publisherStatus,
      manifestHash: manifestResult.manifestHash,
      signatureB64: newManifest.signature,
      entryHash: manifestResult.entryHash,
      tarballUrl: manifestResult.tarballUrl,
      ...(manifestResult.tarballSizeBytes !== undefined
        ? { tarballSizeBytes: manifestResult.tarballSizeBytes }
        : {}),
      permissionDiff,
      verificationStatus,
      detectedAt: this.opts.now(),
      ...(conflicts !== undefined && conflicts.length > 0 ? { conflicts } : {}),
    };

    const isNew = this.opts.cache.isNewDetection(update);
    this.opts.cache.upsert(update);

    if (isNew) {
      await this.opts.appendAudit("extension.autoUpdate.detected", {
        id: row.id,
        fromVersion,
        toVersion,
        channel: newManifest.updateChannel,
        verification_status: verificationStatus,
      });
    }
  }
}
