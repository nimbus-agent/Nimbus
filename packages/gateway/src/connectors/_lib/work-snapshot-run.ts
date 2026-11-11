import type { WorkSnapshotRelation } from "../../index/work-snapshot-store.ts";
import type { SyncContext } from "../../sync/types.ts";

/**
 * The shared step of a "my open work" snapshot (Phase 10 MB1): the pure interval test, the outcome of
 * a fetch (`complete` or `partial`) and the replace-or-keep step. A syncable differs only in HOW it
 * fetches; it upserts every member through `ctx.upsertItem`, returns their external ids, and this
 * helper decides whether the snapshot is replaced.
 *
 * partial = a request failed, a page did not parse, a later page errored, or the provider said the
 * result is incomplete: the previous snapshot is kept. capped = every request succeeded and the
 * provider reports more than the cap: the capped set REPLACES the snapshot (most urgent first).
 */
export const DEFAULT_SNAPSHOT_INTERVAL_MINUTES = 15;

export type SnapshotFetch =
  | {
      readonly kind: "complete";
      readonly externalIds: readonly string[];
      readonly capped: boolean;
      readonly total?: number;
    }
  | { readonly kind: "partial"; readonly reason: string };

/** The interval in ms; an absent value is the 15-minute default (config validates 5..240). */
export function snapshotIntervalMs(minutes?: number): number {
  const m = minutes === undefined ? DEFAULT_SNAPSHOT_INTERVAL_MINUTES : minutes;
  return m * 60_000;
}

/** Whether a snapshot attempt is due: never attempted, the clock moved back, or the interval elapsed. */
export function snapshotDue(
  lastAttemptMs: number | null,
  nowMs: number,
  intervalMs: number,
): boolean {
  if (lastAttemptMs === null) return true;
  if (lastAttemptMs > nowMs) return true;
  return nowMs - lastAttemptMs >= intervalMs;
}

const MAX_REASON_CHARS = 200;

function reasonOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, MAX_REASON_CHARS);
}

/**
 * Runs `fetch` and applies its outcome. NEVER throws: a rate limit, a 401 or any other error is a
 * `partial` (logged, previous snapshot kept), so the incremental sync that already succeeded does not
 * fail because the snapshot step did.
 */
export async function applySnapshot(
  ctx: SyncContext,
  service: string,
  relation: WorkSnapshotRelation,
  fetch: () => Promise<SnapshotFetch>,
): Promise<void> {
  let outcome: SnapshotFetch;
  try {
    outcome = await fetch();
  } catch (err) {
    outcome = { kind: "partial", reason: reasonOf(err) };
  }
  if (outcome.kind === "partial") {
    ctx.logger.warn(
      { service, relation, snapshot_partial: true, reason: outcome.reason },
      "work snapshot kept: the fetch was partial",
    );
    return;
  }
  try {
    const { stored, dropped } = ctx.replaceWorkSnapshot(relation, outcome.externalIds);
    ctx.logger.info(
      {
        service,
        relation,
        stored,
        dropped,
        snapshot_capped: outcome.capped,
        ...(outcome.total === undefined ? {} : { total: outcome.total }),
      },
      "work snapshot replaced",
    );
  } catch (err) {
    ctx.logger.warn(
      { service, relation, snapshot_partial: true, reason: reasonOf(err) },
      "work snapshot kept: the replace failed",
    );
  }
}
