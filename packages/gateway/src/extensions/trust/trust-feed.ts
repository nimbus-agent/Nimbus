/**
 * The Nimbus trust feed (marketplace trust layer): one signed static `trust.json` carrying key
 * revocations, extension takedowns and publisher verifications, fetched on a timer, plus a snapshot
 * of it baked into each release for offline installs.
 *
 * This build bakes NEITHER: `BUILTIN_TRUST_FEED` and `BUILTIN_TRUST_SNAPSHOT` are `null` until the
 * Nimbus trust repository and root key exist (trust layer PR 5), exactly as `BUILTIN_REGISTRY` was
 * `null` before the Readwise pilot baked it. With no feed configured nothing is fetched and no
 * egress row is written.
 *
 * Fetching reuses `fetchRegistryBytes` under the reserved name `nimbus-trust`: air gap refuses, and
 * every remote request appends one I29 `registry`-class row first (method `trust.feed`). The feed's
 * floor refuses a lower sequence and different content at an accepted one, like a registry index.
 */
import type { Database } from "bun:sqlite";
import {
  MAX_TRUST_FEED_BYTES,
  parseTrustFeed,
  RegistryError,
  readTrustFeedStatements,
  type TrustFeed,
  trustFeedDigest,
  verifyTrustFeedPinned,
} from "@nimbus-dev/registry-format";

import { fetchRegistryBytes, type RegistryFetchDeps } from "../registry/registry-fetch.ts";
import { TRUST_FEED_REGISTRY_NAME } from "../registry/registry-store.ts";
import {
  type RecordOutcome,
  readFeedFloor,
  recordFeedAccepted,
  recordFeedAttempt,
  recordTrustStatements,
  replaceCurrentVerifications,
} from "./trust-store.ts";

export const TRUST_FEED_NAME = TRUST_FEED_REGISTRY_NAME;

export interface TrustFeedConfig {
  /** The feed's base URL; `trust.json` is resolved against it, so it keeps its trailing slash. */
  readonly url: string;
  /** Base64 Ed25519 public key of the Nimbus trust root. */
  readonly rootKey: string;
}

/** The trust feed this release follows. `null` until trust layer PR 5 bakes it. */
export const BUILTIN_TRUST_FEED: TrustFeedConfig | null = null;

/** A complete signed `trust.json` baked into the release. `null` until trust layer PR 5. */
export const BUILTIN_TRUST_SNAPSHOT: string | null = null;

export type TrustFeedResult =
  | { status: "accepted"; sequence: number; recorded: RecordOutcome; verified: number }
  | { status: "unchanged"; sequence: number }
  | { status: "not_configured" }
  | { status: "refused"; code: string; detail: string };

function refused(e: unknown): TrustFeedResult {
  if (e instanceof RegistryError) return { status: "refused", code: e.code, detail: e.detail };
  return {
    status: "refused",
    code: "ERR_TRUST_FEED_FAILED",
    detail: e instanceof Error ? e.message : String(e),
  };
}

/**
 * Verifies a parsed feed against the pinned root, advances the floor, and records its statements.
 * Throws a `RegistryError` on a rollback or equivocation; the caller turns it into `refused`.
 */
async function acceptFeed(
  db: Database,
  feed: TrustFeed,
  cfg: TrustFeedConfig,
  source: "feed" | "snapshot",
  now: number,
): Promise<TrustFeedResult> {
  await verifyTrustFeedPinned(feed, cfg.rootKey);
  const read = readTrustFeedStatements(feed);
  const verdict = recordFeedAccepted(db, TRUST_FEED_NAME, {
    rootKey: cfg.rootKey,
    sequence: feed.sequence,
    documentSha256: trustFeedDigest(feed),
    generatedAt: feed.generatedAt,
    now,
  });
  if (verdict === "rollback") {
    throw new RegistryError(
      "ERR_TRUST_FEED_ROLLBACK",
      `trust feed sequence ${feed.sequence} is older than the one already accepted`,
    );
  }
  if (verdict === "equivocation") {
    throw new RegistryError(
      "ERR_TRUST_FEED_EQUIVOCATION",
      `trust feed sequence ${feed.sequence} was already accepted with different content`,
    );
  }
  const recorded = recordTrustStatements(
    db,
    read.statements,
    { kind: source, nimbusRootKey: cfg.rootKey },
    now,
  );
  const verified = replaceCurrentVerifications(db, read.statements, cfg.rootKey, now);
  return { status: "accepted", sequence: feed.sequence, recorded, verified };
}

function lastAcceptedSequence(db: Database): number | undefined {
  return readFeedFloor(db, TRUST_FEED_NAME)?.lastSequence;
}

/**
 * Fetches, verifies and records the trust feed. Never throws: every failure is a `refused` result,
 * and an attempt that did not advance the floor is noted on the existing floor row.
 */
export async function refreshTrustFeed(
  deps: RegistryFetchDeps & { readonly trustFeed?: TrustFeedConfig | null },
  signal?: AbortSignal,
): Promise<TrustFeedResult> {
  const cfg = deps.trustFeed === undefined ? BUILTIN_TRUST_FEED : deps.trustFeed;
  if (cfg === null) return { status: "not_configured" };
  const now = deps.now();
  try {
    const bytes = await fetchRegistryBytes(
      deps,
      { name: TRUST_FEED_NAME, url: cfg.url },
      "trust.json",
      { method: "trust.feed", maxBytes: MAX_TRUST_FEED_BYTES },
      signal,
    );
    const feed = parseTrustFeed(bytes);
    const before = lastAcceptedSequence(deps.db);
    const result = await acceptFeed(deps.db, feed, cfg, "feed", now);
    if (result.status === "accepted" && before === feed.sequence) {
      return { status: "unchanged", sequence: feed.sequence };
    }
    return result;
  } catch (e) {
    recordFeedAttempt(deps.db, TRUST_FEED_NAME, now);
    return refused(e);
  }
}

/**
 * Applies the baked snapshot at boot (no network). A snapshot older than the floor already stored
 * is `unchanged` — a newer fetched feed already applies — never refused merely for being older.
 */
export async function applyTrustSnapshot(
  db: Database,
  snapshot: string | null,
  cfg: TrustFeedConfig | null,
  now: number,
): Promise<TrustFeedResult> {
  if (snapshot === null || cfg === null) return { status: "not_configured" };
  try {
    const feed = parseTrustFeed(new TextEncoder().encode(snapshot));
    const before = lastAcceptedSequence(db);
    if (before !== undefined && feed.sequence < before) {
      return { status: "unchanged", sequence: before };
    }
    const result = await acceptFeed(db, feed, cfg, "snapshot", now);
    if (result.status === "accepted" && before === feed.sequence) {
      return { status: "unchanged", sequence: feed.sequence };
    }
    return result;
  } catch (e) {
    return refused(e);
  }
}
