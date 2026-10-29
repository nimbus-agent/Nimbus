import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import {
  type DependencySpec,
  publisherKeyFingerprint,
  RegistryError,
} from "@nimbus-dev/registry-format";
import {
  listExtensions,
  selectExtensionInstallPath,
  setExtensionKind,
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
  type DependencyEdgeWrite,
  type PerformUpgradeDeps,
  type UpgradeDependencies,
} from "./auto-update-orchestrate.ts";
import type { AvailableUpdate, UpdatePlan } from "./auto-update-types.ts";
import {
  type ConnectorRequirementInput,
  type ConnectorRequirementStatus,
  connectorRequirementStatuses,
} from "./connector-requirements.ts";
import { recordInstall } from "./dependency-store.ts";
import {
  installedManifestKind,
  parseExtensionManifestJson,
  resolveExtensionManifestPath,
} from "./manifest.ts";
import { rangesOf } from "./manifest-support.ts";
import { extractPackage } from "./package-extract.ts";
import { writePublisherKeyFor } from "./publisher-keys.ts";
import { currentSourceRegistry, sourceRegistryOf } from "./registry/builtin-registry.ts";
import {
  type InstallFromRegistryDeps,
  installUpdateDependencies,
  planUpdate,
} from "./registry/install-from-registry.ts";
import {
  FETCH_FAILURE_CODES,
  fetchRegistryBytes,
  fetchVerifiedIndex,
  type RegistryFetchDeps,
} from "./registry/registry-fetch.ts";
import {
  fetchRegistryManifest,
  verifyRegistryManifestSignature,
  verifySignedManifest,
} from "./registry/registry-manifest.ts";
import { collectRegistryUpdates } from "./registry/registry-update-source.ts";
import { getRunGrant } from "./run-grant-store.ts";
import { publisherKeyConflict, publisherKeyDecision } from "./trust/publisher-key-decision.ts";
import { assertNotBlocked, TrustBlockError } from "./trust/trust-blocks.ts";
import { type VerifiedPublisher, verifiedPublisherFor } from "./trust/verified-publisher.ts";
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
export function withUpdateAppliedHook<Rest extends unknown[]>(
  perform: (update: AvailableUpdate, ...rest: Rest) => Promise<void>,
  onApplied: ((extensionId: string) => void) | undefined,
): (update: AvailableUpdate, ...rest: Rest) => Promise<void> {
  if (onApplied === undefined) return perform;
  return async (update, ...rest) => {
    await perform(update, ...rest);
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
  /** Plans a forward update for its approval (`registry/install-from-registry.ts` `planUpdate`, I44). */
  planUpdate: (cached: AvailableUpdate) => Promise<UpdatePlan>;
  /** The connectors an update newly requires, with their status; absent ⇒ none shown. */
  updateRequirements?: (
    cached: AvailableUpdate,
    plan: UpdatePlan,
  ) => Promise<readonly ConnectorRequirementStatus[] | undefined>;
  /**
   * The approval passes the plan it listed (`auto-update-rpc.ts` always does); a direct caller
   * (a test) may omit it.
   */
  performUpgrade: (cached: AvailableUpdate, plan?: UpdatePlan) => Promise<void>;
  performDowngrade: (cached: AvailableUpdate) => Promise<void>;
  appendAudit: (type: string, payload: Record<string, unknown>) => Promise<void>;
  getInstalledVersion: (id: string) => Promise<string | null>;
  hasPrevVersion: (id: string, version: string) => Promise<boolean>;
  /** Optional for test bags; the production bag (below) always answers from the run-grant store. */
  hasRunGrant?: (id: string) => Promise<boolean>;
  /** Whether the update's source registry still exists under the detected root fingerprint. */
  isSourceCurrent?: (cached: AvailableUpdate) => Promise<boolean>;
  /** The verified publisher (R6) of an update's key, asked at read time; never cached. */
  verifiedPublisherOf?: (cached: AvailableUpdate) => VerifiedPublisher | null;
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
        ...(r.publisher_key_fingerprint != null && { keyFingerprint: r.publisher_key_fingerprint }),
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
          ...(manifest.dependsOn !== undefined && {
            dependsOn: rangesOf(manifest.dependsOn),
          }),
          ...(manifest.requires !== undefined && {
            requires: { connectors: [...manifest.requires.connectors] },
          }),
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

/**
 * The key an update's manifest verified with at apply time, recorded once the swap succeeds, and
 * the dependencies that RE-VERIFIED manifest declares (what the apply checks the approved plan against).
 */
type VerifiedUpdateKey = {
  publisherId: string;
  key: Uint8Array;
  dependsOn: Readonly<Record<string, DependencySpec>> | undefined;
};

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
  const installedRow = listInstalledRows(fetchDeps.db).find((r) => r.id === update.id);
  const installedPublisher = installedRow?.manifest.publisher?.id;
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
    if (entry.publisher.id !== installedPublisher) {
      throw new RegistryError(
        "ERR_REGISTRY_PUBLISHER_KEY_CONFLICT",
        `the index names publisher "${entry.publisher.id}", not the installed one, for ${update.id}`,
      );
    }
    const decision = await publisherKeyDecision(
      { db: fetchDeps.db, vault },
      {
        publisherId: entry.publisher.id,
        key: entry.publisher.key,
        source: { registry: reg.name, rootFingerprint: reg.rootFingerprint },
        installedFingerprint: installedRow?.keyFingerprint ?? null,
        ...(update.acceptedPublisherKey === undefined
          ? {}
          : { acceptFingerprint: update.acceptedPublisherKey }),
      },
    );
    if (!decision.ok) throw publisherKeyConflict(entry.publisher.id, decision);
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
    return {
      publisherId: entry.publisher.id,
      key: fetched.publisherKey,
      dependsOn: fetched.manifest.dependsOn,
    };
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

/**
 * The connectors an update newly requires (the root's added requirements, and each added package's
 * from its VERIFIED manifest), with their status. The added packages are pending installs, so a
 * connector one of them will own is never shown as connected. Undefined when it cannot be computed.
 */
async function updateRequirementStatuses(
  opts: AutoUpdateInitOpts,
  update: AvailableUpdate,
  plan: UpdatePlan,
): Promise<ConnectorRequirementStatus[] | undefined> {
  const added = plan.addedPackages.flatMap((a) => {
    const verified = plan.resolver.verified(a.id, a.version);
    return verified === undefined ? [] : [verified];
  });
  const required: ConnectorRequirementInput[] = [
    ...(update.addedRequirements === undefined || update.addedRequirements.length === 0
      ? []
      : [{ extensionId: update.id, connectors: update.addedRequirements }]),
    ...added.flatMap((v) =>
      v.manifest.requires === undefined
        ? []
        : [{ extensionId: v.manifest.id, connectors: v.manifest.requires.connectors }],
    ),
  ];
  try {
    return await connectorRequirementStatuses(
      {
        db: opts.db,
        vault: opts.vault,
        pendingInstalls: added.map((v) => ({
          manifest: v.manifest,
          sourceRootFingerprint: v.reg.rootFingerprint,
        })),
      },
      required,
    );
  } catch {
    return undefined;
  }
}

const byFirst = (
  [a]: readonly [string, ...unknown[]],
  [b]: readonly [string, ...unknown[]],
): number => (a < b ? -1 : Number(a > b));

/** A `dependsOn` map in one canonical form (sorted ids, every spec field explicit), for comparison. */
function canonicalDependsOn(
  dependsOn: Readonly<Record<string, DependencySpec>> | undefined,
): string {
  return JSON.stringify(
    Object.entries(dependsOn ?? {})
      .map(
        ([id, spec]) =>
          [id, spec.range, spec.registry ?? null, spec.rootKeyFingerprint ?? null] as const,
      )
      .sort(byFirst),
  );
}

/**
 * Refused unless the manifest re-verified at apply declares exactly the dependencies the approved
 * plan was solved from (the cached specs the gate planned, and the plan root's own edges), so the
 * owner never approves one dependency set and gets another. Returns the root's new edges.
 */
function assertPlanMatchesManifest(
  update: AvailableUpdate,
  plan: UpdatePlan,
  declared: Readonly<Record<string, DependencySpec>> | undefined,
): DependencyEdgeWrite {
  const root = plan.plan.nodes.find((n) => n.id === update.id && n.version === update.toVersion);
  const planned = JSON.stringify(
    (root?.deps ?? []).map((d) => [d.id, d.range] as const).sort(byFirst),
  );
  const manifest = JSON.stringify(Object.entries(rangesOf(declared)).sort(byFirst));
  if (
    root === undefined ||
    canonicalDependsOn(declared) !== canonicalDependsOn(update.dependsOn) ||
    planned !== manifest
  ) {
    throw new Error(
      `update_conflicts: the dependencies ${update.id}@${update.toVersion} declares are not the ones the approved plan was solved from`,
    );
  }
  return { id: root.id, version: root.version, deps: root.deps };
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

  // One definition for the upgrade AND downgrade paths — it is the same row write either way. It
  // runs after the swap, so the manifest now installed says whether the row is a starter pack
  // (an update may turn an extension into a pack, or the reverse).
  // The edges, when given, are written in the SAME transaction: the row and its dependency graph
  // commit together or not at all.
  const dbUpdateExtensionRow: PerformUpgradeDeps["dbUpdateExtensionRow"] = (
    id,
    version,
    manifestHash,
    entryHash,
    treeDigest,
    edges,
  ) =>
    Promise.try(() => {
      const installPath = selectExtensionInstallPath(opts.db, id);
      const kind = installPath === null ? null : installedManifestKind(installPath);
      const now = Date.now();
      opts.db.transaction(() => {
        updateExtensionRowVersion(opts.db, id, version, manifestHash, entryHash, now, treeDigest);
        if (kind !== null) setExtensionKind(opts.db, id, kind);
        for (const edge of edges ?? [])
          recordInstall(opts.db, edge.id, edge.version, edge.deps, now);
      })();
    });

  // The plan's registry deps (detection and the approval). Planning installs nothing and asks
  // nobody, so the approver is never consulted.
  const planDeps: InstallFromRegistryDeps = {
    db: opts.db,
    extensionsDir: opts.extensionsDir,
    vault: opts.vault,
    fetch: opts.fetch,
    approve: () => Promise.resolve(false),
  };

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
    // Detection solves each update's dependencies through its registries (I44); nothing is
    // installed or asked here, so the approver is never consulted.
    planUpdate: (update, newManifest, context) =>
      planUpdate(planDeps, update, newManifest, context),
    appendAudit: wrapAudit,
    intervalHours: opts.intervalHours,
    now: () => Date.now(),
    random: () => Math.random(),
  });

  const noopStop = async (_id: string): Promise<void> => {};
  const verifiedKeys = new Map<string, VerifiedUpdateKey>();

  /**
   * The apply's dependency step: an update applied without an approved plan may declare no
   * dependency; with one, the re-verified manifest must declare what the plan was solved from, and
   * exactly the approved packages are installed (`installUpdateDependencies`, I44). The edges are
   * the root's NEW full set and each added package's own.
   */
  const installApprovedDependencies = async (
    update: AvailableUpdate,
    plan: UpdatePlan | undefined,
    reverified: VerifiedUpdateKey | undefined,
    signal: AbortSignal,
  ): Promise<UpgradeDependencies> => {
    if (reverified === undefined) {
      throw new Error(
        `signature_failed: ${updateKey(update)} was not re-verified before its apply`,
      );
    }
    if (plan === undefined) {
      if (Object.keys(reverified.dependsOn ?? {}).length > 0) {
        throw new Error(
          `update_conflicts: ${updateKey(update)} declares dependencies but no approved plan was given`,
        );
      }
      return {
        edges: [{ id: update.id, version: update.toVersion, deps: [] }],
        rollback: () => [],
      };
    }
    const rootEdges = assertPlanMatchesManifest(update, plan, reverified.dependsOn);
    // Always, even when the approval listed nothing: it also refuses a plan that would install a
    // package the approval did not list, and re-checks the root's dependents.
    const added = await installUpdateDependencies(planDeps, update, plan, signal);
    const installed = new Set(added.installed.map((p) => `${p.id}@${p.version}`));
    return {
      edges: [
        rootEdges,
        ...plan.plan.nodes
          .filter((n) => installed.has(`${n.id}@${n.version}`))
          .map((n) => ({ id: n.id, version: n.version, deps: n.deps })),
      ],
      rollback: () => added.rollback(),
    };
  };

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
    installDependencies: (update, plan, signal) =>
      installApprovedDependencies(update, plan, verifiedKeys.get(updateKey(update)), signal),
    dbUpdateExtensionRow,
  };

  const upgrade = createPerformUpgrade(performUpgradeDeps);
  const downgrade = createPerformDowngrade({
    extensionsRoot: opts.extensionsDir,
    stopExtensionClient: opts.stopExtensionClient ?? noopStop,
    dbUpdateExtensionRow,
  });
  // `plan` is the plan the owner approved; the apply installs exactly its added packages.
  const performUpgrade = withUpdateAppliedHook(
    async (update: AvailableUpdate, plan?: UpdatePlan) => {
      await upgrade(update, plan);
      // The new code may be signed by a rotated key: keep that key under its fingerprint and record
      // it on the row, so the boot pass and every spawn verify with it (I16).
      const verified = verifiedKeys.get(updateKey(update));
      verifiedKeys.delete(updateKey(update));
      if (verified !== undefined) await recordVerifyingKey(opts, update.id, verified);
    },
    opts.onUpdateApplied,
  );
  const performDowngrade = withUpdateAppliedHook(async (update) => {
    await downgrade(update);
    // The restored copy is signed by the key it was installed with: its declared one.
    recordDeclaredFingerprint(opts.db, update.id);
  }, opts.onUpdateApplied);

  const deps: AutoUpdateRuntimeBag = {
    cache,
    forcePoll: () => daemon.pollOnce(),
    // The approval re-plans from the new version's declared dependencies, through its registries
    // (I44), with a fresh read of the source index.
    planUpdate: (cached) =>
      planUpdate(
        planDeps,
        cached,
        {
          id: cached.id,
          version: cached.toVersion,
          ...(cached.dependsOn === undefined ? {} : { dependsOn: cached.dependsOn }),
        },
        { signal: abortController.signal },
      ),
    updateRequirements: (cached, plan) => updateRequirementStatuses(opts, cached, plan),
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
    // R6, asked at read time with the detector's own subject (the source registry, I44).
    verifiedPublisherOf: (cached) =>
      verifiedPublisherFor(opts.db, {
        publisherId: cached.publisherId ?? null,
        keyFingerprint: cached.publisherKeyFingerprint ?? null,
        source: { registry: cached.sourceRegistry, rootFingerprint: cached.rootFingerprint },
      }),
  };

  return { daemon, deps, abortController };
}

export { verifyTarballSha256 } from "./auto-update-apply.ts";
