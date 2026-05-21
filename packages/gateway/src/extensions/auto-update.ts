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
  /**
   * Raw on-disk JSON manifest bytes as received from the registry. Daemon
   * uses this — NOT `manifest` — for `verifyManifestSignature` because the
   * canonical signature bytes are over the on-disk JSON, not the parsed +
   * defaulted shape (e.g. `updateChannel` defaults to "stable" in the parsed
   * shape but is absent from pre-PR-3 signed manifests).
   */
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
  /** 0..1; jittered startup poll delay is 30s + random*270s. */
  random: () => number;
  /**
   * Optional remote fetcher used to resolve dep manifests during conflict
   * detection. When undefined, the daemon SKIPS conflict checking (the
   * AvailableUpdate.conflicts stays unset).
   *
   * v1: list-of-versions side reuses `fetchLatestVersion` (latest-only).
   */
  solverRemoteFetchManifest?: (
    id: string,
    version: string,
  ) => Promise<{ id: string; version: string; dependsOn?: Readonly<Record<string, string>> }>;
}

/**
 * Background daemon (in-Gateway-process) that polls the registry for
 * extension updates every `intervalHours`, with a 30–300 s startup
 * jitter. Air-gap-aware: when `enforceAirGap` is true, `start()` is a
 * no-op.
 *
 * Per-extension flow (see design spec §3):
 * 1. Skip if disabled or unsigned (no publisher).
 * 2. `fetchLatestVersion` against the manifest's `updateChannel`.
 * 3. Skip if the latest equals the installed version.
 * 4. `fetchManifest`, look up the publisher key, verify signature.
 *    - key missing → cache as `needs_sync`.
 *    - verify throws → cache as `signature_failed`.
 *    - verify resolves → cache as `verified`.
 * 5. `diffPermissions`; upsert into `AutoUpdateCache`.
 * 6. On first detection per `(id, toVersion)`: write
 *    `extension.autoUpdate.detected` audit row.
 */
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
    if (this.opts.enforceAirGap) return; // air-gap kill switch
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

  /**
   * Single poll pass across all enabled, signed extensions. Per-extension
   * failures are swallowed so one broken row does not halt the rest.
   */
  async pollOnce(): Promise<void> {
    const installed = await this.opts.listInstalled();
    for (const row of installed) {
      if (row.enabled !== 1) continue;
      if (row.manifest.publisher === undefined) continue; // unsigned — not auto-updateable
      try {
        await this.pollOne(row, installed);
      } catch {
        // Per-extension failure does not stop the loop.
      }
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

    // Publisher key check
    const publisherId = newManifest.publisher?.id;
    if (publisherId === undefined) return; // new manifest must also be signed
    const pubkey = await this.opts.lookupPublisherKey(publisherId);

    let verificationStatus: VerificationStatus;
    let publisherStatus: "verified" | "unverified" = "unverified";

    if (pubkey === null) {
      verificationStatus = "needs_sync";
    } else {
      try {
        // Verify against the RAW on-disk JSON, not the parsed slice — the
        // canonical signature bytes are over what the publisher actually
        // signed (no defaulted updateChannel, etc.).
        await this.opts.verifyManifestSignature(manifestResult.manifestRaw, pubkey);
        verificationStatus = "verified";
        publisherStatus = "verified";
      } catch {
        verificationStatus = "signature_failed";
      }
    }

    const permissionDiff = diffPermissions(row.manifest.permissions, newManifest.permissions);

    // --- Dependency conflict detection (spec §6) ---
    // Only runs when solverRemoteFetchManifest is provided; skipped silently otherwise.
    let conflicts: readonly DependencyConflict[] | undefined;
    if (this.opts.solverRemoteFetchManifest !== undefined) {
      try {
        // Build the post-bump world: installed map + active constraints from all rows.
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
        // Apply the proposed bump so the solver evaluates the post-bump world.
        installedMap.set(row.id, toVersion);
        if (newManifest.dependsOn !== undefined && Object.keys(newManifest.dependsOn).length > 0) {
          activeConstraints.set(row.id, new Map(Object.entries(newManifest.dependsOn)));
        } else {
          activeConstraints.delete(row.id);
        }

        const solverRemoteFetchManifest = this.opts.solverRemoteFetchManifest;
        const fetchLatestVersion = this.opts.fetchLatestVersion;
        const abortSignal = this.abort.signal;

        const fetcher: RegistryFetcher = {
          listVersions: async (id: string): Promise<readonly string[]> => {
            const installedVersion = installedMap.get(id);
            if (installedVersion !== undefined) return [installedVersion];
            const latest = await fetchLatestVersion(id, "stable", abortSignal);
            return latest === null ? [] : [latest.version];
          },
          fetchManifest: async (
            id: string,
            version: string,
          ): Promise<ExtensionManifestForSolver> => {
            // For the bump under consideration, use what we already fetched.
            if (id === row.id && version === toVersion) {
              return {
                id: row.id,
                version: toVersion,
                ...(newManifest.dependsOn !== undefined
                  ? { dependsOn: newManifest.dependsOn }
                  : {}),
              };
            }
            // For installed ids at their installed version, prefer the on-disk manifest.
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
                    ...(parsed.dependsOn !== undefined ? { dependsOn: parsed.dependsOn } : {}),
                  };
                } catch {
                  // Fall through to remote fetch.
                }
              }
            }
            return await solverRemoteFetchManifest(id, version);
          },
        };

        // Pre-check: ensure the bumped version satisfies all range constraints that
        // other installed extensions contribute for this id (these constraints live in
        // activeConstraints but resolveClosure only checks them when visiting the id
        // as a *dependency* — not when the id is the root). Without this check, a
        // reverse-dep incompatibility on the root itself is silently missed.
        const constraintsOnRoot: Array<{ from: string; range: string }> = [];
        for (const [dependent, depMap] of activeConstraints) {
          if (dependent === row.id) continue; // skip the bump itself
          const range = depMap.get(row.id);
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
            id: row.id,
            constraints: unsatisfiedConstraints,
            availableVersions: [toVersion],
          });
        }

        const proposedManifest: ExtensionManifestForSolver = {
          id: row.id,
          version: toVersion,
          ...(newManifest.dependsOn !== undefined ? { dependsOn: newManifest.dependsOn } : {}),
        };

        await resolveClosure(proposedManifest, fetcher, {
          installed: installedMap,
          activeConstraints,
        });
        // No conflict thrown → conflicts stays undefined.
      } catch (e) {
        if (isDependencyConflictError(e)) {
          conflicts = [e.conflict];
        }
        // OfflineDependencyResolutionError or other network/IO errors:
        // leave conflicts undefined so the bump is still surfaced without conflict info.
      }
    }

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
