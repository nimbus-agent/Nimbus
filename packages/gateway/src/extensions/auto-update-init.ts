import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as tar from "tar";

import { listExtensions, updateExtensionRowVersion } from "../automation/extension-store.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import type { NimbusVault } from "../vault/index.ts";
import { ExtensionAutoUpdater, type InstalledExtensionRow } from "./auto-update.ts";
import { verifyTarballSha256 } from "./auto-update-apply.ts";
import { AutoUpdateCache } from "./auto-update-cache.ts";
import {
  createPerformDowngrade,
  createPerformUpgrade,
  type PerformUpgradeDeps,
} from "./auto-update-orchestrate.ts";
import type { AvailableUpdate } from "./auto-update-types.ts";
import { parseExtensionManifestJson, resolveExtensionManifestPath } from "./manifest.ts";
import { readPublisherKey } from "./publisher-keys.ts";
import { createRegistryClient, type RegistryClient } from "./registry-client.ts";
import { verifyManifestSignature } from "./verify-signature.ts";

/**
 * Build the live `ExtensionAutoUpdater` daemon + its `AutoUpdateRpcDeps`
 * dependency bag for the IPC dispatcher. Returns `null` when auto-update is
 * not configured for this Gateway (no registry URL, or air-gap enforced).
 *
 * The two outputs are intentionally separate:
 *
 * - `daemon` — owns the polling loop; `start()` is called by the caller (the
 *   assemble wiring) once the rest of the Gateway is online; `stop()` is
 *   registered in `sidecarStops` so the shutdown path tears it down cleanly.
 * - `deps` — the slice the IPC dispatcher injects per-request into
 *   `dispatchAutoUpdateRpc`. The `gate` field is filled per-client by the
 *   dispatcher (Per-request `ToolExecutor` instance), NOT here.
 */
export interface AutoUpdateInitOpts {
  db: Database;
  vault: NimbusVault;
  extensionsDir: string;
  dataDir: string;
  registryBaseUrl: string;
  intervalHours: number;
  enforceAirGap: boolean;
  /** mesh handle for client teardown after a successful swap; optional. */
  stopExtensionClient?: (extensionId: string) => Promise<void>;
}

export interface AutoUpdateRuntimeBag {
  cache: AutoUpdateCache;
  forcePoll: () => Promise<void>;
  performUpgrade: (cached: AvailableUpdate) => Promise<void>;
  performDowngrade: (cached: AvailableUpdate) => Promise<void>;
  appendAudit: (type: string, payload: Record<string, unknown>) => Promise<void>;
  getInstalledVersion: (id: string) => Promise<string | null>;
  hasPrevVersion: (id: string, version: string) => Promise<boolean>;
}

export interface AutoUpdateRuntime {
  daemon: ExtensionAutoUpdater;
  deps: AutoUpdateRuntimeBag;
  /** AbortController for in-flight orchestration (download / extract). */
  abortController: AbortController;
}

async function listInstalledRows(db: Database): Promise<InstalledExtensionRow[]> {
  const rows = listExtensions(db);
  const out: InstalledExtensionRow[] = [];
  for (const r of rows) {
    const mp = resolveExtensionManifestPath(r.install_path);
    if (mp === undefined) continue;
    try {
      const manifest = parseExtensionManifestJson(readFileSync(mp, "utf8"));
      out.push({
        id: r.id,
        version: r.version,
        install_path: r.install_path,
        enabled: r.enabled,
        manifest: {
          id: manifest.id,
          version: manifest.version,
          ...(manifest.name !== undefined && { name: manifest.name }),
          updateChannel: manifest.updateChannel,
          ...(manifest.publisher !== undefined && { publisher: manifest.publisher }),
          ...(manifest.signature !== undefined && { signature: manifest.signature }),
          permissions: {
            network: [...manifest.permissions.network],
            filesystem: {
              read: [...manifest.permissions.filesystem.read],
              write: [...manifest.permissions.filesystem.write],
            },
          },
        },
      });
    } catch {
      // Malformed manifest — skip silently; the hash-verify sweep will surface it.
    }
  }
  return out;
}

async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  // Re-uses the same hex+case posture as `verifyTarballSha256`, but returns
  // the hex string (the orchestrator does its own compare).
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function extractTarballToDir(bytes: Uint8Array, destDir: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(destDir, { recursive: true });
  // mkdtemp creates the staging dir with O_EXCL + 0o700 semantics, so the
  // tarball never lands at a predictable path in the shared OS temp dir.
  const tmpDir = await mkdtemp(join(tmpdir(), "nimbus-au-"));
  const tmpFile = join(tmpDir, "src.tar");
  try {
    await writeFile(tmpFile, bytes);
    await tar.x({ cwd: destDir, file: tmpFile });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export function createAutoUpdateRuntime(opts: AutoUpdateInitOpts): AutoUpdateRuntime {
  const cache = new AutoUpdateCache();
  const registry: RegistryClient = createRegistryClient({ baseUrl: opts.registryBaseUrl });
  const abortController = new AbortController();

  const wrapAudit = async (type: string, payload: Record<string, unknown>): Promise<void> => {
    try {
      appendAuditEntry(opts.db, {
        actionType: type,
        hitlStatus: "not_required",
        actionJson: JSON.stringify(payload),
        timestamp: Date.now(),
      });
    } catch {
      // Best-effort — the BLAKE3 chain may be locked or full; do not fault
      // the daemon over an audit-write failure.
    }
  };

  const daemon = new ExtensionAutoUpdater({
    cache,
    listInstalled: () => listInstalledRows(opts.db),
    fetchLatestVersion: (id, channel, signal) => registry.fetchLatestVersion(id, channel, signal),
    fetchManifest: async (id, version, signal) => {
      const r = await registry.fetchManifest(id, version, signal);
      const m = r.manifest;
      const sig = m.signature ?? "";
      return {
        manifestHash: r.manifestHash,
        entryHash: r.entryHash,
        tarballUrl: r.tarballUrl,
        manifestRaw: r.manifestRaw,
        ...(r.tarballSizeBytes !== undefined ? { tarballSizeBytes: r.tarballSizeBytes } : {}),
        manifest: {
          id: m.id,
          version: m.version,
          ...(m.name !== undefined && { name: m.name }),
          updateChannel: m.updateChannel,
          ...(m.publisher !== undefined && { publisher: m.publisher }),
          signature: sig,
          ...(m.changelog !== undefined && { changelog: m.changelog }),
          permissions: {
            network: [...m.permissions.network],
            filesystem: {
              read: [...m.permissions.filesystem.read],
              write: [...m.permissions.filesystem.write],
            },
          },
        },
      };
    },
    verifyManifestSignature: (manifest, pubkey) =>
      verifyManifestSignature(manifest as Parameters<typeof verifyManifestSignature>[0], pubkey),
    lookupPublisherKey: async (publisherId) => {
      const k = await readPublisherKey(opts.vault, publisherId);
      return k ?? null;
    },
    appendAudit: wrapAudit,
    intervalHours: opts.intervalHours,
    enforceAirGap: opts.enforceAirGap,
    now: () => Date.now(),
    random: () => Math.random(),
  });

  const noopStop = async (_id: string): Promise<void> => {};

  const performUpgradeDeps: PerformUpgradeDeps = {
    extensionsRoot: opts.extensionsDir,
    dataDir: opts.dataDir,
    fetcher: globalThis.fetch.bind(globalThis),
    signal: abortController.signal,
    sha256OfTarball: sha256OfBytes,
    extractTarball: extractTarballToDir,
    stopExtensionClient: opts.stopExtensionClient ?? noopStop,
    dbUpdateExtensionRow: async (id, version, manifestHash, entryHash) => {
      updateExtensionRowVersion(opts.db, id, version, manifestHash, entryHash, Date.now());
    },
  };

  const performUpgrade = createPerformUpgrade(performUpgradeDeps);
  const performDowngrade = createPerformDowngrade({
    extensionsRoot: opts.extensionsDir,
    stopExtensionClient: opts.stopExtensionClient ?? noopStop,
    dbUpdateExtensionRow: async (id, version, manifestHash, entryHash) => {
      updateExtensionRowVersion(opts.db, id, version, manifestHash, entryHash, Date.now());
    },
  });

  const deps: AutoUpdateRuntimeBag = {
    cache,
    forcePoll: () => daemon.pollOnce(),
    performUpgrade,
    performDowngrade,
    appendAudit: wrapAudit,
    getInstalledVersion: async (id) => {
      const row = listExtensions(opts.db).find((r) => r.id === id);
      return row?.version ?? null;
    },
    hasPrevVersion: async (id, version) => {
      const row = listExtensions(opts.db).find((r) => r.id === id);
      if (!row) return false;
      const prevPath = join(dirname(row.install_path), "_prev", version);
      return existsSync(prevPath);
    },
  };

  return { daemon, deps, abortController };
}

/**
 * Re-export for tests that need to round-trip the SHA-256 verification helper
 * without re-importing.
 */
export { verifyTarballSha256 };
