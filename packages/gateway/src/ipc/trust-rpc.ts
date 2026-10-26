/**
 * `trust.status` / `trust.refresh` (marketplace trust layer). CLI-only: the whole `trust` namespace
 * is LAN-forbidden and absent from the Tauri allowlist; a demo-rooted gateway refuses `trust.refresh`
 * and has no feed handle, so `trust.status` there reports no feed.
 */
import type { Database } from "bun:sqlite";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import { TRUST_FEED_NAME, type TrustFeedResult } from "../extensions/trust/trust-feed.ts";
import type { TrustFeedHandle } from "../extensions/trust/trust-feed-boot.ts";
import {
  readFeedFloor,
  type TrustStoreCounts,
  trustStoreCounts,
} from "../extensions/trust/trust-store.ts";

export interface TrustStatus {
  configured: boolean;
  url: string | null;
  rootFingerprint: string | null;
  sequence: number | null;
  lastFetchedAt: number | null;
  lastAttemptedAt: number | null;
  /** Whole days since the last accepted fetch; `null` when the feed was never accepted. */
  ageDays: number | null;
  intervalHours: number | null;
  counts: TrustStoreCounts;
}

const DAY_MS = 86_400_000;

export function trustStatus(
  db: Database,
  handle: TrustFeedHandle | undefined,
  now: number,
): TrustStatus {
  const config = handle?.config ?? null;
  const floor = readFeedFloor(db, TRUST_FEED_NAME);
  const fetched = floor?.lastFetchedAt ?? null;
  return {
    configured: config !== null,
    url: config?.url ?? null,
    rootFingerprint: config === null ? null : publisherKeyFingerprint(config.rootKey),
    sequence: floor?.lastSequence ?? null,
    lastFetchedAt: fetched,
    lastAttemptedAt: floor?.lastAttemptedAt ?? null,
    ageDays: fetched === null ? null : Math.floor((now - fetched) / DAY_MS),
    intervalHours: handle?.intervalHours ?? null,
    counts: trustStoreCounts(db),
  };
}

export type TrustRpcOutcome = { kind: "hit"; value: unknown } | { kind: "miss" };

export async function dispatchTrustRpc(opts: {
  method: string;
  db: Database;
  trustFeed: TrustFeedHandle | undefined;
  now: () => number;
}): Promise<TrustRpcOutcome> {
  switch (opts.method) {
    case "trust.status":
      return { kind: "hit", value: trustStatus(opts.db, opts.trustFeed, opts.now()) };
    case "trust.refresh": {
      const value: TrustFeedResult =
        opts.trustFeed === undefined
          ? { status: "not_configured" }
          : await opts.trustFeed.refreshNow();
      return { kind: "hit", value };
    }
    default:
      return { kind: "miss" };
  }
}
