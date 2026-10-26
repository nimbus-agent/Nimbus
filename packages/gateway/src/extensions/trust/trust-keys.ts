/**
 * May a publisher move from the keys this machine trusts to a new key? (marketplace trust layer,
 * spec R3, R5, R8). Answered only from stored statements:
 * - a key revoked in scope, itself or through rotations from a revoked key (R4, `blocksFor`), is
 *   never a continuation;
 * - the CURRENT Nimbus verification listing the key is a continuation (Nimbus vouches);
 * - otherwise the key must be reached from a trusted key by rotations that never pass through a
 *   revoked key (R3: dates are not trusted after a leak), and those rotations must lead to ONE
 *   current key (R8: a fork gives no automatic continuity).
 */
import type { Database } from "bun:sqlite";

import { successorsOf } from "./rotation-graph.ts";
import { type BlockSubject, blocksFor } from "./trust-blocks.ts";
import { readCurrentVerifiedKeys, readRotationEdges } from "./trust-store.ts";

export type KeyContext = { readonly publisherId: string; readonly source: BlockSubject["source"] };

export type Continuity =
  | { ok: true; via: "trusted" | "new_publisher" | "nimbus" | "rotation" }
  | { ok: false; reason: "revoked" | "fork" | "unvouched" };

/** Whether `fp` is revoked here, directly or through rotations from a revoked key (R4). */
export function isKeyRevoked(db: Database, ctx: KeyContext, fp: string): boolean {
  // The extension id and version only matter for takedowns, which are filtered out.
  return blocksFor(db, {
    extensionId: "",
    version: "0.0.0",
    publisherId: ctx.publisherId,
    keyFingerprint: fp,
    source: ctx.source,
  }).some((b) => b.kind === "key.revoke");
}

function viaRotation(
  db: Database,
  ctx: KeyContext,
  trusted: readonly string[],
  candidate: string,
): Continuity {
  const edges = readRotationEdges(db, ctx.publisherId);
  const revoked = new Map<string, boolean>();
  const usable = (fp: string): boolean => {
    let r = revoked.get(fp);
    if (r === undefined) {
      r = isKeyRevoked(db, ctx, fp);
      revoked.set(fp, r);
    }
    return !r;
  };
  let forked = false;
  for (const k of trusted) {
    const { reachable, terminal } = successorsOf(edges, k, usable);
    if (!reachable.has(candidate)) continue;
    // One chain (one current key) — the candidate may be any key along it, as R5 allows. Several
    // current keys, or a cycle with none, is a fork (R8).
    if (terminal.size === 1) return { ok: true, via: "rotation" };
    forked = true;
  }
  return forked ? { ok: false, reason: "fork" } : { ok: false, reason: "unvouched" };
}

/** The decision for moving from `trusted` (fingerprints the Vault holds) to `candidate`. */
export function keyContinuity(
  db: Database,
  ctx: KeyContext,
  trusted: readonly string[],
  candidate: string,
): Continuity {
  if (trusted.includes(candidate)) return { ok: true, via: "trusted" };
  if (trusted.length === 0) return { ok: true, via: "new_publisher" };
  if (isKeyRevoked(db, ctx, candidate)) return { ok: false, reason: "revoked" };
  if (readCurrentVerifiedKeys(db, ctx.publisherId)?.has(candidate) === true) {
    return { ok: true, via: "nimbus" };
  }
  return viaRotation(db, ctx, trusted, candidate);
}
