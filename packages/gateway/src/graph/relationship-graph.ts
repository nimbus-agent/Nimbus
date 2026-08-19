import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { dbRun } from "../db/write.ts";

const ITEM_LINKED_ENTITY_TYPES = [
  "pr",
  "issue",
  "ci_run",
  "deployment",
  "alert",
  "message",
  "incident",
  "error_issue",
  "git_commit",
  "dependency",
  "api_endpoint",
  "code_symbol",
  "obsidian_note",
  "data_model",
  "dashboard",
  "data_quality_test",
  "review",
] as const;

export type ItemLinkedEntityType = (typeof ITEM_LINKED_ENTITY_TYPES)[number];

export function isItemLinkedGraphType(t: string): t is ItemLinkedEntityType {
  return (ITEM_LINKED_ENTITY_TYPES as readonly string[]).includes(t);
}

export function deterministicGraphEntityId(type: string, externalId: string): string {
  return createHash("sha256").update(`nimbus.graph.v1\0${type}\0${externalId}`).digest("hex");
}

export type GraphEntityRow = {
  id: string;
  type: string;
  external_id: string;
  label: string;
  service: string | null;
  metadata: string | null;
};

export type GraphRelationRow = {
  type: string;
  from_id: string;
  to_id: string;
};

/** `never` for a co-owned literal, so `upsertGraphEntity({ type: "source_file" })` fails to compile. */
type NonCoOwnedType<T extends string> = T extends CoOwnedEntityType ? never : T;

export function upsertGraphEntity<T extends string>(
  db: Database,
  row: {
    type: NonCoOwnedType<T>;
    externalId: string;
    label: string;
    service?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): string {
  const id = deterministicGraphEntityId(row.type, row.externalId);
  const meta =
    row.metadata === undefined || row.metadata === null ? null : JSON.stringify(row.metadata);
  dbRun(
    db,
    `INSERT INTO graph_entity (id, type, external_id, label, service, metadata)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (type, external_id) DO UPDATE SET
       label = excluded.label,
       service = excluded.service,
       metadata = excluded.metadata`,
    [id, row.type, row.externalId, row.label, row.service ?? null, meta],
  );
  return id;
}

/**
 * Subsystems permitted to own a namespace inside `graph_entity.metadata`.
 *
 * A CLOSED union on purpose: a free-form string would let a typo silently create a fifth
 * namespace that nothing ever reads, which looks identical to data loss. Sub-project B adds
 * `"changed_files"` here when it lands, as a deliberate edit.
 */
export type EntityMetadataWriter = "ownership" | "symbols";

/**
 * Entity types whose metadata is namespaced. Every other type has a single writer and keeps
 * flat metadata (design D2).
 *
 * Resolved from the tree, not guessed — and the tree does NOT say all four are co-owned:
 * `ownership/ownership-pass.ts` and `graph/graph-populator.ts` both write `source_file`,
 * `person` and `service`, but `directory` is written by `ownership-pass.ts` ALONE
 * (`graph-populator.ts` contains no `directory` write at all). `directory` is namespaced for
 * uniformity, so this list is derived from one rule rather than being a hand-picked set of
 * three plus an exception — and so it already holds if a second `directory` writer appears.
 * Do not restate this as "both write all four": that was the original claim here and it was
 * false. See the design spec § 3 for the per-type verification.
 */
export const CO_OWNED_ENTITY_TYPES = ["source_file", "directory", "person", "service"] as const;

/**
 * DERIVED from the array above, never written as a second literal list. Step 4b's compile-time
 * guard and this runtime array must never disagree about which types are co-owned; two hand-kept
 * lists of the same four strings drift the moment a fifth type is added to one of them.
 */
export type CoOwnedEntityType = (typeof CO_OWNED_ENTITY_TYPES)[number];

/**
 * Upsert an entity whose metadata is co-owned, merging the caller's namespace into whatever
 * is already there instead of replacing the column.
 *
 * Sibling top-level keys (other writers' namespaces) are always left untouched — that part of
 * `json_patch`'s top-level merge is exactly as advertised. But `json_patch` implements RFC 7396
 * merge patch, which is RECURSIVE: patching an existing namespace object merges into it key by
 * key rather than replacing it outright, so a stale field from a prior write of the SAME writer
 * would survive a call that no longer mentions it (verified directly against this repo's
 * `bun:sqlite`). A writer replacing its own namespace wholesale therefore needs two `json_patch`
 * calls — first delete the writer's own key entirely (`{writer: null}`, itself a `json_patch`
 * null-delete), then set it fresh from an absent key, which is the same shape as a first-ever
 * write and cannot leak old fields forward.
 *
 * The identical two-step patch is applied on the INSERT branch too (via `json_patch('{}', ...)`
 * rather than binding the raw JSON string): an `ON CONFLICT DO UPDATE`'s `VALUES` clause is
 * evaluated even when no conflict occurs and would otherwise store a `null` field verbatim
 * instead of dropping it, since only the `DO UPDATE SET` branch went through `json_patch` at all
 * in an earlier draft of this function (caught by the brief's own null-deletion test, which
 * exercises exactly a first insert).
 *
 * CAUTION, verified rather than assumed: `json_patch` treats a JSON `null` VALUE as a DELETE
 * instruction. `json_patch('{"ownership":{"a":1}}','{"symbols":{"b":null}}')` yields
 * `{"ownership":{"a":1},"symbols":{}}` — `b` is gone, not stored. Never write `null` inside a
 * namespace; omit the key instead, and record "computed and found nothing" as an explicit
 * non-null field such as a `0` or a boolean.
 */
export function upsertGraphEntityNamespaced(
  db: Database,
  row: {
    type: string;
    externalId: string;
    label: string;
    service?: string | null;
    writer: EntityMetadataWriter;
    metadata: Record<string, unknown>;
  },
): string {
  const id = deterministicGraphEntityId(row.type, row.externalId);
  const clearPatch = JSON.stringify({ [row.writer]: null });
  const setPatch = JSON.stringify({ [row.writer]: row.metadata });
  dbRun(
    db,
    `INSERT INTO graph_entity (id, type, external_id, label, service, metadata)
     VALUES (?, ?, ?, ?, ?, json_patch('{}', ?))
     ON CONFLICT (type, external_id) DO UPDATE SET
       label = excluded.label,
       service = excluded.service,
       metadata = json_patch(json_patch(COALESCE(graph_entity.metadata, '{}'), ?), ?)`,
    [id, row.type, row.externalId, row.label, row.service ?? null, setPatch, clearPatch, setPatch],
  );
  return id;
}

/**
 * Read one writer's namespace out of a raw `graph_entity.metadata` value.
 *
 * Returns `null` for: a null column, unparseable JSON, a non-object root, an absent
 * namespace, or a namespace holding a non-object. `graph_entity.metadata` is written by many
 * paths, so a parse failure must degrade to "no metadata" rather than break a read.
 *
 * DELIBERATELY NO FLAT FALLBACK. Treating un-namespaced metadata as the `ownership`
 * namespace was considered and rejected: a flat write landing on a co-owned type produces
 * exactly that shape, and so does a skipped V54 — the fallback would render both as valid
 * data instead of surfacing them. See the design spec § 5.2.
 */
export function readEntityMetadata(
  raw: string | null,
  writer: EntityMetadataWriter,
): Record<string, unknown> | null {
  if (raw === null || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const ns = (parsed as Record<string, unknown>)[writer];
  if (ns === undefined || ns === null || typeof ns !== "object" || Array.isArray(ns)) {
    return null;
  }
  return ns as Record<string, unknown>;
}

/**
 * Inserts a graph entity only when no row with the same (type, external_id)
 * already exists.  Use this for reference/stub nodes created by a connector
 * that does NOT own the entity, so an existing real node's label/service is
 * never overwritten.
 */
export function ensureGraphEntity(
  db: Database,
  row: {
    type: string;
    externalId: string;
    label: string;
    service?: string | null;
  },
): string {
  const id = deterministicGraphEntityId(row.type, row.externalId);
  dbRun(
    db,
    `INSERT INTO graph_entity (id, type, external_id, label, service, metadata)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT (type, external_id) DO NOTHING`,
    [id, row.type, row.externalId, row.label, row.service ?? null],
  );
  return id;
}

export function upsertGraphRelation(
  db: Database,
  fromId: string,
  toId: string,
  relationType: string,
  createdAt: number,
  weight = 1,
): void {
  dbRun(
    db,
    `INSERT INTO graph_relation (from_id, to_id, type, weight, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (from_id, to_id, type) DO UPDATE SET
       weight = excluded.weight,
       created_at = excluded.created_at`,
    [fromId, toId, relationType, weight, createdAt],
  );
}

export function deleteGraphEntitiesForItemKeys(db: Database, itemPrimaryKeys: string[]): void {
  if (itemPrimaryKeys.length === 0) {
    return;
  }
  const placeholders = itemPrimaryKeys.map(() => "?").join(",");
  const types = [...ITEM_LINKED_ENTITY_TYPES];
  const typePlaceholders = types.map(() => "?").join(",");
  dbRun(
    db,
    `DELETE FROM graph_entity
     WHERE external_id IN (${placeholders})
       AND type IN (${typePlaceholders})`,
    [...itemPrimaryKeys, ...types],
  );
}

function graphRelationDedupeKey(r: GraphRelationRow): string {
  return `${r.from_id}|${r.type}|${r.to_id}`;
}

function addUniqueGraphRelation(relationsOut: GraphRelationRow[], r: GraphRelationRow): void {
  const key = graphRelationDedupeKey(r);
  if (!relationsOut.some((x) => graphRelationDedupeKey(x) === key)) {
    relationsOut.push(r);
  }
}

function tryEnqueueGraphNeighbor(
  visitedEntityIds: Set<string>,
  frontier: Array<{ id: string; d: number }>,
  maxNodes: number,
  neighbor: string,
  nextDepth: number,
): void {
  if (visitedEntityIds.has(neighbor)) {
    return;
  }
  if (visitedEntityIds.size >= maxNodes) {
    return;
  }
  visitedEntityIds.add(neighbor);
  frontier.push({ id: neighbor, d: nextDepth });
}

type GraphBfsExpandContext = {
  db: Database;
  cur: { id: string; d: number };
  maxDepth: number;
  maxNodes: number;
  typeFilter: string[] | null;
  visitedEntityIds: Set<string>;
  frontier: Array<{ id: string; d: number }>;
  relationsOut: GraphRelationRow[];
};

function expandGraphEdgesFromNode(ctx: GraphBfsExpandContext): void {
  const { db, cur, maxDepth, maxNodes, typeFilter, visitedEntityIds, frontier, relationsOut } = ctx;
  if (cur.d >= maxDepth) {
    return;
  }
  let relSql = `SELECT type, from_id, to_id FROM graph_relation WHERE from_id = ? OR to_id = ?`;
  const relParams: Array<string | number> = [cur.id, cur.id];
  if (typeFilter !== null && typeFilter.length > 0) {
    const ph = typeFilter.map(() => "?").join(",");
    relSql += ` AND type IN (${ph})`;
    relParams.push(...typeFilter);
  }
  const rels = db.query(relSql).all(...relParams) as GraphRelationRow[];
  for (const r of rels) {
    addUniqueGraphRelation(relationsOut, r);
    const neighbor = r.from_id === cur.id ? r.to_id : r.from_id;
    tryEnqueueGraphNeighbor(visitedEntityIds, frontier, maxNodes, neighbor, cur.d + 1);
  }
}

function bfsCollectGraphRelations(
  db: Database,
  startId: string,
  maxDepth: number,
  maxNodes: number,
  typeFilter: string[] | null,
): { visitedEntityIds: Set<string>; relationsOut: GraphRelationRow[] } {
  const visitedEntityIds = new Set<string>([startId]);
  const frontier: Array<{ id: string; d: number }> = [{ id: startId, d: 0 }];
  const relationsOut: GraphRelationRow[] = [];

  while (frontier.length > 0) {
    const cur = frontier.shift();
    if (cur === undefined) {
      break;
    }
    expandGraphEdgesFromNode({
      db,
      cur,
      maxDepth,
      maxNodes,
      typeFilter,
      visitedEntityIds,
      frontier,
      relationsOut,
    });
  }

  return { visitedEntityIds, relationsOut };
}

function resolveStartEntityId(db: Database, startRef: string): string | null {
  const byPk = db.query("SELECT id FROM graph_entity WHERE id = ?").get(startRef) as
    | { id: string }
    | null
    | undefined;
  if (byPk?.id !== undefined) {
    return byPk.id;
  }
  const byExt = db
    .query(`SELECT id FROM graph_entity WHERE external_id = ? ORDER BY type LIMIT 1`)
    .get(startRef) as { id: string } | null | undefined;
  return byExt?.id ?? null;
}

export type TraverseGraphOptions = {
  relationTypes?: string[];
  depth?: number;
  maxNodes?: number;
};

export type TraverseGraphResult = {
  startEntityId: string;
  entities: GraphEntityRow[];
  relations: GraphRelationRow[];
};

export function traverseGraph(
  db: Database,
  startRef: string,
  opts?: TraverseGraphOptions,
): TraverseGraphResult | { error: string } {
  const maxDepth = opts?.depth === undefined ? 2 : Math.min(8, Math.max(0, opts.depth));
  const maxNodes = opts?.maxNodes === undefined ? 200 : Math.min(500, Math.max(1, opts.maxNodes));
  const typeFilter = opts?.relationTypes?.filter((t) => t.trim() !== "") ?? null;

  const startId = resolveStartEntityId(db, startRef);
  if (startId === null) {
    return { error: `No graph entity found for ref: ${startRef}` };
  }

  const { visitedEntityIds, relationsOut } = bfsCollectGraphRelations(
    db,
    startId,
    maxDepth,
    maxNodes,
    typeFilter,
  );

  const idList = [...visitedEntityIds];
  const placeholders = idList.map(() => "?").join(",");
  const entities = db
    .query(
      `SELECT id, type, external_id, label, service, metadata FROM graph_entity WHERE id IN (${placeholders})`,
    )
    .all(...idList) as GraphEntityRow[];

  return {
    startEntityId: startId,
    entities,
    relations: relationsOut,
  };
}
