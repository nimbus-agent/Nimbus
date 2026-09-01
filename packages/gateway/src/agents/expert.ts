import type { Database } from "bun:sqlite";
import { AgentCoordinator, type SubTask } from "../engine/coordinator.ts";
import { resolveItemByUrl } from "../index/resolve-by-url.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { Evidence, ExpertBrief, ExpertFinding, GapNote } from "./_lib/findings.ts";
import {
  detectEmptyIndex,
  detectMissingConnector,
  detectMissingEntityType,
  detectMissingRelationEmit,
  detectMissingRelationToEntityType,
  remediationForEntityType,
} from "./_lib/gap-notes.ts";
import type { SynthesisRunner } from "./_lib/synthesis-llm.ts";

/**
 * Two arms, exactly one supplied — `requireExpertParams` enforces that on the wire.
 *
 * `topicOrFile` is free text, matched with `LIKE` against indexed titles and previews. It
 * answers "who has touched things that look like this".
 *
 * `itemUrl` names one indexed item and answers from the graph edges around it — a
 * different and narrower question. It exists because a browser knows the URL of the issue
 * you are reading, and handing that item's TITLE to the free-text arm would answer about
 * every item whose title merely resembles it.
 */
export type ExpertInput = {
  topicOrFile?: string;
  itemUrl?: string;
  limit?: number;
};

export type ExpertContext = {
  db: Database;
  runner?: SynthesisRunner;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
};

export type ExpertEvidenceStream = {
  personId: string;
  displayName: string;
  evidence: Evidence[];
};

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;

function bucketConfidence(score: number, evidenceCount: number): "high" | "medium" | "low" {
  if (score >= 0.7 && evidenceCount >= 3) return "high";
  if (score >= 0.3 && evidenceCount >= 1) return "medium";
  return "low";
}

export function rankExpertFindings(
  streams: ExpertEvidenceStream[],
  limit: number,
): ExpertFinding[] {
  const merged = new Map<string, { displayName: string; evidence: Evidence[] }>();
  for (const s of streams) {
    const existing = merged.get(s.personId);
    if (existing === undefined) {
      merged.set(s.personId, { displayName: s.displayName, evidence: [...s.evidence] });
    } else {
      existing.evidence.push(...s.evidence);
    }
  }
  const rawScores: Array<{ personId: string; finding: ExpertFinding; total: number }> = [];
  for (const [personId, m] of merged.entries()) {
    const total = m.evidence.reduce((acc, e) => acc + e.weight, 0);
    rawScores.push({
      personId,
      total,
      finding: {
        personId,
        displayName: m.displayName,
        evidence: m.evidence.toSorted((a, b) => b.modifiedAt - a.modifiedAt),
        score: 0, // filled below after normalisation
        confidence: "low",
      },
    });
  }
  rawScores.sort((a, b) => b.total - a.total);
  const max = rawScores[0]?.total ?? 0;
  for (const r of rawScores) {
    const normalised = max === 0 ? 0 : r.total / max;
    r.finding.score = normalised;
    r.finding.confidence = bucketConfidence(normalised, r.finding.evidence.length);
  }
  return rawScores.slice(0, Math.min(limit, MAX_LIMIT)).map((r) => r.finding);
}

type SubAgentResult = {
  stream?: ExpertEvidenceStream;
  gap?: GapNote;
};

/**
 * The row shape every expert lane's SQL projects. All five lanes select the
 * same six columns under the same aliases; naming the shape once is what lets
 * `topLaneStream` be shared between them.
 */
type ExpertLaneRow = {
  person_id: string;
  display_name: string;
  item_id: string;
  title: string;
  modified_at: number;
  service_id: string;
};

/** Titles are indexed at full length; an expert brief only ever shows a lead. */
const LANE_TITLE_MAX = 512;

/**
 * Fold one lane's rows into the single person carrying the most evidence in it.
 *
 * Every lane did this identically and inline, differing only in the evidence
 * `type` tag and its `weight` — five copies of the same twenty lines. The tie
 * break is `Array.prototype.sort`'s stability over Map insertion order, i.e.
 * the person whose first matching row came back earliest from the query, which
 * is what the inline copies did and is why the rows must not be re-ordered here.
 */
function topLaneStream(
  rows: readonly ExpertLaneRow[],
  type: Evidence["type"],
  weight: number,
): SubAgentResult {
  const merged = new Map<string, ExpertEvidenceStream>();
  for (const r of rows) {
    const ev: Evidence = {
      itemId: r.item_id,
      type,
      serviceId: r.service_id,
      title: r.title.slice(0, LANE_TITLE_MAX),
      modifiedAt: r.modified_at,
      weight,
    };
    const existing = merged.get(r.person_id);
    if (existing === undefined) {
      merged.set(r.person_id, {
        personId: r.person_id,
        displayName: r.display_name,
        evidence: [ev],
      });
    } else {
      existing.evidence.push(ev);
    }
  }
  const winner = [...merged.values()].sort((a, b) => b.evidence.length - a.evidence.length)[0];
  return winner === undefined ? {} : { stream: winner };
}

function makeSubAgent(
  taskType: "agent_step",
  fn: (db: Database, input: string) => Promise<SubAgentResult>,
  db: Database,
  input: string,
): SubTask {
  return {
    taskType,
    prompt: "",
    execute: async () => {
      const out = await fn(db, input);
      return { text: JSON.stringify(out), tokensIn: 0, tokensOut: 0 };
    },
  };
}

export async function runExpert(input: ExpertInput, ctx: ExpertContext): Promise<ExpertBrief> {
  const start = performance.now();
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  // `requireExpertParams` guarantees exactly one arm reaches here, so the fallback is
  // unreachable over the wire and exists only for a direct in-process caller.
  const topic = input.topicOrFile ?? "";

  const preflightGaps: GapNote[] = [];
  const empty = detectEmptyIndex(ctx.db);
  if (empty !== null) preflightGaps.push(empty);

  const coordinator = new AgentCoordinator({
    sessionId: ctx.sessionId,
    parentId: `expert:${ctx.sessionId}`,
    depth: 1,
    toolCallCount: { value: 0 },
  });

  // The two arms do NOT both run. Mixing an edge-backed answer with a lexical one in a
  // single ranked list would let a title coincidence outrank someone the graph actually
  // links to the item, and a reader could not tell which was which.
  const itemUrl = input.itemUrl;
  const tasks: SubTask[] =
    itemUrl === undefined
      ? [
          makeSubAgent("agent_step", subBlame, ctx.db, topic),
          makeSubAgent("agent_step", subPrAuthored, ctx.db, topic),
          makeSubAgent("agent_step", subPrReviewed, ctx.db, topic),
          makeSubAgent("agent_step", subIncidentResolved, ctx.db, topic),
          makeSubAgent("agent_step", subChatMentions, ctx.db, topic),
        ]
      : [
          makeSubAgent("agent_step", subItemOpened, ctx.db, itemUrl),
          makeSubAgent("agent_step", subItemResolvedBy, ctx.db, itemUrl),
        ];

  const results = await coordinator.run(tasks);

  const streams: ExpertEvidenceStream[] = [];
  const subAgentGaps: GapNote[] = [];
  for (const r of results) {
    if (r.status !== "done" || r.text === undefined) {
      const errorPart = r.errorText === undefined ? "" : `: ${r.errorText}`;
      subAgentGaps.push({
        category: "missing_connector",
        detail: `expert sub-agent #${r.taskIndex} failed${errorPart}`,
      });
      continue;
    }
    const decoded: SubAgentResult = JSON.parse(r.text);
    if (decoded.stream !== undefined) streams.push(decoded.stream);
    if (decoded.gap !== undefined) subAgentGaps.push(decoded.gap);
  }

  const ranked = rankExpertFindings(streams, limit);
  const brief: ExpertBrief = {
    kind: "expert",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps: [...preflightGaps, ...subAgentGaps],
    // `topicOrFile` stays REQUIRED on the wire, so on the item arm it carries the item
    // URL: a consumer reading only that field still learns what was asked about, rather
    // than an invented topic. `itemUrl` names the same subject under its own key, for a
    // consumer that wants to know the question was item-shaped without parsing a URL.
    query: itemUrl === undefined ? { topicOrFile: topic } : { topicOrFile: itemUrl, itemUrl },
    ranked,
  };
  return brief;
}

export function emitExpertBrief(
  input: ExpertInput,
  ctx: ExpertContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "expert.briefReady",
    briefErrorMethod: "expert.briefError",
    notify: ctx.notify,
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
    buildBrief: () => runExpert(input, ctx),
  });
}

/**
 * The `itemUrl` arm: people the graph links to this item, and the change that closed it.
 *
 * Three edge-backed signals, no `LIKE` anywhere:
 *
 * 1. `person --opened--> item` — the one person edge `syncIssueGraph` writes directly.
 * 2. the author of the PR that `resolves` the item — usually the strongest "who knows
 *    this" signal there is, and reachable only by walking `resolves` inward.
 * 3. reviewers of that same PR.
 *
 * An incident gets (2) and (3) only: `syncIncidentGraph` writes no person edge of its
 * own. That is a real bound, and the empty case reports a gap rather than pretending.
 */
function itemEntityFor(
  db: Database,
  itemUrl: string,
): { entityId: string; itemId: string; type: string; title: string } | null {
  const resolved = resolveItemByUrl(db, itemUrl);
  if (!resolved.found) return null;
  const item = resolved.item;
  const entity = db
    .query("SELECT id FROM graph_entity WHERE external_id = ? AND type = ? LIMIT 1")
    .get(item.id, item.type) as { id?: string } | null;
  if (entity?.id === undefined) return null;
  return { entityId: entity.id, itemId: item.id, type: item.type, title: item.title };
}

/** The gap both item lanes report when the URL names nothing the graph can answer about. */
function itemUnreachableGap(itemUrl: string): GapNote {
  return {
    category: "missing_entity_type",
    detail: `\`${itemUrl}\` does not resolve to an indexed item with a graph entity.`,
    remediation:
      "Sync the connector that owns this item. Some indexed types (a Confluence page, a CI run) carry no graph entity at all, and nothing can be linked to them.",
  };
}

/** `person --opened--> item`: the one person edge `syncIssueGraph` writes directly. */
async function subItemOpened(db: Database, itemUrl: string): Promise<SubAgentResult> {
  const target = itemEntityFor(db, itemUrl);
  if (target === null) return { gap: itemUnreachableGap(itemUrl) };

  const rows = db
    .query(
      `SELECT p.id AS person_id, COALESCE(p.display_name, p.id) AS display_name,
              i.id AS item_id, i.title AS title, i.modified_at AS modified_at,
              i.service AS service_id
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
         JOIN person p ON p.id = pe.external_id
         JOIN item i ON i.id = ?2
        WHERE r.to_id = ?1 AND r.type = 'opened'
        LIMIT 25`,
    )
    .all(target.entityId, target.itemId) as ExpertLaneRow[];

  if (rows.length === 0) {
    const gap = detectMissingRelationToEntityType(
      db,
      "opened",
      "person",
      "Issues emit `opened` when the connector records an author — sync it.",
    );
    return gap !== null ? { gap } : {};
  }
  return topLaneStream(rows, "issue_opened", 0.7);
}

/**
 * The author of the PR that `resolves` this item.
 *
 * Usually the strongest "who knows this" signal there is, and reachable only by walking
 * `resolves` INWARD — the inverse of the traversal every PR-shaped query here makes. An
 * incident reaches people through this lane alone: `syncIncidentGraph` writes no person
 * edge of its own, which is a real bound and why the empty case gaps rather than pretends.
 */
async function subItemResolvedBy(db: Database, itemUrl: string): Promise<SubAgentResult> {
  const target = itemEntityFor(db, itemUrl);
  if (target === null) return { gap: itemUnreachableGap(itemUrl) };

  const rows = db
    .query(
      `SELECT p.id AS person_id, COALESCE(p.display_name, p.id) AS display_name,
              pi.id AS item_id, pi.title AS title, pi.modified_at AS modified_at,
              pi.service AS service_id
         FROM graph_relation res
         JOIN graph_entity pe ON pe.id = res.from_id AND pe.type = 'pr'
         JOIN item pi ON pi.id = pe.external_id
         JOIN person p ON p.id = pi.author_id
        WHERE res.to_id = ? AND res.type = 'resolves'
        LIMIT 25`,
    )
    .all(target.entityId) as ExpertLaneRow[];

  if (rows.length === 0) {
    const gap = detectMissingRelationToEntityType(
      db,
      "resolves",
      "pr",
      "A PR emits `resolves` when its body references the item key — reference it, and sync.",
    );
    return gap !== null ? { gap } : {};
  }
  return topLaneStream(rows, "pr_authored", 0.8);
}

async function subBlame(db: Database, input: string): Promise<SubAgentResult> {
  const commits = db
    .query(
      `SELECT
         p.id                           AS person_id,
         COALESCE(p.display_name, p.id) AS display_name,
         i.id                           AS item_id,
         i.title                        AS title,
         i.modified_at                  AS modified_at,
         i.service                      AS service_id
       FROM item   i
       JOIN person p ON p.id = i.author_id
       WHERE i.service = 'github'
         AND i.type    = 'commit'
         AND (i.title LIKE '%' || ? || '%' OR i.body_preview LIKE '%' || ? || '%')
       ORDER BY i.modified_at DESC
       LIMIT 50`,
    )
    .all(input, input) as ExpertLaneRow[];

  if (commits.length === 0) {
    const gap = detectMissingConnector(db, "github");
    return gap === null ? {} : { gap };
  }

  return topLaneStream(commits, "commit_authored", 1);
}

async function subPrAuthored(db: Database, input: string): Promise<SubAgentResult> {
  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const rows = db
    .query(
      `SELECT
         p.id                           AS person_id,
         COALESCE(p.display_name, p.id) AS display_name,
         i.id                           AS item_id,
         i.title                        AS title,
         i.modified_at                  AS modified_at,
         i.service                      AS service_id
       FROM item   i
       JOIN person p ON p.id = i.author_id
       WHERE i.type = 'pr'
         AND i.modified_at >= ?
         AND (i.title LIKE '%' || ? || '%' OR i.body_preview LIKE '%' || ? || '%')
       ORDER BY i.modified_at DESC
       LIMIT 50`,
    )
    .all(ninetyDaysAgo, input, input) as ExpertLaneRow[];

  if (rows.length === 0) return {};

  return topLaneStream(rows, "pr_authored", 0.8);
}

/**
 * Resolution-aware probe for the `reviewed` lane.
 *
 * `detectMissingRelationEmit` only checks that *some* `graph_relation` row of
 * type `reviewed` exists — it does not require that row to resolve through
 * the person/pr/item join chain `subPrReviewed`'s real query needs. Without
 * this check, a `reviewed` edge whose `pr` graph_entity has no backing `item`
 * row (or whose `person` graph_entity has no backing `person` row) makes the
 * real query return 0 rows AND makes `detectMissingRelationEmit` report "all
 * clear" — the exact "silently empty instead of explaining itself"
 * regression `subIncidentResolved`'s neighbouring comment (see below) already
 * warns about, here triggered by partial-join failure rather than by zero
 * edges.
 *
 * Returns:
 *   - the "no `reviewed` edges at all" gap if none exist,
 *   - a distinct "edges exist but none resolve" gap if edges exist but the
 *     join chain never completes for any of them (a real indexing gap),
 *   - `null` if at least one edge resolves — the real query's zero-row
 *     result is then just "no match for this search topic", not a data gap.
 */
function detectUnresolvedReviewedRelation(db: Database): GapNote | null {
  const missingEmit = detectMissingRelationEmit(db, "reviewed");
  if (missingEmit !== null) {
    // `detectMissingRelationEmit`'s hard-coded detail ("not yet emitted by
    // the graph populator") is false for `reviewed` — `syncReviewGraph` does
    // emit it. Override with an honest, scoped detail/remediation instead of
    // changing the shared helper's detail for every other relation type.
    return {
      category: missingEmit.category,
      detail: "No `reviewed` edges yet — the GitHub connector has not indexed PR reviews.",
      remediation: "Sync the GitHub connector so PR reviews are indexed.",
    };
  }

  const resolvedRow = db
    .query(
      `SELECT 1 AS n
         FROM graph_relation gr
         JOIN graph_entity  pe  ON pe.id = gr.from_id AND pe.type = 'person'
         JOIN person        p   ON p.id = pe.external_id
         JOIN graph_entity  pre ON pre.id = gr.to_id AND pre.type = 'pr'
         JOIN item          i   ON i.id = pre.external_id
        WHERE gr.type = 'reviewed'
        LIMIT 1`,
    )
    .get() as { n?: number } | null;
  if (resolvedRow !== null) return null;

  return {
    category: "missing_relation_emit",
    detail:
      "`reviewed` edges exist in the graph but none resolve to an indexed PR and reviewer — the referenced PRs or reviewers are not (yet) indexed.",
    remediation: "Sync the GitHub connector so the reviewed PRs and their authors are indexed.",
  };
}

export async function subPrReviewed(db: Database, input: string): Promise<SubAgentResult> {
  const rows = db
    .query(
      `SELECT
         p.id                           AS person_id,
         COALESCE(p.display_name, p.id) AS display_name,
         i.id                           AS item_id,
         i.title                        AS title,
         i.modified_at                  AS modified_at,
         i.service                      AS service_id
       FROM graph_relation gr
       JOIN graph_entity  pe ON pe.id = gr.from_id AND pe.type = 'person'
       JOIN person        p  ON p.id = pe.external_id
       JOIN graph_entity  pre ON pre.id = gr.to_id AND pre.type = 'pr'
       JOIN item          i  ON i.id = pre.external_id
       WHERE gr.type = 'reviewed'
         AND (i.title LIKE '%' || ? || '%' OR i.body_preview LIKE '%' || ? || '%')
       ORDER BY i.modified_at DESC
       LIMIT 50`,
    )
    .all(input, input) as ExpertLaneRow[];

  if (rows.length === 0) {
    const gap = detectUnresolvedReviewedRelation(db);
    return gap === null ? {} : { gap };
  }

  return topLaneStream(rows, "pr_reviewed", 0.6);
}

/**
 * `person --resolves--> incident` lane, mirroring `subPrReviewed`'s shape:
 * join `graph_relation` -> `graph_entity` (person) -> `person` ->
 * `graph_entity` (incident) -> `item`, filtered on the topic.
 *
 * The `ie.type = 'incident'` join condition is load-bearing: `resolves` is
 * polysemous — `syncPrGraph` also emits `pr -> issue "resolves"`. Scoping the
 * TARGET side to `incident` keeps the two lanes independent even if a future
 * emitter ever puts a `person` on the source side of a non-incident
 * `resolves` edge; today it also matches production reality, since
 * `syncIncidentPersonEdges` is the only emitter of `resolves` edges whose
 * source is a `person` entity (see that function's doc comment).
 */
export async function subIncidentResolved(db: Database, input: string): Promise<SubAgentResult> {
  const rows = db
    .query(
      `SELECT
         p.id                           AS person_id,
         COALESCE(p.display_name, p.id) AS display_name,
         i.id                           AS item_id,
         i.title                        AS title,
         i.modified_at                  AS modified_at,
         i.service                      AS service_id
       FROM graph_relation gr
       JOIN graph_entity  pe ON pe.id = gr.from_id AND pe.type = 'person'
       JOIN person        p  ON p.id = pe.external_id
       JOIN graph_entity  ie ON ie.id = gr.to_id AND ie.type = 'incident'
       JOIN item          i  ON i.id = ie.external_id
       WHERE gr.type = 'resolves'
         AND (i.title LIKE '%' || ? || '%' OR i.body_preview LIKE '%' || ? || '%')
       ORDER BY i.modified_at DESC
       LIMIT 50`,
    )
    .all(input, input) as ExpertLaneRow[];

  if (rows.length === 0) {
    const missingEntityGap = detectMissingEntityType(db, "incident");
    if (missingEntityGap !== null) return { gap: missingEntityGap };
    // `incident` entities existing is necessary but not sufficient: this
    // lane's findings depend on a `resolves` edge targeting an `incident`
    // (person -> incident). Scoped to that endpoint (not
    // `detectMissingRelationEmit`'s any-endpoint probe) because `pr -> issue
    // "resolves"` edges are also real — an unscoped probe would find those
    // and suppress this gap note even though this lane still has nothing,
    // going silently empty instead of explaining why.
    const missingRelationGap = detectMissingRelationToEntityType(
      db,
      "resolves",
      "incident",
      remediationForEntityType("incident"),
    );
    if (missingRelationGap !== null) return { gap: missingRelationGap };
    return {};
  }

  return topLaneStream(rows, "incident_resolved", 0.8);
}

async function subChatMentions(db: Database, input: string): Promise<SubAgentResult> {
  const rows = db
    .query(
      `SELECT
         p.id                           AS person_id,
         COALESCE(p.display_name, p.id) AS display_name,
         i.id                           AS item_id,
         i.title                        AS title,
         i.modified_at                  AS modified_at,
         i.service                      AS service_id
       FROM item          i
       JOIN graph_entity  ie ON ie.type = 'message' AND ie.external_id = i.id
       JOIN graph_relation gr ON gr.to_id = ie.id AND gr.type = 'posted'
       JOIN graph_entity  pe ON pe.id = gr.from_id AND pe.type = 'person'
       JOIN person        p  ON p.id = pe.external_id
       WHERE i.type = 'message'
         AND (i.title LIKE '%' || ? || '%' OR i.body_preview LIKE '%' || ? || '%')
       ORDER BY i.modified_at DESC
       LIMIT 50`,
    )
    .all(input, input) as ExpertLaneRow[];
  if (rows.length === 0) {
    const gap = detectMissingConnector(db, "slack");
    return gap === null ? {} : { gap };
  }

  return topLaneStream(rows, "chat_post", 0.4);
}
