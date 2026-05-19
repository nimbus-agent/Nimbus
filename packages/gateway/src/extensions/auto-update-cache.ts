import type { AvailableUpdate } from "./auto-update-types.ts";

/**
 * In-memory cache of available extension updates, keyed by extension id.
 *
 * Lifecycle: owned by `ExtensionAutoUpdater`. One entry per extension id
 * (the most-recently-detected toVersion supersedes any prior entry).
 * Lost on Gateway restart by design (no DB persistence) — the polling
 * daemon repopulates on the next pass.
 */
export class AutoUpdateCache {
  private readonly entries = new Map<string, AvailableUpdate>();

  /** Get the cached entry for `id`, or undefined. */
  get(id: string): AvailableUpdate | undefined {
    return this.entries.get(id);
  }

  /** Snapshot of all cache entries (defensive shallow copy). */
  list(): AvailableUpdate[] {
    return Array.from(this.entries.values());
  }

  /** Upsert the entry for `update.id`. Replaces any prior entry for that id. */
  upsert(update: AvailableUpdate): void {
    this.entries.set(update.id, update);
  }

  /**
   * True iff the cache does not already hold an entry for `(id, toVersion)`.
   * Used by the polling pass to decide whether to write an
   * `extension.autoUpdate.detected` audit row (de-dupes re-polls of an
   * already-known bump).
   */
  isNewDetection(update: AvailableUpdate): boolean {
    const cur = this.entries.get(update.id);
    return cur === undefined || cur.toVersion !== update.toVersion;
  }

  /** Remove the entry for `id` (no-op if absent). */
  remove(id: string): void {
    this.entries.delete(id);
  }

  /** Drop every entry. Called on Gateway shutdown for tidiness. */
  clear(): void {
    this.entries.clear();
  }
}
