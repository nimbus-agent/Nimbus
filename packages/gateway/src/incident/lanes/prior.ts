import type { Database } from "bun:sqlite";

import type { GapNote, PriorLane, PriorView } from "../incident-record-types.ts";
import { type TriggerFacts, triggerFacts } from "../trigger-facts.ts";
import { TRIGGER_SOURCES, type TriggerService } from "../trigger-sources.ts";
import { codeUnitCompare, gap, oneLine, PRIOR_CAP } from "./caps.ts";

/**
 * Lane 4, prior incidents (Phase 10 IC3, design C step 6): earlier triggers of ANY of the four trigger kinds
 * bound to the same service by the graph (`graph_entity.metadata.affectedService`), opened earlier than this
 * record, newest first, the trigger itself excluded. SAME SERVICE, not "similar": the index holds no alert-rule
 * id or fingerprint. How an earlier incident was resolved is not in the index (a gap says so).
 */

export type PriorResult = { readonly lane: PriorLane; readonly gaps: readonly GapNote[] };

const ENTITY_TYPES = ["incident", "alert", "error_issue", "data_quality_test"] as const;

const PAIR_CLAUSE = `(${TRIGGER_SOURCES.map(() => "(i.service = ? AND i.type = ?)").join(" OR ")})`;
const PAIR_PARAMS: string[] = TRIGGER_SOURCES.flatMap((s) => [s.service, s.type]);

// The entity's metadata may be malformed or absent: json_extract RAISES on bad JSON, so it is guarded.
const WHERE = `e.type IN (${ENTITY_TYPES.map(() => "?").join(",")})
  AND ${PAIR_CLAUSE}
  AND e.external_id <> ?
  AND CASE WHEN json_valid(e.metadata) THEN json_extract(e.metadata, '$.affectedService') END = ?
  AND CASE WHEN json_valid(e.metadata) THEN json_extract(e.metadata, '$.occurredAt') END < ?`;

type Row = {
  eid: string;
  id: string;
  service: string;
  itype: string;
  title: string;
  url: string | null;
  metadata: string | null;
  occurred: number | null;
};

function view(r: Row): PriorView {
  const facts: TriggerFacts = triggerFacts({
    service: r.service as TriggerService,
    metadata: r.metadata,
  });
  return {
    id: r.id,
    service: r.service,
    type: r.itype,
    title: oneLine(r.title),
    url: r.url,
    openedAtMs: r.occurred,
    status: facts.status,
    closedAtMs: facts.closedAtMs,
    closedBasis: facts.closedAtBasis,
    rule: "same_service_prior",
  };
}

export function skippedPrior(reason: "unbound" | "no_open_time"): PriorResult {
  return { lane: { skipped: reason, total: 0, incidents: [] }, gaps: [] };
}

/** Newest first; equal open times (or two unknown ones) fall back to the id, so the order is total. */
export function priorOrder(
  a: { readonly id: string; readonly openedAtMs: number | null },
  b: { readonly id: string; readonly openedAtMs: number | null },
): number {
  return a.openedAtMs === b.openedAtMs
    ? codeUnitCompare(a.id, b.id)
    : (b.openedAtMs ?? 0) - (a.openedAtMs ?? 0);
}

export function priorLane(
  db: Database,
  input: { readonly service: string; readonly triggerItemId: string; readonly openedAtMs: number },
): PriorResult {
  const params = [
    ...ENTITY_TYPES,
    ...PAIR_PARAMS,
    input.triggerItemId,
    input.service,
    input.openedAtMs,
  ];
  const total = (
    db
      .query(
        `SELECT count(*) AS n FROM graph_entity e JOIN item i ON i.id = e.external_id WHERE ${WHERE}`,
      )
      .get(...params) as { n: number }
  ).n;
  const rows = db
    .query(
      `SELECT e.id AS eid, i.id, i.service, i.type AS itype, i.title, i.url, i.metadata,
              CASE WHEN json_valid(e.metadata) THEN json_extract(e.metadata, '$.occurredAt') END AS occurred
         FROM graph_entity e JOIN item i ON i.id = e.external_id
        WHERE ${WHERE}
        ORDER BY occurred DESC, e.id ASC
        LIMIT ?`,
    )
    .all(...params, PRIOR_CAP) as Row[];
  const incidents = rows.map(view).sort(priorOrder);
  const gaps: GapNote[] = [
    gap(
      "missing_entity_type",
      "How any earlier incident was resolved is absent and cannot be listed: no connector indexes a resolution note, remediation step or post-mortem link. These entries say what happened on the same service and when, never what was done.",
    ),
  ];
  if (total === 0) {
    gaps.push(
      gap("missing_relation_emit", "No earlier trigger is recorded for this service in the graph."),
    );
  }
  return { lane: { skipped: null, total, incidents }, gaps };
}
