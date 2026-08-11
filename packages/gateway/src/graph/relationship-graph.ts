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

export function upsertGraphEntity(
  db: Database,
  row: {
    type: string;
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
