/**
 * "Fresh before acting" (marketplace trust layer, spec § 6.2): registry install and update apply
 * first refresh the trust feed, best-effort, so a revocation published since the last hourly fetch
 * is more likely to have arrived. Skipped when the last fetch is recent; capped in time; never
 * throws. When the feed cannot be refreshed the caller proceeds on stored state and says how old
 * it is (offline machines are never bricked, spec anti-goal).
 */
import type { Database } from "bun:sqlite";

import type { TrustFeedConfig, TrustFeedResult } from "./trust-feed.ts";
import { TRUST_FEED_NAME } from "./trust-feed.ts";
import { readFeedFloor } from "./trust-store.ts";

export const FRESHEN_MAX_AGE_MS = 5 * 60_000;
export const FRESHEN_TIMEOUT_MS = 10_000;
const DAY_MS = 86_400_000;

export type FreshenOutcome = {
  readonly status: "fresh" | "refreshed" | "not_configured" | "stale";
  /** Whole days since the feed last answered (or, if it never has, since the snapshot was generated). */
  readonly ageDays: number | null;
};

export interface FreshenHandle {
  readonly config: TrustFeedConfig | null;
  refreshNow(): Promise<TrustFeedResult>;
}

function ageDaysOf(db: Database, now: number): number | null {
  const floor = readFeedFloor(db, TRUST_FEED_NAME);
  if (floor === undefined) return null;
  const at = floor.lastFetchedAt ?? Date.parse(floor.lastGeneratedAt);
  return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / DAY_MS)) : null;
}

export async function freshenTrustFeed(
  handle: FreshenHandle | undefined,
  db: Database,
  now: number,
  opts: { maxAgeMs?: number; timeoutMs?: number } = {},
): Promise<FreshenOutcome> {
  if (handle === undefined || handle.config === null) {
    return { status: "not_configured", ageDays: null };
  }
  try {
    const last = readFeedFloor(db, TRUST_FEED_NAME)?.lastFetchedAt ?? null;
    if (last !== null && now - last < (opts.maxAgeMs ?? FRESHEN_MAX_AGE_MS)) {
      return { status: "fresh", ageDays: 0 };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), opts.timeoutMs ?? FRESHEN_TIMEOUT_MS);
    });
    // The daemon's refresh never rejects; on a timeout it keeps running and lands on its own.
    const result = await Promise.race([handle.refreshNow(), timedOut]);
    clearTimeout(timer);
    if (result !== "timeout" && (result.status === "accepted" || result.status === "unchanged")) {
      return { status: "refreshed", ageDays: 0 };
    }
    return { status: "stale", ageDays: ageDaysOf(db, now) };
  } catch {
    return { status: "stale", ageDays: null };
  }
}

/** The line an install prompt carries when the feed could not be refreshed; `undefined` otherwise. */
export function trustFeedNote(outcome: FreshenOutcome): string | undefined {
  if (outcome.status !== "stale") return undefined;
  const age =
    outcome.ageDays === null
      ? ""
      : `; it was last updated ${outcome.ageDays} day${outcome.ageDays === 1 ? "" : "s"} ago`;
  return `the trust feed could not be refreshed${age}, so a revocation published since then may not have reached this machine`;
}
