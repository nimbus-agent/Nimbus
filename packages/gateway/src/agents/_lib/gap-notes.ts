import type { Database } from "bun:sqlite";
import type { GapNote } from "./findings.ts";

const ENTITY_TYPE_REMEDIATIONS: Readonly<Record<string, string>> = Object.freeze({
  dashboard: "Phase 5 Wave D will populate `dashboard` via Metabase / Superset connectors.",
  data_model: "Phase 5 Wave D will populate `data_model` via dbt-schema / warehouse connectors.",
  upstream_refs: "Phase 5 Wave D will populate `upstream_refs` alongside data-warehouse coverage.",
  incident:
    "Run `nimbus connector sync pagerduty`. Incidents indexed before attribution shipped carry " +
    "no actor emails — `nimbus index rebody --service pagerduty` re-fetches them.",
  alert: "Tracked as a graph-populator follow-up on existing observability connectors.",
  pipeline_run: "Tracked as a graph-populator follow-up on the existing CI/CD connectors.",
});

export function remediationForEntityType(kind: string): string | undefined {
  return ENTITY_TYPE_REMEDIATIONS[kind];
}

export function detectEmptyIndex(db: Database): GapNote | null {
  const row = db.query("SELECT 1 AS n FROM item LIMIT 1").get() as { n?: number } | null;
  if (row !== null) return null;
  return {
    category: "empty_index",
    detail: "No items in the local index yet.",
    remediation: "Run `nimbus connector sync <service>` for at least one connector.",
  };
}

export function detectMissingConnector(db: Database, service: string): GapNote | null {
  const row = db
    .query("SELECT 1 AS n FROM sync_state WHERE connector_id = ? LIMIT 1")
    .get(service) as { n?: number } | null;
  if (row !== null) return null;
  return {
    category: "missing_connector",
    detail: `No sync_state row for service \`${service}\`.`,
    remediation: `Run \`nimbus connector auth ${service}\` to register and sync.`,
  };
}

export function detectMissingEntityType(db: Database, type: string): GapNote | null {
  const row = db.query("SELECT 1 AS n FROM graph_entity WHERE type = ? LIMIT 1").get(type) as {
    n?: number;
  } | null;
  if (row !== null) return null;
  const remediation = remediationForEntityType(type);
  const note: GapNote = {
    category: "missing_entity_type",
    detail: `No \`${type}\` graph entities — 0 ${type}s considered.`,
  };
  if (remediation !== undefined) note.remediation = remediation;
  return note;
}

export function detectMissingRelationEmit(
  db: Database,
  relationType: string,
  remediation?: string,
): GapNote | null {
  const row = db
    .query("SELECT 1 AS n FROM graph_relation WHERE type = ? LIMIT 1")
    .get(relationType) as { n?: number } | null;
  if (row !== null) return null;
  const note: GapNote = {
    category: "missing_relation_emit",
    detail: `\`${relationType}\` edges are defined in the schema but not yet emitted by the graph populator.`,
  };
  if (remediation !== undefined) note.remediation = remediation;
  return note;
}

/**
 * I-2: like `detectMissingRelationEmit`, but scoped to edges of `relationType`
 * whose TARGET is `targetEntityType`. `detectMissingRelationEmit` probes for
 * *any* `graph_relation` row of the given type, of any endpoint shape — and
 * `resolves` now has TWO emitters with different endpoint shapes
 * (`pr -> issue` from `syncPrGraph`, `person -> incident` from
 * `syncIncidentPersonEdges`), so that broad probe finds the unrelated edge and
 * the gap note for the lane that still has nothing goes silently missing.
 * Scoping to the endpoint the caller's lane actually reads keeps the two
 * independent.
 */
export function detectMissingRelationToEntityType(
  db: Database,
  relationType: string,
  targetEntityType: string,
  remediation?: string,
): GapNote | null {
  const row = db
    .query(
      `SELECT 1 AS n
         FROM graph_relation r
         JOIN graph_entity e ON e.id = r.to_id
        WHERE r.type = ? AND e.type = ?
        LIMIT 1`,
    )
    .get(relationType, targetEntityType) as { n?: number } | null;
  if (row !== null) return null;
  const note: GapNote = {
    category: "missing_relation_emit",
    detail: `\`${relationType}\` edges targeting \`${targetEntityType}\` are defined in the schema but not yet emitted by the graph populator.`,
  };
  if (remediation !== undefined) note.remediation = remediation;
  return note;
}

export function aggregateMissingEntityTypes(notes: GapNote[]): GapNote[] {
  const missing = notes.filter((n) => n.category === "missing_entity_type");
  if (missing.length < 2) return notes;
  const others = notes.filter((n) => n.category !== "missing_entity_type");
  const kinds = missing.map((n) => {
    const m = /`([^`]+)`/.exec(n.detail);
    return m?.[1] ?? "?";
  });
  const remediations = Array.from(new Set(missing.map((n) => n.remediation).filter(Boolean)));
  const kindList = kinds.map((k) => `\`${k}\``).join(" / ");
  const combined: GapNote = {
    category: "missing_entity_type",
    detail: `${missing.length} categories blocked: ${kindList}`,
  };
  if (remediations.length > 0) combined.remediation = remediations.join(" ");
  return [...others, combined];
}
