import type { Database } from "bun:sqlite";
import { AgentCoordinator, type SubTask } from "../engine/coordinator.ts";
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

export type ExpertInput = {
  topicOrFile: string;
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

  const preflightGaps: GapNote[] = [];
  const empty = detectEmptyIndex(ctx.db);
  if (empty !== null) preflightGaps.push(empty);

  const coordinator = new AgentCoordinator({
    sessionId: ctx.sessionId,
    parentId: `expert:${ctx.sessionId}`,
    depth: 1,
    toolCallCount: { value: 0 },
  });

  const tasks: SubTask[] = [
    makeSubAgent("agent_step", subBlame, ctx.db, input.topicOrFile),
    makeSubAgent("agent_step", subPrAuthored, ctx.db, input.topicOrFile),
    makeSubAgent("agent_step", subPrReviewed, ctx.db, input.topicOrFile),
    makeSubAgent("agent_step", subIncidentResolved, ctx.db, input.topicOrFile),
    makeSubAgent("agent_step", subChatMentions, ctx.db, input.topicOrFile),
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
    query: { topicOrFile: input.topicOrFile },
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
    .all(input, input) as Array<{
    person_id: string;
    display_name: string;
    item_id: string;
    title: string;
    modified_at: number;
    service_id: string;
  }>;

  if (commits.length === 0) {
    const gap = detectMissingConnector(db, "github");
    return gap === null ? {} : { gap };
  }

  const merged = new Map<string, ExpertEvidenceStream>();
  for (const c of commits) {
    const ev: Evidence = {
      itemId: c.item_id,
      type: "commit_authored",
      serviceId: c.service_id,
      title: c.title.slice(0, 512),
      modifiedAt: c.modified_at,
      weight: 1,
    };
    const existing = merged.get(c.person_id);
    if (existing === undefined) {
      merged.set(c.person_id, {
        personId: c.person_id,
        displayName: c.display_name,
        evidence: [ev],
      });
    } else {
      existing.evidence.push(ev);
    }
  }
  const winner = [...merged.values()].sort((a, b) => b.evidence.length - a.evidence.length)[0];
  return winner === undefined ? {} : { stream: winner };
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
    .all(ninetyDaysAgo, input, input) as Array<{
    person_id: string;
    display_name: string;
    item_id: string;
    title: string;
    modified_at: number;
    service_id: string;
  }>;

  if (rows.length === 0) return {};

  const merged = new Map<string, ExpertEvidenceStream>();
  for (const r of rows) {
    const ev: Evidence = {
      itemId: r.item_id,
      type: "pr_authored",
      serviceId: r.service_id,
      title: r.title.slice(0, 512),
      modifiedAt: r.modified_at,
      weight: 0.8,
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
    .all(input, input) as Array<{
    person_id: string;
    display_name: string;
    item_id: string;
    title: string;
    modified_at: number;
    service_id: string;
  }>;

  if (rows.length === 0) {
    const gap = detectUnresolvedReviewedRelation(db);
    return gap === null ? {} : { gap };
  }

  const merged = new Map<string, ExpertEvidenceStream>();
  for (const r of rows) {
    const ev: Evidence = {
      itemId: r.item_id,
      type: "pr_reviewed",
      serviceId: r.service_id,
      title: r.title.slice(0, 512),
      modifiedAt: r.modified_at,
      weight: 0.6,
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
    .all(input, input) as Array<{
    person_id: string;
    display_name: string;
    item_id: string;
    title: string;
    modified_at: number;
    service_id: string;
  }>;

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

  const merged = new Map<string, ExpertEvidenceStream>();
  for (const r of rows) {
    const ev: Evidence = {
      itemId: r.item_id,
      type: "incident_resolved",
      serviceId: r.service_id,
      title: r.title.slice(0, 512),
      modifiedAt: r.modified_at,
      weight: 0.8,
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
    .all(input, input) as Array<{
    person_id: string;
    display_name: string;
    item_id: string;
    title: string;
    modified_at: number;
    service_id: string;
  }>;
  if (rows.length === 0) {
    const gap = detectMissingConnector(db, "slack");
    return gap === null ? {} : { gap };
  }

  const merged = new Map<string, ExpertEvidenceStream>();
  for (const r of rows) {
    const ev: Evidence = {
      itemId: r.item_id,
      type: "chat_post",
      serviceId: r.service_id,
      title: r.title.slice(0, 512),
      modifiedAt: r.modified_at,
      weight: 0.4,
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
