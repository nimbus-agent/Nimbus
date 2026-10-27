/**
 * The verified-publisher badge (marketplace trust layer, spec R6). Shown exactly when the CURRENT
 * Nimbus `publisher.verified` entry for the publisher lists the key that verified (or would verify)
 * the code, and that key is not revoked here — directly or through a revoked ancestor (R4), scoped
 * exactly as I48's blocks are (`isKeyRevoked`). Every surface asks this one function with the subject
 * it already builds for `blocksFor`, so the badge and the blocks never disagree about which key and
 * which registry are meant. Verification is current state (R7): nothing here is cached.
 */
import type { Database } from "bun:sqlite";

import { readIndexedUserVersion } from "../../index/migrations/runner.ts";
import type { BlockSubject } from "./trust-blocks.ts";
import { isKeyRevoked } from "./trust-keys.ts";
import { readCurrentVerification } from "./trust-store.ts";

export type VerifiedPublisher = { github: string; verifiedAt: string };

/** The badge for `s`, or `null`: below V76, for unsigned code, or when R6 is not met. */
export function verifiedPublisherFor(
  db: Database,
  s: Pick<BlockSubject, "publisherId" | "keyFingerprint" | "source">,
): VerifiedPublisher | null {
  if (s.publisherId === null || s.keyFingerprint === null) return null;
  if (readIndexedUserVersion(db) < 76) return null;
  const v = readCurrentVerification(db, s.publisherId);
  if (v === null || !v.keyFingerprints.has(s.keyFingerprint)) return null;
  if (isKeyRevoked(db, { publisherId: s.publisherId, source: s.source }, s.keyFingerprint)) {
    return null;
  }
  return { github: v.github, verifiedAt: v.verifiedAt };
}

/** The one sentence a prompt carries: `Verified publisher: @handle (verified <date>)` or not. */
export function publisherBadgeText(v: VerifiedPublisher | null): string {
  return v === null
    ? "Unverified publisher"
    : `Verified publisher: @${v.github} (verified ${v.verifiedAt.slice(0, 10)})`;
}
