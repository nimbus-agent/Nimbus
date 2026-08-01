import type { Database } from "bun:sqlite";

import type { DecisionEvidence } from "./decision-types.ts";

/**
 * Asymmetric on purpose. Teams routinely ship first and formalise after — a
 * retro, a post-mortem, a wiki page updated the week following the merge. A
 * forward-only window would treat every one of those as uncorroborated and dock
 * it 0.35 confidence, which is exactly backwards.
 *
 * The cost is bounded: a thread referencing a recent PR as contrast can gain
 * confidence it has not earned, but only within 14 days AND only when a real
 * `mentions` / `merged_as` edge exists. Corroboration is never purely temporal.
 */
export const CORROBORATION_BACKWARD_MS = 14 * 24 * 60 * 60 * 1000;
export const CORROBORATION_FORWARD_MS = 90 * 24 * 60 * 60 * 1000;

const ADR_TITLE_RE = /\badr\b|^\d+[-.]|decision/iu;

const STOP = new Set(["the", "a", "an", "to", "of", "for", "and", "or", "on", "in", "we"]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

/** At least half the statement's significant tokens must appear in the title. */
function tokenOverlap(statement: string, title: string): boolean {
  const want = tokens(statement);
  if (want.length === 0) return false;
  const have = new Set(tokens(title));
  const hits = want.filter((t) => have.has(t)).length;
  return hits * 2 >= want.length;
}

export interface CorroborateInput {
  readonly decisionId: string;
  readonly sourceItemId: string;
  readonly decidedAt: number;
  readonly statement: string;
}

export function corroborate(db: Database, input: CorroborateInput): DecisionEvidence[] {
  const out: DecisionEvidence[] = [];

  const src = db
    .query("SELECT id, service, type, title, url, modified_at FROM item WHERE id = ?")
    .get(input.sourceItemId) as {
    id: string;
    service: string;
    type: string;
    title: string;
    url: string | null;
    modified_at: number;
  } | null;
  if (src !== null) {
    out.push({
      kind: "source",
      entityId: null,
      itemId: src.id,
      label: `${src.service}:${src.type} "${src.title}"`,
      url: src.url,
      occurredAt: src.modified_at,
    });
  }

  const lo = input.decidedAt - CORROBORATION_BACKWARD_MS;
  const hi = input.decidedAt + CORROBORATION_FORWARD_MS;
  const seenEntityIds = new Set<string>();

  // Code evidence, outgoing: PRs and commits the source item itself mentions,
  // or that the source item (when it is itself a PR entity) was merged as.
  // Both endpoints are type-scoped because `mentions` is polysemous. This is
  // what makes `commit` evidence reachable for chat-sourced decisions — the
  // graph populator only emits `mentions` from a message toward `issue`/
  // `commit` targets, never toward a `pr` target, so `pr` evidence from this
  // query alone would require the source item to literally be a PR.
  const code = db
    .query(
      `SELECT t.id AS entity_id, t.type AS entity_type, i.id AS item_id,
              i.title AS title, i.url AS url, i.modified_at AS modified_at
         FROM graph_relation r
         JOIN graph_entity s ON s.id = r.from_id
         JOIN graph_entity t ON t.id = r.to_id AND t.type IN ('pr','commit')
         LEFT JOIN item i ON i.id = t.external_id
        WHERE s.external_id = ?
          AND r.type IN ('mentions','merged_as')
          AND i.modified_at BETWEEN ? AND ?
        ORDER BY i.modified_at ASC
        LIMIT 20`,
    )
    .all(input.sourceItemId, lo, hi) as Array<{
    entity_id: string;
    entity_type: string;
    item_id: string | null;
    title: string | null;
    url: string | null;
    modified_at: number | null;
  }>;

  for (const c of code) {
    if (seenEntityIds.has(c.entity_id)) continue;
    seenEntityIds.add(c.entity_id);
    out.push({
      kind: c.entity_type === "pr" ? "pr" : "commit",
      entityId: c.entity_id,
      itemId: c.item_id,
      label: c.title ?? c.entity_id,
      url: c.url,
      occurredAt: c.modified_at,
    });
  }

  // Migration / IaC evidence is deliberately not derived here: it would read
  // `metadata.files` on the corroborating PR/commit item, but no connector
  // indexes changed-file paths yet, so both `EvidenceKind`s are unreachable
  // from any live data. Reinstate once a connector populates that metadata.

  // Code evidence, incoming: PRs that resolve the source item, for an
  // issue-sourced decision. `resolves` edges run PR -> issue (the populator
  // never emits the reverse), so from the issue's side this is an INCOMING
  // edge and has to be walked from `to_id`, not `from_id`. Both endpoints are
  // type-scoped because `resolves` is polysemous (also emitted
  // person -> incident elsewhere in the graph).
  const resolvedBy = db
    .query(
      `SELECT p.id AS entity_id, i.id AS item_id,
              i.title AS title, i.url AS url, i.modified_at AS modified_at
         FROM graph_relation r
         JOIN graph_entity src ON src.id = r.to_id AND src.type = 'issue' AND src.external_id = ?
         JOIN graph_entity p ON p.id = r.from_id AND p.type = 'pr'
         LEFT JOIN item i ON i.id = p.external_id
        WHERE r.type = 'resolves'
          AND i.modified_at BETWEEN ? AND ?
        ORDER BY i.modified_at ASC
        LIMIT 20`,
    )
    .all(input.sourceItemId, lo, hi) as Array<{
    entity_id: string;
    item_id: string | null;
    title: string | null;
    url: string | null;
    modified_at: number | null;
  }>;

  for (const r of resolvedBy) {
    if (seenEntityIds.has(r.entity_id)) continue;
    seenEntityIds.add(r.entity_id);
    out.push({
      kind: "pr",
      entityId: r.entity_id,
      itemId: r.item_id,
      label: r.title ?? r.entity_id,
      url: r.url,
      occurredAt: r.modified_at,
    });
  }

  // ADR: a long-form doc whose title looks like an ADR and shares most of its
  // significant tokens with the statement.
  //
  // The title shape is filtered in SQL, not in JS. An earlier draft selected an
  // unordered `LIMIT 500` and filtered afterwards, which is a silent-truncation
  // bug rather than a slow one: with more long-form pages than the cap, SQLite
  // returns an ARBITRARY 500 and a real ADR simply never gets considered — with
  // no way for the caller to know. Pushing the shape test down means the cap is
  // reached only by pages that already look like ADRs, and `ORDER BY` makes
  // which ones deterministic.
  const adrs = db
    .query(
      `SELECT id, title, url, modified_at FROM item
        WHERE (service || ':' || type) IN ('notion:page','confluence:page','obsidian:obsidian_note')
          AND (LOWER(title) LIKE '%adr%'
            OR LOWER(title) LIKE '%decision%'
            OR title GLOB '[0-9]*')
        ORDER BY modified_at DESC, id ASC
        LIMIT 200`,
    )
    .all() as Array<{ id: string; title: string; url: string | null; modified_at: number }>;
  for (const a of adrs) {
    if (!ADR_TITLE_RE.test(a.title)) continue;
    if (!tokenOverlap(input.statement, a.title)) continue;
    out.push({
      kind: "adr",
      entityId: null,
      itemId: a.id,
      label: a.title,
      url: a.url,
      occurredAt: a.modified_at,
    });
    break;
  }

  return out;
}

export function hasAdrEvidence(ev: readonly DecisionEvidence[]): boolean {
  return ev.some((e) => e.kind === "adr");
}
