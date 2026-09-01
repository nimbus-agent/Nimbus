import type { Database } from "bun:sqlite";

import { readEntityMetadata } from "../graph/relationship-graph.ts";

/** One `person --owns--> <target>` edge, presented for a brief. */
export type OwnershipOwner = {
  readonly externalId: string;
  readonly label: string;
  /** The edge weight: this owner's recency-weighted share of the target, 0..1. */
  readonly share: number;
  /** False when the id is the `git:<email>` fallback — no `person` row matched. */
  readonly resolved: boolean;
};

/**
 * The three truncation facts, each independently nullable.
 *
 * `null` means exactly one thing: NOT RECORDED. It never doubles as "no truncation".
 * Rows written before the floor/cap split carry no `ownersAboveFloor`, and their
 * `truncated` boolean conflated the share floor with the display cap — so it is
 * discarded rather than reported, and the brief says the breakdown is unavailable.
 */
export type OwnershipCounts = {
  readonly ownerCount: number | null;
  readonly ownersAboveFloor: number | null;
  readonly truncated: boolean | null;
};

export type OwnershipEntity = {
  readonly id: string;
  readonly label: string;
  readonly counts: OwnershipCounts;
};

export type OwnershipCoverage = {
  readonly lastPassAt: number | null;
  readonly lastDurationMs: number;
  readonly rootsTotal: number;
  readonly rootsCovered: number;
  readonly rootsWithRemote: number;
  readonly filesCovered: number;
  readonly filesExcluded: number;
  readonly servicesBound: number;
  readonly ownersEmitted: number;
  readonly entitiesReaped: number;
};

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Parse entity metadata into counts, tolerating every shape the column has ever held:
 * absent, invalid JSON, a namespace holding neither shape, and the current namespaced
 * one. `readEntityMetadata` isolates the `"ownership"` namespace (V54 wraps every
 * pre-existing row as `{"ownership": …}`, so a migrated legacy row parses the same way
 * as a freshly-written one); everything else here is unchanged from before namespacing.
 */
export function parseCounts(raw: string | null): OwnershipCounts {
  const absent: OwnershipCounts = { ownerCount: null, ownersAboveFloor: null, truncated: null };
  const m = readEntityMetadata(raw, "ownership");
  if (m === null) return absent;
  const aboveFloor = numberOrNull(m["ownersAboveFloor"]);
  return {
    ownerCount: numberOrNull(m["ownerCount"]),
    ownersAboveFloor: aboveFloor,
    // Gated on `ownersAboveFloor` being present, NOT on `truncated` being present. A
    // pre-split row has a `truncated` boolean whose meaning is wrong; reporting it would
    // put a false "showing top N of M" in front of the reader, which is the exact defect
    // this read surface exists to stop repeating.
    truncated: aboveFloor === null ? null : m["truncated"] === true,
  };
}

function findEntity(db: Database, type: string, externalId: string): OwnershipEntity | null {
  const row = db
    .query("SELECT id, label, metadata FROM graph_entity WHERE type = ? AND external_id = ?")
    .get(type, externalId) as { id: string; label: string; metadata: string | null } | null;
  if (row === null) return null;
  return { id: row.id, label: row.label, counts: parseCounts(row.metadata) };
}

export function findFileEntity(
  db: Database,
  repoRoot: string,
  relPath: string,
): OwnershipEntity | null {
  return findEntity(db, "source_file", `file:${repoRoot}:${relPath}`);
}

export function findDirectoryEntity(
  db: Database,
  repoRoot: string,
  relPath: string,
): OwnershipEntity | null {
  return findEntity(db, "directory", `dir:${repoRoot}:${relPath}`);
}

export function findServiceEntity(db: Database, serviceId: string): OwnershipEntity | null {
  return findEntity(db, "service", `service:${serviceId}`);
}

/** Owners of one target, ranked. Ties break on external id ascending, matching the writer. */
export function ownersOf(db: Database, entityId: string): OwnershipOwner[] {
  const rows = db
    .query(
      `SELECT p.external_id AS external_id, p.label AS label, r.weight AS weight
         FROM graph_relation r
         JOIN graph_entity p ON p.id = r.from_id AND p.type = 'person'
        WHERE r.to_id = ? AND r.type = 'owns'
        ORDER BY r.weight DESC, p.external_id ASC`,
    )
    .all(entityId) as Array<{ external_id: string; label: string; weight: number }>;
  return rows.map((r) => ({
    externalId: r.external_id,
    label: r.label,
    share: r.weight,
    resolved: !r.external_id.startsWith("git:"),
  }));
}

/**
 * The service a root rolls up to: `workspace --tracks_remote--> repo --belongs_to--> service`.
 *
 * BOTH endpoints of BOTH hops are type-scoped. `belongs_to` is not ours alone —
 * `graph/graph-populator.ts` emits `issue --belongs_to--> repo` and
 * `message --belongs_to--> channel` — so an unscoped walk would surface an issue as a
 * service, or a channel as one.
 */
export function serviceForRoot(db: Database, repoRoot: string): string | null {
  const row = db
    .query(
      `SELECT s.label AS id
         FROM graph_entity w
         JOIN graph_relation tr ON tr.from_id = w.id AND tr.type = 'tracks_remote'
         JOIN graph_entity rp   ON rp.id = tr.to_id  AND rp.type = 'repo'
         JOIN graph_relation bt ON bt.from_id = rp.id AND bt.type = 'belongs_to'
         JOIN graph_entity s    ON s.id = bt.to_id   AND s.type = 'service'
        WHERE w.type = 'workspace' AND w.external_id = ?
        ORDER BY s.label ASC
        LIMIT 1`,
    )
    .get(`filesystem:${repoRoot}`) as { id: string } | null;
  return row === null ? null : row.id;
}

/**
 * The service an indexed item rolls up to: `item --belongs_to--> repo --belongs_to--> service`.
 *
 * The sibling of `serviceForRoot` above, entered from an item rather than a filesystem
 * root — and type-scoped on every endpoint for the same reason its doc gives: `belongs_to`
 * is not ours alone, so an unscoped walk would surface a channel as a service.
 *
 * The first hop is the edge `syncIssueGraph` writes; the second is the ownership pass's.
 * Both must already exist — this reads the graph, it binds nothing.
 */
export function serviceForItemEntity(db: Database, itemEntityId: string): string | null {
  const row = db
    .query(
      `SELECT s.label AS id
         FROM graph_relation ib
         JOIN graph_entity rp   ON rp.id = ib.to_id   AND rp.type = 'repo'
         JOIN graph_relation bt ON bt.from_id = rp.id AND bt.type = 'belongs_to'
         JOIN graph_entity s    ON s.id = bt.to_id    AND s.type = 'service'
        WHERE ib.from_id = ? AND ib.type = 'belongs_to'
        ORDER BY s.label ASC
        LIMIT 1`,
    )
    .get(itemEntityId) as { id: string } | null;
  return row === null ? null : row.id;
}

/** Every service the last pass bound, sorted for a stable brief. */
export function listBoundServices(db: Database): string[] {
  const rows = db
    .query("SELECT label FROM graph_entity WHERE type = 'service' ORDER BY label ASC")
    .all() as Array<{ label: string }>;
  return rows.map((r) => r.label);
}

const EMPTY_COVERAGE: OwnershipCoverage = {
  lastPassAt: null,
  lastDurationMs: 0,
  rootsTotal: 0,
  rootsCovered: 0,
  rootsWithRemote: 0,
  filesCovered: 0,
  filesExcluded: 0,
  servicesBound: 0,
  ownersEmitted: 0,
  entitiesReaped: 0,
};

/** The single-row pass-state watermark, or an all-zero record when no pass has run. */
export function readOwnershipCoverage(db: Database): OwnershipCoverage {
  const row = db
    .query(
      `SELECT last_pass_at, last_duration_ms, roots_total, roots_covered, roots_with_remote,
              files_covered, files_excluded, services_bound, owners_emitted, entities_reaped
         FROM ownership_pass_state WHERE id = 1`,
    )
    .get() as Record<string, number | null> | null;
  if (row === null) return EMPTY_COVERAGE;
  return {
    lastPassAt: numberOrNull(row["last_pass_at"]),
    lastDurationMs: numberOrNull(row["last_duration_ms"]) ?? 0,
    rootsTotal: numberOrNull(row["roots_total"]) ?? 0,
    rootsCovered: numberOrNull(row["roots_covered"]) ?? 0,
    rootsWithRemote: numberOrNull(row["roots_with_remote"]) ?? 0,
    filesCovered: numberOrNull(row["files_covered"]) ?? 0,
    filesExcluded: numberOrNull(row["files_excluded"]) ?? 0,
    servicesBound: numberOrNull(row["services_bound"]) ?? 0,
    ownersEmitted: numberOrNull(row["owners_emitted"]) ?? 0,
    entitiesReaped: numberOrNull(row["entities_reaped"]) ?? 0,
  };
}
