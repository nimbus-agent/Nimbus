import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import {
  publisherKeyFingerprint,
  RegistryError,
  type RegistryErrorCode,
} from "@nimbus-dev/registry-format";
import {
  listExtensions,
  setExtensionPublisherKeyFingerprint,
  updateExtensionRowVersion,
} from "../automation/extension-store.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
import type { NimbusVault } from "../vault/index.ts";
import { ExtensionAutoUpdater, type InstalledExtensionRow } from "./auto-update.ts";
import { MAX_TARBALL_BYTES } from "./auto-update-apply.ts";
import { AutoUpdateCache } from "./auto-update-cache.ts";
import {
  createPerformDowngrade,
  createPerformUpgrade,
  type PerformUpgradeDeps,
} from "./auto-update-orchestrate.ts";
import type { AvailableUpdate } from "./auto-update-types.ts";
import { parseExtensionManifestJson, resolveExtensionManifestPath } from "./manifest.ts";
import { extractPackage } from "./package-extract.ts";
import { writePublisherKeyFor } from "./publisher-keys.ts";
import { builtinRegistryOf, resolveRegistry } from "./registry/builtin-registry.ts";
import {
  fetchRegistryBytes,
  fetchVerifiedIndex,
  type RegistryFetchDeps,
} from "./registry/registry-fetch.ts";
import {
  fetchRegistryManifest,
  vaultPublisherKeyConflicts,
  verifyRegistryManifestSignature,
  verifySignedManifest,
} from "./registry/registry-manifest.ts";
import type { RegistryRow } from "./registry/registry-store.ts";
import { collectRegistryUpdates } from "./registry/registry-update-source.ts";
import { getRunGrant } from "./run-grant-store.ts";
import { assertNotBlocked, TrustBlockError } from "./trust/trust-blocks.ts";
import { prevVersionDir } from "./version-store.ts";

export interface AutoUpdateInitOpts {
  db: Database;
  vault: NimbusVault;
  extensionsDir: string;
  dataDir: string;
  /**
   * The registry fetch deps `platform/assemble.ts` also hands the `registry.*` methods — the SAME
   * object, so the daemon, install, search and `registry add|refresh` obey ONE air-gap switch.
   */
  fetch: Omit<RegistryFetchDeps, "db">;
  intervalHours: number;
  stopExtensionClient?: (extensionId: string) => Promise<void>;
  /**
   * Called once an upgrade or downgrade has been APPLIED (row rewritten, client stopped). The
   * extension sync host refreshes here: the run grant now names the old version, so its sync is
   * unregistered and the index id paused with the re-approve reason. Never called on a failure.
   */
  onUpdateApplied?: (extensionId: string) => void;
  /**
   * Trust layer "fresh before acting" (spec § 6.2): refreshes the trust feed best-effort before an
   * update is re-verified for apply. Must not reject.
   */
  freshenTrust?: () => Promise<unknown>;
}

/**
 * `perform`, then `onApplied(update.id)` — only when `perform` resolved. A throwing hook is
 * swallowed: the update is committed by then, and reporting it as failed would be false.
 */
export function withUpdateAppliedHook(
  perform: (update: AvailableUpdate) => Promise<void>,
  onApplied: ((extensionId: string) => void) | undefined,
): (update: AvailableUpdate) => Promise<void> {
  if (onApplied === undefined) return perform;
  return async (update) => {
    await perform(update);
    try {
      onApplied(update.id);
    } catch {
      // The update stands; the stale grant still refuses every spawn (I43) until re-approval.
    }
  };
}

export interface AutoUpdateRuntimeBag {
  cache: AutoUpdateCache;
  forcePoll: () => Promise<void>;
  performUpgrade: (cached: AvailableUpdate) => Promise<void>;
  performDowngrade: (cached: AvailableUpdate) => Promise<void>;
  appendAudit: (type: string, payload: Record<string, unknown>) => Promise<void>;
  getInstalledVersion: (id: string) => Promise<string | null>;
  hasPrevVersion: (id: string, version: string) => Promise<boolean>;
  /** Optional for test bags; the production bag (below) always answers from the run-grant store. */
  hasRunGrant?: (id: string) => Promise<boolean>;
  /** Whether the update's source registry still exists under the detected root fingerprint. */
  isSourceCurrent?: (cached: AvailableUpdate) => Promise<boolean>;
}

export interface AutoUpdateRuntime {
  daemon: ExtensionAutoUpdater;
  deps: AutoUpdateRuntimeBag;
  abortController: AbortController;
}

function listInstalledRows(db: Database): InstalledExtensionRow[] {
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
        ...(r.source_registry != null &&
          r.source_root_fingerprint != null &&
          r.source_channel != null && {
            source: {
              registry: r.source_registry,
              rootFingerprint: r.source_root_fingerprint,
              channel: r.source_channel,
            },
          }),
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
          ...(manifest.dependsOn !== undefined && { dependsOn: manifest.dependsOn }),
        },
      });
    } catch {
      // Malformed manifest — skip silently; the hash-verify sweep will surface it.
    }
  }
  return out;
}

async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Registry errors that mean the bytes could not be FETCHED, as opposed to fetched and refused. */
const FETCH_FAILURE_CODES: ReadonlySet<RegistryErrorCode> = new Set<RegistryErrorCode>([
  "ERR_REGISTRY_UNREACHABLE",
  "ERR_REGISTRY_AIR_GAP",
  "ERR_REGISTRY_TRANSPORT_REFUSED",
  "ERR_REGISTRY_TOO_LARGE",
  "ERR_REGISTRY_NOT_FOUND",
]);

/**
 * The update's source registry, if it still exists under the root key the update was detected with.
 * The reserved name resolves to the built-in registry configured on `fetchDeps`.
 */
function currentSourceRegistry(
  fetchDeps: RegistryFetchDeps,
  update: AvailableUpdate,
): RegistryRow | undefined {
  const reg = resolveRegistry(fetchDeps.db, update.sourceRegistry, builtinRegistryOf(fetchDeps));
  return reg?.rootFingerprint === update.rootFingerprint ? reg : undefined;
}

/** As above, or throws `source_registry_changed: …` (its own audit phase, not a signature failure). */
function sourceRegistryOf(fetchDeps: RegistryFetchDeps, update: AvailableUpdate): RegistryRow {
  const reg = currentSourceRegistry(fetchDeps, update);
  if (reg === undefined) {
    throw new Error(
      `source_registry_changed: registry "${update.sourceRegistry}" was removed or re-pinned since the update was detected`,
    );
  }
  return reg;
}

/** The key an update's manifest verified with at apply time, recorded once the swap succeeds. */
type VerifiedUpdateKey = { publisherId: string; key: Uint8Array };

function updateFailurePhase(e: unknown): "trust_blocked" | "download_failed" | "signature_failed" {
  if (e instanceof TrustBlockError) return "trust_blocked";
  return e instanceof RegistryError && FETCH_FAILURE_CODES.has(e.code)
    ? "download_failed"
    : "signature_failed";
}

/**
 * Apply-time re-verification (spec § 8.8, § 8.6 steps 2–4): the CURRENT signed index must still list
 * exactly this manifest and package for `id@toVersion`, the manifest must match its signed hash and
 * the index's publisher, the Vault must not trust a different key for that publisher, and the I16
 * signature must verify with the index's key. A failure to REACH the registry throws
 * `download_failed: …`; every other failure throws `signature_failed: …` (the audit phase).
 */
async function reverifyUpdateManifest(
  fetchDeps: RegistryFetchDeps,
  vault: NimbusVault,
  update: AvailableUpdate,
  signal: AbortSignal,
): Promise<VerifiedUpdateKey> {
  // The publisher the INSTALLED copy declares: an index that now lists another publisher for this
  // id is a different trust root, whatever the Vault holds for the new one.
  const installedPublisher = listInstalledRows(fetchDeps.db).find((r) => r.id === update.id)
    ?.manifest.publisher?.id;
  const reg = sourceRegistryOf(fetchDeps, update);
  try {
    const index = await fetchVerifiedIndex(fetchDeps, reg, signal);
    const entry = index.extensions[update.id];
    const vEntry = entry?.versions[update.toVersion];
    if (
      entry === undefined ||
      vEntry === undefined ||
      !sha256HexEqualConstantTime(vEntry.manifestSha256, update.manifestHash) ||
      !sha256HexEqualConstantTime(vEntry.packageSha256, update.packageSha256) ||
      vEntry.package !== update.packagePath ||
      !sha256HexEqualConstantTime(vEntry.entryHash, update.entryHash)
    ) {
      throw new Error(`the index no longer lists this ${update.id}@${update.toVersion}`);
    }
    const fetched = await fetchRegistryManifest(
      fetchDeps,
      reg,
      entry,
      update.id,
      update.toVersion,
      vEntry,
      signal,
    );
    if (
      entry.publisher.id !== installedPublisher ||
      (await vaultPublisherKeyConflicts(vault, entry.publisher.id, fetched.publisherKey))
    ) {
      throw new RegistryError(
        "ERR_REGISTRY_PUBLISHER_KEY_CONFLICT",
        `the index names publisher "${entry.publisher.id}" with a key the Vault does not trust for ${update.id}`,
      );
    }
    await verifyRegistryManifestSignature(fetched, update.id, update.toVersion);
    // I48: a block that landed after detection (or since the last apply attempt) refuses here,
    // before anything is downloaded or swapped.
    assertNotBlocked(fetchDeps.db, {
      extensionId: update.id,
      version: update.toVersion,
      publisherId: entry.publisher.id,
      keyFingerprint: publisherKeyFingerprint(entry.publisher.key),
      source: { registry: reg.name, rootFingerprint: reg.rootFingerprint },
    });
    return { publisherId: entry.publisher.id, key: fetched.publisherKey };
  } catch (e) {
    throw new Error(`${updateFailurePhase(e)}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const updateKey = (u: AvailableUpdate): string => `${u.id}@${u.toVersion}`;

/** Stores an applied update's verifying key under its fingerprint and records it on the row. */
async function recordVerifyingKey(
  opts: AutoUpdateInitOpts,
  extensionId: string,
  verified: VerifiedUpdateKey,
): Promise<void> {
  const fingerprint = await writePublisherKeyFor(opts.vault, verified.publisherId, verified.key);
  if (readIndexedUserVersion(opts.db) >= 76) {
    setExtensionPublisherKeyFingerprint(opts.db, extensionId, fingerprint);
  }
}

/** After a downgrade: the row's fingerprint is the restored manifest's declared key's. */
function recordDeclaredFingerprint(db: Database, extensionId: string): void {
  if (readIndexedUserVersion(db) < 76) return;
  const row = listInstalledRows(db).find((r) => r.id === extensionId);
  const declared = row?.manifest.publisher?.key;
  setExtensionPublisherKeyFingerprint(
    db,
    extensionId,
    declared === undefined ? null : publisherKeyFingerprint(declared),
  );
}

export function createAutoUpdateRuntime(opts: AutoUpdateInitOpts): AutoUpdateRuntime {
  const cache = new AutoUpdateCache();
  const abortController = new AbortController();
  const fetchDeps: RegistryFetchDeps = { ...opts.fetch, db: opts.db };

  // The SQLite reads/writes below are synchronous, but the daemon and the IPC bag take
  // Promise-returning callbacks. A body that can throw is lifted with `Promise.try`, which keeps
  // that throw a REJECTION (what the former `async` wrappers produced); one that cannot throw
  // just returns `Promise.resolve`.
  const wrapAudit = (type: string, payload: Record<string, unknown>): Promise<void> => {
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
    return Promise.resolve();
  };

  // One definition for the upgrade AND downgrade paths — it is the same row write either way.
  const dbUpdateExtensionRow: PerformUpgradeDeps["dbUpdateExtensionRow"] = (
    id,
    version,
    manifestHash,
    entryHash,
    treeDigest,
  ) =>
    Promise.try(() => {
      updateExtensionRowVersion(
        opts.db,
        id,
        version,
        manifestHash,
        entryHash,
        Date.now(),
        treeDigest,
      );
    });

  const daemon = new ExtensionAutoUpdater({
    cache,
    listInstalled: () => Promise.try(() => listInstalledRows(opts.db)),
    collect: (rows, signal) =>
      collectRegistryUpdates(
        {
          db: opts.db,
          fetch: fetchDeps,
          vault: opts.vault,
          verifyManifestSignature: verifySignedManifest,
          now: () => Date.now(),
        },
        rows,
        signal,
      ),
    appendAudit: wrapAudit,
    intervalHours: opts.intervalHours,
    now: () => Date.now(),
    random: () => Math.random(),
  });

  const noopStop = async (_id: string): Promise<void> => {};
  const verifiedKeys = new Map<string, VerifiedUpdateKey>();

  const performUpgradeDeps: PerformUpgradeDeps = {
    extensionsRoot: opts.extensionsDir,
    signal: abortController.signal,
    reverifyManifest: async (update, signal) => {
      await opts.freshenTrust?.();
      verifiedKeys.set(
        updateKey(update),
        await reverifyUpdateManifest(fetchDeps, opts.vault, update, signal),
      );
    },
    fetchPackage: (update, signal) =>
      fetchRegistryBytes(
        fetchDeps,
        sourceRegistryOf(fetchDeps, update),
        update.packagePath,
        {
          method: "registry.package",
          extensionId: update.id,
          version: update.toVersion,
          maxBytes: MAX_TARBALL_BYTES,
        },
        signal,
      ),
    sha256OfPackage: sha256OfBytes,
    extractPackage,
    stopExtensionClient: opts.stopExtensionClient ?? noopStop,
    dbUpdateExtensionRow,
  };

  const upgrade = createPerformUpgrade(performUpgradeDeps);
  const downgrade = createPerformDowngrade({
    extensionsRoot: opts.extensionsDir,
    stopExtensionClient: opts.stopExtensionClient ?? noopStop,
    dbUpdateExtensionRow,
  });
  const performUpgrade = withUpdateAppliedHook(async (update) => {
    await upgrade(update);
    // The new code may be signed by a rotated key: keep that key under its fingerprint and record
    // it on the row, so the boot pass and every spawn verify with it (I16).
    const verified = verifiedKeys.get(updateKey(update));
    verifiedKeys.delete(updateKey(update));
    if (verified !== undefined) await recordVerifyingKey(opts, update.id, verified);
  }, opts.onUpdateApplied);
  const performDowngrade = withUpdateAppliedHook(async (update) => {
    await downgrade(update);
    // The restored copy is signed by the key it was installed with: its declared one.
    recordDeclaredFingerprint(opts.db, update.id);
  }, opts.onUpdateApplied);

  const deps: AutoUpdateRuntimeBag = {
    cache,
    forcePoll: () => daemon.pollOnce(),
    performUpgrade,
    performDowngrade,
    appendAudit: wrapAudit,
    getInstalledVersion: (id) =>
      Promise.try(() => {
        const row = listExtensions(opts.db).find((r) => r.id === id);
        return row?.version ?? null;
      }),
    hasPrevVersion: (id, version) =>
      Promise.try(() => {
        if (!listExtensions(opts.db).some((r) => r.id === id)) return false;
        return existsSync(prevVersionDir(opts.extensionsDir, id, version));
      }),
    hasRunGrant: (id) => Promise.try(() => getRunGrant(opts.db, id) !== null),
    isSourceCurrent: (cached) =>
      Promise.try(() => currentSourceRegistry(fetchDeps, cached) !== undefined),
  };

  return { daemon, deps, abortController };
}

export { verifyTarballSha256 } from "./auto-update-apply.ts";
