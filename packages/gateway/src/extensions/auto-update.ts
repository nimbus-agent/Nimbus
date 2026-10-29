import { RegistryError } from "@nimbus-dev/registry-format";

import type { AutoUpdateCache } from "./auto-update-cache.ts";
import type {
  AvailableUpdate,
  InstalledExtensionManifestSlice,
  UpdateConflict,
  UpdatePlan,
  UpdatePlanContext,
} from "./auto-update-types.ts";
import {
  describeDependencyConflict,
  isDependencyConflictError,
  isOfflineDependencyResolutionError,
} from "./dependency-errors.ts";
import { type ExtensionManifestForSolver, sourceKey } from "./dependency-types.ts";
import type { ExtensionSource } from "./registry/registry-store.ts";
import type {
  CollectedRegistryUpdates,
  InstalledRegistryRow,
} from "./registry/registry-update-source.ts";
import { TrustBlockError } from "./trust/trust-blocks.ts";

export interface InstalledExtensionRow {
  id: string;
  version: string;
  install_path: string;
  enabled: number;
  /** The registry the extension was installed from; absent for a local-path install. */
  source?: ExtensionSource;
  /** The fingerprint of the key that verified the installed copy (V76); absent when unknown. */
  keyFingerprint?: string;
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
  /**
   * Solves an update's dependency closure through its registries (production:
   * `registry/install-from-registry.ts` `planUpdate`, I44). Throws on a conflict.
   */
  planUpdate: (
    update: AvailableUpdate,
    newManifest: ExtensionManifestForSolver,
    context: UpdatePlanContext,
  ) => Promise<UpdatePlan>;
  appendAudit: (type: string, payload: Record<string, unknown>) => Promise<void>;
  intervalHours: number;
  now: () => number;
  random: () => number;
  /** Told when recording one detection failed (e.g. its audit append); the tick carries on. */
  onTickError?: (extensionId: string, error: unknown) => void;
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
      ...(r.keyFingerprint === undefined ? {} : { keyFingerprint: r.keyFingerprint }),
      manifest: r.manifest,
    });
  }
  return out;
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
   * `collect` without blocking the others. After the tick, a cached update that was not re-reported
   * is dropped unless its registry ERRORED this tick: a removed or re-pinned registry (which
   * `collect` skips) or one that answered without that version no longer offers it (spec § 8.3),
   * while a transient failure does not make an offer flap.
   */
  async pollOnce(): Promise<void> {
    const installed = await this.opts.listInstalled();
    const rows = registryRows(installed);
    const collected: CollectedRegistryUpdates =
      rows.length === 0
        ? { updates: [], errors: [], dependsOn: new Map(), requires: new Map() }
        : await this.opts.collect(rows, this.abort.signal);
    for (const found of collected.updates) {
      try {
        await this.recordDetection(found, collected, installed); // NOSONAR S9382: each new detection appends to the audit chain in a deterministic order
      } catch (e) {
        // One failed audit append must not stop the rest of the tick from being cached.
        this.opts.onTickError?.(found.id, e);
      }
    }
    this.dropStaleOffers(collected);
  }

  private async recordDetection(
    found: AvailableUpdate,
    collected: CollectedRegistryUpdates,
    installed: readonly InstalledExtensionRow[],
  ): Promise<void> {
    const planned = await this.computeUpdateConflicts(found, collected);
    const oldRequires = installed.find((r) => r.id === found.id)?.manifest.requires?.connectors;
    const addedRequirements = (collected.requires.get(found.id) ?? []).filter(
      (c) => !(oldRequires ?? []).includes(c),
    );
    const update: AvailableUpdate = {
      ...found,
      ...planned,
      ...(addedRequirements.length > 0 ? { addedRequirements } : {}),
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

  private dropStaleOffers(collected: CollectedRegistryUpdates): void {
    // The cache holds one entry per extension id, so "re-reported" is: same id, same version.
    const reported = new Map(collected.updates.map((u) => [u.id, u.toVersion]));
    const errored = new Set(collected.errors.map((e) => e.registry));
    for (const cached of this.opts.cache.list()) {
      if (reported.get(cached.id) === cached.toVersion) continue;
      if (errored.has(cached.sourceRegistry)) continue;
      this.opts.cache.remove(cached.id);
    }
  }

  /**
   * Whether the bump fits: the update is planned through its registries (`planUpdate`), so a new
   * dependency a registry carries becomes an added package, while a range nothing satisfies, a
   * dependency naming a registry the owner has not added, or a refused manifest is a conflict with
   * a one-line reason. An unreachable registry is an `offline` conflict with no added packages, so
   * the apply re-plans or refuses. Any other failure (an unreadable installed manifest, a source
   * registry that changed mid-tick) is an `ERR_UPDATE_UNPLANNED` conflict: an update is never
   * shown clean without a plan.
   *
   * An update whose signature failed or whose publisher key conflicts can never be applied, so it
   * is not planned at all: no dependency registry is asked anything for it, and it carries neither
   * conflicts nor added packages (its `verificationStatus` says why it stops).
   */
  private async computeUpdateConflicts(
    found: AvailableUpdate,
    collected: CollectedRegistryUpdates,
  ): Promise<Pick<AvailableUpdate, "conflicts" | "addedPackages">> {
    if (found.verificationStatus !== "verified") return {};
    const newDependsOn = collected.dependsOn.get(found.id);
    const index = collected.indexes?.get(sourceKey(found.sourceRegistry, found.rootFingerprint));
    const newManifest: ExtensionManifestForSolver = {
      id: found.id,
      version: found.toVersion,
      ...(newDependsOn === undefined ? {} : { dependsOn: newDependsOn }),
    };
    try {
      const plan = await this.opts.planUpdate(found, newManifest, {
        signal: this.abort.signal,
        ...(index === undefined ? {} : { index }),
      });
      return { addedPackages: plan.addedPackages };
    } catch (e) {
      return { conflicts: [updateConflictOf(e)] };
    }
  }
}

/** One line: a reason never spans lines in a list or a refusal. */
function oneLine(text: string): string {
  return text
    .split(/[\r\n]/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
}

/** The conflict a planning failure is; an unclassified failure is `ERR_UPDATE_UNPLANNED`. */
function updateConflictOf(e: unknown): UpdateConflict {
  if (isDependencyConflictError(e)) {
    return { ...e.conflict, reason: oneLine(describeDependencyConflict(e.conflict)) };
  }
  if (isOfflineDependencyResolutionError(e)) {
    return { kind: "offline", id: e.missingId, parent: e.parent, reason: oneLine(e.message) };
  }
  if (e instanceof RegistryError || e instanceof TrustBlockError) {
    return { kind: "registry", code: e.code, reason: oneLine(e.message) };
  }
  const why = e instanceof Error ? e.message : String(e);
  return {
    kind: "registry",
    code: "ERR_UPDATE_UNPLANNED",
    reason: oneLine(`ERR_UPDATE_UNPLANNED: the update could not be planned: ${why}`),
  };
}
