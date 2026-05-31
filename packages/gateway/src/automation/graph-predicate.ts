import type { Database } from "bun:sqlite";
import { deterministicGraphEntityId, traverseGraph } from "../graph/relationship-graph.ts";

export const GRAPH_RELATION_KINDS = ["owned_by", "upstream_of", "downstream_of"] as const;
export type GraphRelationKind = (typeof GRAPH_RELATION_KINDS)[number];

export type GraphTarget = {
  type: string;
  externalId: string;
};

export type GraphPredicate = {
  relation: GraphRelationKind;
  target: GraphTarget;
};

export type ParseGraphPredicateResult =
  | { ok: true; predicate: GraphPredicate }
  | { ok: false; error: string };

const OWNED_BY_UNDERLYING = ["authored", "opened", "posted"] as const;
const UPSTREAM_UNDERLYING = [
  "belongs_to",
  "targets",
  "in_repo",
  "defined_in",
  "depends_on",
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isGraphRelationKind(v: unknown): v is GraphRelationKind {
  return typeof v === "string" && (GRAPH_RELATION_KINDS as readonly string[]).includes(v);
}

function validateTarget(raw: unknown): GraphTarget | string {
  if (!isRecord(raw)) {
    return "target must be an object";
  }
  const type = raw["type"];
  if (typeof type !== "string" || type.trim() === "") {
    return "target.type must be a non-empty string";
  }
  const externalId = raw["externalId"];
  if (typeof externalId !== "string" || externalId.trim() === "") {
    return "target.externalId must be a non-empty string";
  }
  return { type: type.trim(), externalId: externalId.trim() };
}

export function parseGraphPredicate(json: string): ParseGraphPredicateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "graph_predicate_json is not valid JSON" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: "graph_predicate_json must be a JSON object" };
  }
  const relation = parsed["relation"];
  if (!isGraphRelationKind(relation)) {
    return {
      ok: false,
      error: `relation must be one of ${GRAPH_RELATION_KINDS.join(", ")}`,
    };
  }
  const targetResult = validateTarget(parsed["target"]);
  if (typeof targetResult === "string") {
    return { ok: false, error: targetResult };
  }
  return { ok: true, predicate: { relation, target: targetResult } };
}

export type CandidateRelation = {
  relation: GraphRelationKind;
  description: string;
  underlyingRelationTypes: readonly string[];
};

export function listCandidateGraphRelations(): readonly CandidateRelation[] {
  return [
    {
      relation: "owned_by",
      description: "Item was authored, opened, or posted by the target person.",
      underlyingRelationTypes: OWNED_BY_UNDERLYING,
    },
    {
      relation: "upstream_of",
      description: "Item has a direct outgoing edge to the target entity.",
      underlyingRelationTypes: UPSTREAM_UNDERLYING,
    },
    {
      relation: "downstream_of",
      description: "Target entity has a direct outgoing edge to the item.",
      underlyingRelationTypes: UPSTREAM_UNDERLYING,
    },
  ];
}

export type ItemMatchContext = {
  db: Database;
  itemEntityType: string;
  itemExternalId: string;
  predicate: GraphPredicate;
};

function edgeMatchesDirection(
  rel: { from_id: string; to_id: string },
  relation: GraphRelationKind,
  itemEntityId: string,
  targetEntityId: string,
): boolean {
  if (relation === "upstream_of") {
    return rel.from_id === itemEntityId && rel.to_id === targetEntityId;
  }
  return rel.from_id === targetEntityId && rel.to_id === itemEntityId;
}

export function itemMatchesGraphPredicate(ctx: ItemMatchContext): boolean {
  const { db, itemEntityType, itemExternalId, predicate } = ctx;
  const itemEntityId = deterministicGraphEntityId(itemEntityType, itemExternalId);
  const targetEntityId = deterministicGraphEntityId(
    predicate.target.type,
    predicate.target.externalId,
  );
  const typeFilter = predicate.relation === "owned_by" ? OWNED_BY_UNDERLYING : UPSTREAM_UNDERLYING;
  const traversal = traverseGraph(db, itemEntityId, {
    depth: 1,
    relationTypes: [...typeFilter],
  });
  if ("error" in traversal) {
    return false;
  }
  return traversal.relations.some((rel) =>
    edgeMatchesDirection(rel, predicate.relation, itemEntityId, targetEntityId),
  );
}

export type ValidateCountContext = {
  db: Database;
  predicate: GraphPredicate;
  sinceMs: number;
  maxScan?: number;
};

export function countItemsMatchingGraphPredicate(ctx: ValidateCountContext): number {
  const { db, predicate, sinceMs } = ctx;
  const maxScan = ctx.maxScan ?? 5_000;
  const candidates = db
    .query(
      `SELECT id, service, type, external_id FROM item
       WHERE modified_at > ?
       ORDER BY modified_at DESC
       LIMIT ?`,
    )
    .all(sinceMs, maxScan) as Array<{
    id: string;
    service: string;
    type: string;
    external_id: string;
  }>;
  let count = 0;
  for (const row of candidates) {
    if (
      itemMatchesGraphPredicate({
        db,
        itemEntityType: row.type,
        itemExternalId: row.external_id,
        predicate,
      })
    ) {
      count += 1;
    }
  }
  return count;
}
