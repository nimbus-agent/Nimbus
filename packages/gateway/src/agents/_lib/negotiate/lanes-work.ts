import type { Database } from "bun:sqlite";

import { decisionVisibilityFilter } from "../../../decisions/decision-store.ts";
import type { SourceMapping } from "../../../sources/source-mapping.ts";
import {
  type AgentActionExclusions,
  type AgentActionLane,
  agentActionsSummary,
  NO_AGENT_ACTIONS,
} from "../negotiate-agent-actions.ts";
import type {
  NegotiateDecisions,
  NegotiateIncidents,
  NegotiateOwnership,
  NegotiateTickets,
} from "../negotiate-types.ts";
import { evidenceRefsFor, NEGOTIATE_EVIDENCE_LIMIT, notExcluded } from "./evidence.ts";

/**
 * `opened`: `person --opened--> issue` (graph_relation), joined back to `item` for the
 * window cutoff. `closedByAuthoredPr`: `person --authored--> pr --resolves--> issue`,
 * `DISTINCT`-counted on the issue side so one PR resolving multiple issues (or, in
 * principle, multiple authored PRs resolving the same issue) does not double-count.
 * Windowed on the PR's `modified_at`, matching `laneAuthoredPrs`.
 */
export function laneTickets(
  db: Database,
  personId: string,
  sinceMs: number,
  agent: AgentActionExclusions[AgentActionLane] = NO_AGENT_ACTIONS.tickets,
): NegotiateTickets {
  const cutoff = Date.now() - sinceMs;
  const countOpened = (excluded: readonly string[]): number =>
    (
      db
        .query(
          `SELECT COUNT(*) AS n
             FROM graph_relation r
             JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
             JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'issue'
             JOIN item i          ON i.id = ie.external_id
            WHERE r.type = 'opened' AND pe.external_id = ? AND i.modified_at >= ?
              AND ${notExcluded("i.id")}`,
        )
        .get(personId, cutoff, JSON.stringify(excluded)) as { n: number }
    ).n;
  const opened = { n: countOpened(agent.itemIds) };
  const openedInFull = agent.itemIds.length === 0 ? opened.n : countOpened([]);

  const closed = db
    .query(
      `SELECT COUNT(DISTINCT res.to_id) AS n
         FROM graph_relation auth
         JOIN graph_entity pe   ON pe.id = auth.from_id AND pe.type = 'person'
         JOIN graph_entity pre  ON pre.id = auth.to_id  AND pre.type = 'pr'
         JOIN item pri          ON pri.id = pre.external_id
         JOIN graph_relation res ON res.from_id = pre.id AND res.type = 'resolves'
        WHERE auth.type = 'authored' AND pe.external_id = ? AND pri.modified_at >= ?`,
    )
    .get(personId, cutoff) as { n: number };

  const refs = evidenceRefsFor(
    db,
    `SELECT i.title AS title, COALESCE(i.canonical_url, i.url) AS url
       FROM graph_relation r
       JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
       JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'issue'
       JOIN item i          ON i.id = ie.external_id
      WHERE r.type = 'opened' AND pe.external_id = ? AND i.modified_at >= ?
        AND ${notExcluded("i.id")}
      ORDER BY i.modified_at DESC, i.id ASC
      LIMIT ?`,
    [personId, cutoff, JSON.stringify(agent.itemIds), NEGOTIATE_EVIDENCE_LIMIT],
  );
  return {
    opened: opened.n,
    closedByAuthoredPr: closed.n,
    evidence: { refs, total: opened.n },
    agentActions: agentActionsSummary(openedInFull, opened.n, agent.unmatched),
  };
}

/** Exported so tests can seed exactly-at / one-past the boundary without duplicating the magic
 * number. */
export const OWNERSHIP_LIMIT = 50;

/**
 * A graph read, never a `git_blame_line` scan (spec § 5.A0) — the ownership pass
 * (`ownership/ownership-pass.ts`) already did the expensive derivation and left `owns`
 * edges behind; this lane only aggregates them. `maxOwnersPerPath` bounds owners PER PATH,
 * not paths per owner, so a long-tenured person can carry thousands of `owns` edges —
 * hence the explicit `LIMIT` here and the directory/service-only aggregation (never files).
 */
export function laneOwnership(db: Database, personId: string): NegotiateOwnership {
  const rows = db
    .query(
      `SELECT te.type AS target_type, te.label AS label
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
         JOIN graph_entity te ON te.id = r.to_id
        WHERE r.type = 'owns'
          AND pe.external_id = ?
          AND te.type IN ('service', 'directory')
        ORDER BY r.weight DESC
        LIMIT ?`,
    )
    .all(personId, OWNERSHIP_LIMIT + 1) as Array<{ target_type: string; label: string }>;

  const truncated = rows.length > OWNERSHIP_LIMIT;
  const kept = truncated ? rows.slice(0, OWNERSHIP_LIMIT) : rows;
  const state = db.query("SELECT last_pass_at FROM ownership_pass_state WHERE id = 1").get() as {
    last_pass_at: number | null;
  } | null;

  return {
    services: kept.filter((r) => r.target_type === "service").map((r) => r.label),
    directories: kept.filter((r) => r.target_type === "directory").map((r) => r.label),
    lastPassAt: state?.last_pass_at ?? null,
    truncated,
    unmappedIdentitiesInIndex: countUnmappedOwnerIdentities(db),
  };
}

/**
 * A fact about the INDEX, never a guess about the SUBJECT. Matching `git:`-prefixed
 * entities to an explicit `--person` subject by name or email substring was proposed and
 * rejected (spec § 5.A0): a heuristic attribution is wrong in a document that may affect
 * someone's compensation, which is worse than an acknowledged gap. This count is always
 * true regardless of who the brief is about.
 */
function countUnmappedOwnerIdentities(db: Database): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM graph_entity
        WHERE type = 'person' AND external_id LIKE 'git:%'`,
    )
    .get() as { n: number };
  return row.n;
}

/**
 * `decision_record.source_item_id` joins to `item`, and the item's `author_id` gives the
 * decision's author — a join nothing under `decisions/` performs today. `obsidian-sync.ts`
 * and `teams-sync.ts` set no `authorId` at all, so a decision mined from either source
 * resolves to an item with `author_id IS NULL`; `unattributable` counts those rows rather
 * than silently dropping them from the denominator (spec § 8.2, Task 5 brief).
 */
export function laneDecisions(
  db: Database,
  personId: string,
  sinceMs: number,
  mapping: SourceMapping,
): NegotiateDecisions {
  const cutoff = Date.now() - sinceMs;
  // The same rows `nimbus decisions` shows. The inner `JOIN item` already drops orphans (an
  // orphan has no author to attribute), so of the fragment's arms only the mapping and the
  // `'agent'` one can matter here.
  const visible = decisionVisibilityFilter(mapping);
  const authored = db
    .query(
      `SELECT COUNT(*) AS n
         FROM decision_record d
         JOIN item i ON i.id = d.source_item_id
        WHERE d.status = 'extracted' AND d.decided_at >= ? AND i.author_id = ? AND ${visible.sql}`,
    )
    .get(cutoff, personId, ...visible.params) as { n: number };

  const unattributable = db
    .query(
      `SELECT COUNT(*) AS n
         FROM decision_record d
         JOIN item i ON i.id = d.source_item_id
        WHERE d.status = 'extracted' AND d.decided_at >= ? AND i.author_id IS NULL
          AND ${visible.sql}`,
    )
    .get(cutoff, ...visible.params) as { n: number };

  // Cited from `authored` ONLY. `d.statement` is nullable (a `pending` row has none, and an
  // `extracted` one can still be null if extraction produced nothing usable), so fall back to
  // the source item's title rather than rendering an empty bullet.
  const refs = evidenceRefsFor(
    db,
    `SELECT COALESCE(NULLIF(d.statement, ''), i.title) AS title,
            COALESCE(i.canonical_url, i.url) AS url
       FROM decision_record d
       JOIN item i ON i.id = d.source_item_id
      WHERE d.status = 'extracted' AND d.decided_at >= ? AND i.author_id = ? AND ${visible.sql}
      ORDER BY d.decided_at DESC, d.id ASC
      LIMIT ?`,
    [cutoff, personId, ...visible.params, NEGOTIATE_EVIDENCE_LIMIT],
  );
  return {
    authored: authored.n,
    unattributable: unattributable.n,
    evidence: { refs, total: authored.n },
  };
}

/**
 * A graph read: `person --resolves--> incident` and `person --assigned-->
 * incident`, joined back to `item` for the window cutoff — the same shape as
 * `laneTickets`. `COUNT(DISTINCT ie.id)` because one incident can carry both
 * edge types for the same person and must not count twice within a lane.
 */
export function laneIncidents(db: Database, personId: string, sinceMs: number): NegotiateIncidents {
  const cutoff = Date.now() - sinceMs;
  const countEdge = (relationType: string): number =>
    (
      db
        .query(
          `SELECT COUNT(DISTINCT ie.id) AS n
             FROM graph_relation r
             JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
             JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'incident'
             JOIN item i          ON i.id = ie.external_id
            WHERE r.type = ? AND pe.external_id = ? AND i.modified_at >= ?`,
        )
        .get(relationType, personId, cutoff) as { n: number }
    ).n;

  const unattributable = (
    db
      .query(
        `SELECT COUNT(*) AS n
           FROM item i
          WHERE i.type = 'incident'
            AND i.modified_at >= ?
            AND NOT EXISTS (
                  SELECT 1
                    FROM graph_entity ie
                    JOIN graph_relation r ON r.to_id = ie.id AND r.type IN ('assigned', 'resolves')
                   WHERE ie.type = 'incident' AND ie.external_id = i.id
                )`,
      )
      .get(cutoff) as { n: number }
  ).n;

  const resolved = countEdge("resolves");

  // Deliberately NOT `countEdge("assigned")` — that helper hardcodes
  // `ie.type = 'incident'` and would silently count the wrong population.
  const errorIssuesAssigned = (
    db
      .query(
        `SELECT COUNT(DISTINCT ie.id) AS n
           FROM graph_relation r
           JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
           JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'error_issue'
           JOIN item i          ON i.id = ie.external_id
          WHERE r.type = 'assigned' AND pe.external_id = ? AND i.modified_at >= ?`,
      )
      .get(personId, cutoff) as { n: number }
  ).n;

  const refs = evidenceRefsFor(
    db,
    `SELECT i.title AS title, COALESCE(i.canonical_url, i.url) AS url
       FROM graph_relation r
       JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
       JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'incident'
       JOIN item i          ON i.id = ie.external_id
      WHERE r.type = 'resolves' AND pe.external_id = ? AND i.modified_at >= ?
      ORDER BY i.modified_at DESC, i.id ASC
      LIMIT ?`,
    [personId, cutoff, NEGOTIATE_EVIDENCE_LIMIT],
  );

  return {
    resolved,
    assigned: countEdge("assigned"),
    unattributable,
    errorIssuesAssigned,
    evidence: { refs, total: resolved },
  };
}
