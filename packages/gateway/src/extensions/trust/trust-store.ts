/**
 * The trust store (marketplace trust layer): the ONLY code that names `trust_statement` and
 * `trust_feed_state` (static rule D37). It records statements that arrive in the Nimbus trust feed,
 * its baked snapshot, or a verified registry index, and the trust feed's anti-rollback floor.
 *
 * What may be stored is decided here, not by the caller:
 * - authority comes from `verifyTrustStatement` against the root of the document that carried the
 *   statement (the Nimbus trust root for the feed and snapshot, the registry's pinned root for a
 *   registry index); a statement without authority is refused;
 * - a publisher-signed statement from a registry is stored only when that registry lists the
 *   publisher with the signing key, or an installed extension was verified with that key, and each
 *   registry may hold at most `MAX_STORED_STATEMENTS_PER_SOURCE` rows, so a hostile registry cannot
 *   grow the store without bound;
 * - `publisher.verified` never enters through `recordTrustStatements`: verification is the feed's
 *   CURRENT state (`replaceCurrentVerifications`), while every block is a monotonic union — no later
 *   document removes one.
 */
import type { Database } from "bun:sqlite";
import {
  publisherKeyFingerprint,
  type StatementSignerRole,
  type TrustStatement,
  trustStatementId,
  verifyTrustStatement,
} from "@nimbus-dev/registry-format";

import { dbRun } from "../../db/write.ts";

export type StatementSource =
  | { kind: "feed" | "snapshot"; nimbusRootKey: string }
  | {
      kind: "registry";
      name: string;
      rootKey: string;
      rootFingerprint: string;
      /** publisherId → base64 keys this registry's signed index lists; gates publisher-signed admission. */
      listedPublisherKeys: ReadonlyMap<string, ReadonlySet<string>>;
    };

export type RecordOutcome = {
  inserted: number;
  alreadyKnown: number;
  refused: number;
  capped: number;
};

export const MAX_STORED_STATEMENTS_PER_SOURCE = 1000;

function sourceColumn(source: StatementSource): string {
  return source.kind === "registry" ? `registry:${source.name}` : source.kind;
}

function authorityOf(s: TrustStatement, source: StatementSource): StatementSignerRole | null {
  return source.kind === "registry"
    ? verifyTrustStatement(s, { registryRootKey: source.rootKey })
    : verifyTrustStatement(s, { nimbusRootKey: source.nimbusRootKey });
}

function installedWithKey(db: Database, fingerprint: string): boolean {
  return (
    db
      .query("SELECT 1 FROM extension WHERE publisher_key_fingerprint = ? LIMIT 1")
      .get(fingerprint) !== null
  );
}

function publisherAdmitted(
  db: Database,
  s: TrustStatement,
  source: Extract<StatementSource, { kind: "registry" }>,
): boolean {
  if (source.listedPublisherKeys.get(s.publisherId)?.has(s.signerKey) === true) return true;
  return installedWithKey(db, publisherKeyFingerprint(s.signerKey));
}

function storedCount(db: Database, source: string): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM trust_statement WHERE source = ?").get(source) as {
      n: number;
    }
  ).n;
}

function subjectColumns(s: TrustStatement): {
  key: string | null;
  toKey: string | null;
  extensionId: string | null;
} {
  switch (s.kind) {
    case "key.revoke":
      return { key: s.keyFingerprint, toKey: null, extensionId: null };
    case "extension.takedown":
      return { key: null, toKey: null, extensionId: s.extensionId };
    case "key.rotate":
      return {
        key: publisherKeyFingerprint(s.fromKey),
        toKey: publisherKeyFingerprint(s.toKey),
        extensionId: null,
      };
    case "publisher.verified":
      return { key: null, toKey: null, extensionId: null };
  }
}

function insertStatement(
  db: Database,
  s: TrustStatement,
  role: StatementSignerRole,
  source: StatementSource,
  now: number,
): boolean {
  const subject = subjectColumns(s);
  const scoped = role === "registry" && source.kind === "registry";
  const r = dbRun(
    db,
    `INSERT OR IGNORE INTO trust_statement
       (statement_id, kind, statement_json, signer_fingerprint, signer_role, scope_registry,
        scope_root_fingerprint, source, publisher_id, key_fingerprint, to_key_fingerprint,
        extension_id, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      trustStatementId(s),
      s.kind,
      JSON.stringify(s),
      publisherKeyFingerprint(s.signerKey),
      role,
      scoped ? source.name : null,
      scoped ? source.rootFingerprint : null,
      sourceColumn(source),
      s.publisherId,
      subject.key,
      subject.toKey,
      subject.extensionId,
      now,
    ],
  );
  return r.changes > 0;
}

/**
 * Records the statements a document carried. Idempotent by statement id (the first source is
 * kept). Never throws on DATA: every statement lands in exactly one of the four counts.
 */
export function recordTrustStatements(
  db: Database,
  statements: readonly TrustStatement[],
  source: StatementSource,
  now: number,
): RecordOutcome {
  const out: RecordOutcome = { inserted: 0, alreadyKnown: 0, refused: 0, capped: 0 };
  const column = sourceColumn(source);
  db.transaction(() => {
    let stored = source.kind === "registry" ? storedCount(db, column) : 0;
    for (const s of statements) {
      const role = s.kind === "publisher.verified" ? null : authorityOf(s, source);
      if (role === null) {
        out.refused++;
        continue;
      }
      if (source.kind === "registry") {
        if (role === "publisher" && !publisherAdmitted(db, s, source)) {
          out.capped++;
          continue;
        }
        if (stored >= MAX_STORED_STATEMENTS_PER_SOURCE) {
          out.capped++;
          continue;
        }
      }
      if (insertStatement(db, s, role, source, now)) {
        out.inserted++;
        stored++;
      } else {
        out.alreadyKnown++;
      }
    }
  })();
  return out;
}

/**
 * Replaces the current set of Nimbus publisher verifications with the ones in the latest accepted
 * feed (or snapshot). Entries without Nimbus authority are ignored. Returns the rows written.
 */
export function replaceCurrentVerifications(
  db: Database,
  statements: readonly TrustStatement[],
  nimbusRootKey: string,
  now: number,
): number {
  let written = 0;
  const source: StatementSource = { kind: "feed", nimbusRootKey };
  db.transaction(() => {
    dbRun(
      db,
      "DELETE FROM trust_statement WHERE kind = 'publisher.verified' AND source IN ('feed', 'snapshot')",
    );
    for (const s of statements) {
      if (s.kind !== "publisher.verified") continue;
      if (verifyTrustStatement(s, { nimbusRootKey }) !== "nimbus") continue;
      if (insertStatement(db, s, "nimbus", source, now)) written++;
    }
  })();
  return written;
}

export type FeedFloor = {
  rootKey: string;
  lastSequence: number;
  lastDocumentSha256: string;
  lastGeneratedAt: string;
  lastFetchedAt: number | null;
  lastAttemptedAt: number | null;
};

type FeedFloorRow = {
  root_key: string;
  last_sequence: number;
  last_document_sha256: string;
  last_generated_at: string;
  last_fetched_at: number | null;
  last_attempted_at: number | null;
};

export function readFeedFloor(db: Database, name: string): FeedFloor | undefined {
  const r = db
    .query(
      "SELECT root_key, last_sequence, last_document_sha256, last_generated_at, last_fetched_at, last_attempted_at FROM trust_feed_state WHERE name = ?",
    )
    .get(name) as FeedFloorRow | null;
  if (r === null) return undefined;
  return {
    rootKey: r.root_key,
    lastSequence: r.last_sequence,
    lastDocumentSha256: r.last_document_sha256,
    lastGeneratedAt: r.last_generated_at,
    lastFetchedAt: r.last_fetched_at,
    lastAttemptedAt: r.last_attempted_at,
  };
}

/**
 * Advances the feed's floor, conditional like the registry floors: a higher sequence, or the same
 * sequence with the same document. A different root key replaces the floor (a release re-pin).
 */
export function recordFeedAccepted(
  db: Database,
  name: string,
  f: {
    rootKey: string;
    sequence: number;
    documentSha256: string;
    generatedAt: string;
    now: number;
  },
): "accepted" | "rollback" | "equivocation" {
  const r = dbRun(
    db,
    `INSERT INTO trust_feed_state (name, root_key, last_sequence, last_document_sha256, last_generated_at, last_fetched_at, last_attempted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       root_key = excluded.root_key,
       last_sequence = excluded.last_sequence,
       last_document_sha256 = excluded.last_document_sha256,
       last_generated_at = excluded.last_generated_at,
       last_fetched_at = excluded.last_fetched_at,
       last_attempted_at = excluded.last_attempted_at
     WHERE trust_feed_state.root_key <> excluded.root_key
        OR trust_feed_state.last_sequence < excluded.last_sequence
        OR (trust_feed_state.last_sequence = excluded.last_sequence
            AND trust_feed_state.last_document_sha256 = excluded.last_document_sha256)`,
    [name, f.rootKey, f.sequence, f.documentSha256, f.generatedAt, f.now, f.now],
  );
  if (r.changes > 0) return "accepted";
  const cur = readFeedFloor(db, name);
  return cur !== undefined && cur.lastSequence === f.sequence ? "equivocation" : "rollback";
}

/** Notes a fetch attempt that did not advance the floor. Touches an existing row only. */
export function recordFeedAttempt(db: Database, name: string, now: number): void {
  dbRun(db, "UPDATE trust_feed_state SET last_attempted_at = ? WHERE name = ?", [now, name]);
}

export type TrustStoreCounts = {
  revocations: number;
  takedowns: number;
  rotations: number;
  verifiedPublishers: number;
  bySource: Record<string, number>;
};

export function trustStoreCounts(db: Database): TrustStoreCounts {
  const byKind = new Map(
    (
      db.query("SELECT kind, COUNT(*) AS n FROM trust_statement GROUP BY kind").all() as Array<{
        kind: string;
        n: number;
      }>
    ).map((r) => [r.kind, r.n]),
  );
  const bySource = Object.fromEntries(
    (
      db
        .query(
          "SELECT source, COUNT(*) AS n FROM trust_statement WHERE kind <> 'publisher.verified' GROUP BY source ORDER BY source",
        )
        .all() as Array<{ source: string; n: number }>
    ).map((r) => [r.source, r.n]),
  );
  return {
    revocations: byKind.get("key.revoke") ?? 0,
    takedowns: byKind.get("extension.takedown") ?? 0,
    rotations: byKind.get("key.rotate") ?? 0,
    verifiedPublishers: byKind.get("publisher.verified") ?? 0,
    bySource,
  };
}
