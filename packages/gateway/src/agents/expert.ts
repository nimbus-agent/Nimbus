import type { Database } from "bun:sqlite";
import { AgentCoordinator, type SubTask } from "../engine/coordinator.ts";
import type { Evidence, ExpertBrief, ExpertFinding, GapNote } from "./_lib/findings.ts";
import {
  detectEmptyIndex,
  detectMissingConnector,
  detectMissingEntityType,
  detectMissingRelationEmit,
} from "./_lib/gap-notes.ts";
import { type SynthesizerLlm, synthesize } from "./_lib/synthesize.ts";

export type ExpertInput = {
  topicOrFile: string;
  limit?: number;
};

export type ExpertContext = {
  db: Database;
  llm?: SynthesizerLlm;
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

export async function emitExpertBrief(
  input: ExpertInput,
  ctx: ExpertContext,
): Promise<{ sessionId: string }> {
  void (async () => {
    const brief = await runExpert(input, ctx);
    const markdown = await synthesize(brief, ctx.llm === undefined ? {} : { llm: ctx.llm });
    ctx.notify("expert.briefReady", {
      sessionId: ctx.sessionId,
      brief: markdown,
      findings: brief,
    });
  })().catch((err: unknown) => {
    ctx.notify("expert.briefError", {
      sessionId: ctx.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return { sessionId: ctx.sessionId };
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

async function subPrReviewed(db: Database, _input: string): Promise<SubAgentResult> {
  const gap = detectMissingRelationEmit(
    db,
    "reviewed",
    "Tracked as a graph-populator follow-up; not gated on a specific Phase 5 wave.",
  );
  if (gap !== null) return { gap };
  return {};
}

async function subIncidentResolved(db: Database, _input: string): Promise<SubAgentResult> {
  const missingEntityGap = detectMissingEntityType(db, "incident");
  if (missingEntityGap !== null) return { gap: missingEntityGap };
  // `incident` entities existing is necessary but not sufficient: this lane's
  // findings depend on the `resolves` relation (person -> incident), which no
  // populator currently emits. Without this check, once incident entities
  // exist the lane goes silently empty instead of explaining why.
  const missingRelationGap = detectMissingRelationEmit(
    db,
    "resolves",
    "Tracked as a graph-populator follow-up on existing PagerDuty / Sentry connectors.",
  );
  if (missingRelationGap !== null) return { gap: missingRelationGap };
  return {};
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
