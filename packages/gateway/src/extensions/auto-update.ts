import type { AutoUpdateCache } from "./auto-update-cache.ts";
import { diffPermissions } from "./auto-update-permissions-diff.ts";
import type { AvailableUpdate, UpdateChannel, VerificationStatus } from "./auto-update-types.ts";

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
        await this.pollOne(row);
      } catch {
        // Per-extension failure does not stop the loop.
      }
    }
  }

  private async pollOne(row: InstalledExtensionRow): Promise<void> {
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
        await this.opts.verifyManifestSignature(newManifest, pubkey);
        verificationStatus = "verified";
        publisherStatus = "verified";
      } catch {
        verificationStatus = "signature_failed";
      }
    }

    const permissionDiff = diffPermissions(row.manifest.permissions, newManifest.permissions);

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
