/**
 * Which stored trust statements block one extension (marketplace trust layer, invariant I48).
 *
 * A subject is blocked by:
 * - a `key.revoke` of the key that verified (or would verify) its code, for its publisher id;
 * - an `extension.takedown` naming its extension id AND publisher id, for every version (`"*"`) or
 *   for its version.
 * Scope (spec R2): a statement signed by Nimbus or by the publisher applies everywhere; one signed
 * by a registry root applies only to code whose recorded source is that registry under that root
 * fingerprint, so a maintainer never reaches an extension of the same id from another registry. An
 * unsigned subject (no publisher) is never blocked: it has no verifying key and no publisher id.
 *
 * Rotation (spec R4): a key is also blocked when a revoked key reaches it through `key.rotate`
 * statements — a leaked key can sign a rotation to an attacker's key before its revocation lands —
 * unless the CURRENT Nimbus verification of the publisher lists that key. Vouching clears only
 * that taint, never a revocation of the key itself.
 */
import type { Database } from "bun:sqlite";
import {
  ancestorsOf,
  parseTrustStatement,
  publisherKeyFingerprint,
} from "@nimbus-dev/registry-format";

import type { ExtensionRow } from "../../automation/extension-store.ts";
import { readIndexedUserVersion } from "../../index/migrations/runner.ts";
import type { ExtensionManifest } from "../manifest.ts";
import {
  type BlockCandidateRow,
  readBlockCandidates,
  readCurrentVerifiedKeys,
  readPublisherRevocations,
  readRotationEdges,
} from "./trust-store.ts";

export type BlockSubject = {
  readonly extensionId: string;
  readonly version: string;
  /** `null`: unsigned code, never blocked. */
  readonly publisherId: string | null;
  /** The fingerprint of the key that verified (or would verify) the code. */
  readonly keyFingerprint: string | null;
  readonly source: { readonly registry: string; readonly rootFingerprint: string } | null;
};

export type TrustBlock = {
  readonly statementId: string;
  readonly kind: "key.revoke" | "extension.takedown";
  readonly issuer: "publisher" | "nimbus" | "registry";
  /** The registry whose root signed it; `null` for a Nimbus or publisher statement. */
  readonly registry: string | null;
  /** Control characters removed, at most `MAX_REASON_CHARS`. */
  readonly reason: string;
  readonly issuedAt: string;
};

export type TrustBlockCode = "ERR_EXTENSION_KEY_REVOKED" | "ERR_EXTENSION_TAKEN_DOWN";

export const MAX_REASON_CHARS = 200;

/** A refusal because of a block. The code leads the message, so a CLI shows it. */
export class TrustBlockError extends Error {
  readonly code: TrustBlockCode;
  readonly blocks: readonly TrustBlock[];
  constructor(code: TrustBlockCode, message: string, blocks: readonly TrustBlock[]) {
    super(`${code}: ${message}`);
    this.name = "TrustBlockError";
    this.code = code;
    this.blocks = blocks;
  }
}

/** C0/C1 controls and the two Unicode line separators: anything that could break a line or a terminal. */
function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

export function sanitiseReason(reason: string): string {
  const flat = Array.from(reason, (ch) => (isControl(ch.codePointAt(0) ?? 0) ? " " : ch))
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
  return flat.length > MAX_REASON_CHARS ? `${flat.slice(0, MAX_REASON_CHARS - 1)}…` : flat;
}

export function inScope(row: BlockCandidateRow, s: Pick<BlockSubject, "source">): boolean {
  if (row.signerRole !== "registry") return true;
  return (
    s.source !== null &&
    row.scopeRegistry === s.source.registry &&
    row.scopeRootFingerprint === s.source.rootFingerprint
  );
}

export const UNREADABLE_REASON = "the stored statement could not be read";

/**
 * The stored row as a block for `s`, or `null` when it does not apply. A row that no longer parses
 * still blocks (fail closed): its columns already matched the subject's publisher and key or
 * extension id, and an unreadable takedown is taken to cover every version.
 */
function asBlock(row: BlockCandidateRow, s: BlockSubject): TrustBlock | null {
  if (!inScope(row, s)) return null;
  let st: ReturnType<typeof parseTrustStatement>;
  try {
    st = parseTrustStatement(JSON.parse(row.statementJson));
  } catch {
    return {
      statementId: row.statementId,
      kind: row.kind,
      issuer: row.signerRole,
      registry: row.signerRole === "registry" ? row.scopeRegistry : null,
      reason: UNREADABLE_REASON,
      issuedAt: "unknown",
    };
  }
  if (st.kind === "extension.takedown") {
    if (st.extensionId !== s.extensionId || st.publisherId !== s.publisherId) return null;
    if (st.versions !== "*" && !st.versions.includes(s.version)) return null;
  } else if (st.kind === "key.revoke") {
    if (st.keyFingerprint !== s.keyFingerprint || st.publisherId !== s.publisherId) return null;
  } else {
    return null;
  }
  return {
    statementId: row.statementId,
    kind: st.kind,
    issuer: row.signerRole,
    registry: row.signerRole === "registry" ? row.scopeRegistry : null,
    reason: sanitiseReason(st.reason),
    issuedAt: st.issuedAt,
  };
}

/** Every block applying to `s`, newest first. `[]` below schema V76. */
export function blocksFor(db: Database, s: BlockSubject): TrustBlock[] {
  if (s.publisherId === null || readIndexedUserVersion(db) < 76) return [];
  const rows = readBlockCandidates(db, {
    publisherId: s.publisherId,
    keyFingerprint: s.keyFingerprint,
    extensionId: s.extensionId,
  });
  const out = new Map<string, TrustBlock>();
  for (const row of rows) {
    const b = asBlock(row, s);
    if (b !== null) out.set(b.statementId, b);
  }
  for (const b of taintBlocks(db, s)) if (!out.has(b.statementId)) out.set(b.statementId, b);
  return newestFirst([...out.values()]);
}

function newestFirst(blocks: TrustBlock[]): TrustBlock[] {
  return blocks.sort((a, b) =>
    a.issuedAt === b.issuedAt
      ? a.statementId.localeCompare(b.statementId)
      : b.issuedAt.localeCompare(a.issuedAt),
  );
}

/**
 * R4: the in-scope revocations of keys from which `s.keyFingerprint` is reached by rotations, as
 * blocks on `s` — none when the current Nimbus verification lists the key. Each keeps the
 * revocation's statement id, so the owner's acknowledgement works exactly as for a direct one.
 */
export function taintBlocks(db: Database, s: BlockSubject): TrustBlock[] {
  const fp = s.keyFingerprint;
  if (s.publisherId === null || fp === null) return [];
  if (readCurrentVerifiedKeys(db, s.publisherId)?.has(fp) === true) return [];
  const ancestors = ancestorsOf(readRotationEdges(db, s.publisherId), fp);
  if (ancestors.size === 0) return [];
  const out: TrustBlock[] = [];
  for (const row of readPublisherRevocations(db, s.publisherId)) {
    if (!ancestors.has(row.keyFingerprint) || !inScope(row, s)) continue;
    const b = asBlock(row, { ...s, keyFingerprint: row.keyFingerprint });
    if (b === null) continue;
    out.push({
      ...b,
      reason: sanitiseReason(
        `key ${fp} was rotated from revoked key ${row.keyFingerprint}: ${b.reason}`,
      ),
    });
  }
  return out;
}

function issuerPhrase(b: TrustBlock): string {
  if (b.issuer === "registry") return `the maintainer of registry "${b.registry ?? "?"}"`;
  return b.issuer === "nimbus" ? "Nimbus" : "its publisher";
}

/** One line per block, for refusals and the CLI. */
export function describeBlock(b: TrustBlock): string {
  const what = b.kind === "key.revoke" ? "publisher key revoked" : "taken down";
  return `${what} by ${issuerPhrase(b)} on ${b.issuedAt}: ${b.reason}`;
}

/** The refusal for `blocks` (non-empty); a revocation wins, since it covers every version. */
export function trustBlockError(
  subject: { extensionId: string; version: string },
  blocks: readonly TrustBlock[],
): TrustBlockError {
  const revoked = blocks.filter((b) => b.kind === "key.revoke");
  const shown = revoked.length > 0 ? revoked : blocks;
  const code: TrustBlockCode =
    revoked.length > 0 ? "ERR_EXTENSION_KEY_REVOKED" : "ERR_EXTENSION_TAKEN_DOWN";
  return new TrustBlockError(
    code,
    `${subject.extensionId}@${subject.version}: ${shown.map(describeBlock).join("; ")}`,
    blocks,
  );
}

/** Throws a `TrustBlockError` when anything blocks `s`. */
export function assertNotBlocked(db: Database, s: BlockSubject): void {
  const blocks = blocksFor(db, s);
  if (blocks.length > 0) throw trustBlockError(s, blocks);
}

/** The acknowledged statement ids of a run grant; a malformed value acknowledges nothing. */
export function parseAcknowledged(ackJson: string | undefined): ReadonlySet<string> {
  if (ackJson === undefined) return new Set();
  try {
    const v: unknown = JSON.parse(ackJson);
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** The blocks the grant's acknowledgement does not name. */
export function unacknowledged(
  blocks: readonly TrustBlock[],
  ackJson: string | undefined,
): TrustBlock[] {
  const acked = parseAcknowledged(ackJson);
  return blocks.filter((b) => !acked.has(b.statementId));
}

/** The canonical acknowledgement for `blocks`: their sorted statement ids, as JSON. */
export function acknowledgementJson(blocks: readonly TrustBlock[]): string {
  return JSON.stringify(
    [...new Set(blocks.map((b) => b.statementId))].sort((a, b) => a.localeCompare(b)),
  );
}

/**
 * The subject for an installed extension. The verifying key is the one recorded at install
 * (`publisher_key_fingerprint`); a row not yet backfilled falls back to the manifest's declared
 * key, which before rotation (PR 3) is always the key that verified it.
 */
export function blockSubjectForInstalled(
  row: Pick<
    ExtensionRow,
    "id" | "version" | "source_registry" | "source_root_fingerprint" | "publisher_key_fingerprint"
  >,
  manifest: Pick<ExtensionManifest, "publisher">,
): BlockSubject {
  const publisher = manifest.publisher;
  return {
    extensionId: row.id,
    version: row.version,
    publisherId: publisher?.id ?? null,
    keyFingerprint:
      publisher === undefined
        ? null
        : (row.publisher_key_fingerprint ?? publisherKeyFingerprint(publisher.key)),
    source:
      row.source_registry != null && row.source_root_fingerprint != null
        ? { registry: row.source_registry, rootFingerprint: row.source_root_fingerprint }
        : null,
  };
}

/**
 * Every block applying to an installed extension, for BOTH keys that can stand for its verifying
 * key: the one recorded at install and the one its manifest declares (the spawn's Vault key must
 * equal the declared one, or the signature check fails). Approval, list/info, the enforcer and the
 * spawn's step 4a all read this one set, so an approval always acknowledges what a spawn checks.
 */
export function blocksForInstalled(
  db: Database,
  row: Parameters<typeof blockSubjectForInstalled>[0],
  manifest: Pick<ExtensionManifest, "publisher">,
): TrustBlock[] {
  const base = blockSubjectForInstalled(row, manifest);
  const declared =
    manifest.publisher === undefined ? null : publisherKeyFingerprint(manifest.publisher.key);
  const fingerprints = new Set([base.keyFingerprint, declared]);
  const seen = new Map<string, TrustBlock>();
  for (const keyFingerprint of fingerprints) {
    for (const b of blocksFor(db, { ...base, keyFingerprint })) seen.set(b.statementId, b);
  }
  return newestFirst([...seen.values()]);
}
