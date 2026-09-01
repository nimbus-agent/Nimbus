import type { Database } from "bun:sqlite";
import { AgentCoordinator, type SubTask } from "../engine/coordinator.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { GapNote, ImpactBrief, ImpactFinding } from "./_lib/findings.ts";
import {
  aggregateMissingEntityTypes,
  detectEmptyIndex,
  detectMissingConnector,
  detectMissingEntityType,
} from "./_lib/gap-notes.ts";
import { reverseDependsOn } from "./_lib/graph-traversals.ts";
import { resolvePrSubject } from "./_lib/pr-subject.ts";
import type { SynthesisRunner } from "./_lib/synthesis-llm.ts";

export type ImpactInput = {
  fileOrPrUrl: string;
  depth?: number;
  service?: string;
};

export type ImpactContext = {
  db: Database;
  runner?: SynthesisRunner;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
};

type ResolvedStart = {
  entityId: string;
  entityType: string;
  repoIds: string[];
};

type SubAgentResult = {
  findings?: ImpactFinding[];
  gap?: GapNote;
};

function makeSubAgent(
  fn: (db: Database, input: ImpactInput, start: ResolvedStart | null) => Promise<SubAgentResult>,
  db: Database,
  input: ImpactInput,
  start: ResolvedStart | null,
): SubTask {
  return {
    taskType: "agent_step",
    prompt: "",
    execute: async () => {
      const out = await fn(db, input, start);
      return { text: JSON.stringify(out), tokensIn: 0, tokensOut: 0 };
    },
  };
}

export async function runImpact(input: ImpactInput, ctx: ImpactContext): Promise<ImpactBrief> {
  const start = performance.now();

  const preflightGaps: GapNote[] = [];
  const empty = detectEmptyIndex(ctx.db);
  if (empty !== null) preflightGaps.push(empty);

  const resolved = resolveStartEntity(ctx.db, input.fileOrPrUrl);

  const coordinator = new AgentCoordinator({
    sessionId: ctx.sessionId,
    parentId: `impact:${ctx.sessionId}`,
    depth: 1,
    toolCallCount: { value: 0 },
  });

  const tasks: SubTask[] = [
    makeSubAgent(subDownstreamCode, ctx.db, input, resolved),
    makeSubAgent(subPipelines, ctx.db, input, resolved),
    makeSubAgent(subOncall, ctx.db, input, resolved),
    makeSubAgent(subDashboards, ctx.db, input, resolved),
    makeSubAgent(subDownstreamRepos, ctx.db, input, resolved),
  ];

  const results = await coordinator.run(tasks);

  const allFindings: ImpactFinding[] = [];
  const subAgentGaps: GapNote[] = [];
  for (const r of results) {
    if (r.status !== "done" || r.text === undefined) {
      subAgentGaps.push({
        category: "missing_connector",
        detail: `impact sub-agent #${r.taskIndex} failed${
          r.errorText === undefined ? "" : `: ${r.errorText}`
        }`,
      });
      continue;
    }
    const decoded: SubAgentResult = JSON.parse(r.text);
    if (decoded.findings !== undefined) allFindings.push(...decoded.findings);
    if (decoded.gap !== undefined) subAgentGaps.push(decoded.gap);
  }

  const filtered =
    input.service === undefined
      ? allFindings
      : allFindings.filter((f) => f.serviceId === input.service);

  const gaps = aggregateMissingEntityTypes([...preflightGaps, ...subAgentGaps]);

  return {
    kind: "impact",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query: { fileOrPrUrl: input.fileOrPrUrl },
    startEntityId: resolved === null ? null : resolved.entityId,
    affected: filtered,
  };
}

export function emitImpactBrief(
  input: ImpactInput,
  ctx: ImpactContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "impact.briefReady",
    briefErrorMethod: "impact.briefError",
    notify: ctx.notify,
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
    buildBrief: () => runImpact(input, ctx),
  });
}

function resolveStartEntity(db: Database, fileOrPrUrl: string): ResolvedStart | null {
  const pr = resolvePrSubject(db, fileOrPrUrl);
  if (pr.ok) {
    return {
      entityId: pr.subject.entityId,
      entityType: "pr",
      repoIds: repoIdsForRepoLabel(db, pr.subject.repo),
    };
  }

  // A FILE, before any symbol lookup. `syncCodeSymbolGraph` labels `symbol` entities
  // `"<name> — <file>"`, so no symbol's label is ever a bare path: the exact-symbol arm
  // below cannot match file input at all, and the `LIKE` arm answers it with whichever
  // symbol inside that file has the shortest label — a confident answer about
  // `x — src/foo.ts` to a question about `src/foo.ts`.
  //
  // `source_file` entities carry the path itself as their label (same populator), so the
  // right node was always there and nothing looked for it. Both symbol arms below are
  // unchanged for genuine symbol-name input; they are only demoted beneath this one.
  const file = db
    .query("SELECT id FROM graph_entity WHERE type = 'source_file' AND label = ? LIMIT 1")
    .get(fileOrPrUrl) as { id?: string } | null;
  if (file?.id !== undefined) {
    return { entityId: file.id, entityType: "source_file", repoIds: [] };
  }

  const exactSym = db
    .query("SELECT id FROM graph_entity WHERE type = 'symbol' AND label = ? LIMIT 1")
    .get(fileOrPrUrl) as { id?: string } | null;
  const sym =
    exactSym?.id === undefined
      ? (db
          .query(
            "SELECT id FROM graph_entity WHERE type = 'symbol' AND label LIKE '%' || ? || '%' " +
              "ORDER BY length(label) ASC, id ASC LIMIT 1",
          )
          .get(fileOrPrUrl) as { id?: string } | null)
      : exactSym;
  if (sym?.id !== undefined) {
    return { entityId: sym.id, entityType: "symbol", repoIds: [] };
  }

  const topic = db
    .query(
      "SELECT i.id AS item_id FROM item i WHERE i.title LIKE '%' || ? || '%' OR i.body_preview LIKE '%' || ? || '%' ORDER BY i.modified_at DESC LIMIT 1",
    )
    .get(fileOrPrUrl, fileOrPrUrl) as { item_id?: string } | null;
  if (topic?.item_id !== undefined) {
    return { entityId: `item:${topic.item_id}`, entityType: "topic", repoIds: [] };
  }
  return null;
}

function repoIdsForRepoLabel(db: Database, repoLabel: string): string[] {
  const rows = db
    .query("SELECT id FROM graph_entity WHERE type = 'repo' AND label = ? LIMIT 5")
    .all(repoLabel) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

async function subDownstreamCode(
  db: Database,
  _input: ImpactInput,
  start: ResolvedStart | null,
): Promise<SubAgentResult> {
  if (start === null) {
    return {
      gap: {
        category: "missing_relation_emit",
        detail: "Cannot traverse `depends_on`: start entity did not resolve.",
      },
    };
  }
  const rows = reverseDependsOn(db, start.entityId);
  if (rows.length === 0) {
    return {
      gap: {
        category: "missing_relation_emit",
        detail: "No reverse `depends_on` edges to the start entity.",
        remediation:
          "graph-populator currently emits `depends_on` only at workspace→package granularity; symbol-level `depends_on` is a populator follow-up.",
      },
    };
  }
  return {
    findings: rows.map((r) => ({
      category: "downstream_repo",
      affectedItemId: r.entityId,
      affectedTitle: r.label,
      serviceId: r.serviceId,
      hops: 1,
      pathSummary: `(reverse) ${start.entityType} <- depends_on <- result`,
    })),
  };
}

async function subPipelines(
  db: Database,
  _input: ImpactInput,
  start: ResolvedStart | null,
): Promise<SubAgentResult> {
  if (start === null) {
    return {
      gap: {
        category: "missing_relation_emit",
        detail: "Cannot traverse `triggers`: start entity did not resolve.",
      },
    };
  }

  const sourceIds = start.repoIds.length > 0 ? start.repoIds : [start.entityId];
  const placeholders = sourceIds.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT
         e.id          AS entity_id,
         e.label       AS title,
         COALESCE(e.service, 'github') AS service_id
       FROM graph_relation r
       JOIN graph_entity   e ON e.id = r.to_id AND e.type IN ('ci_run', 'pipeline_run')
       WHERE r.from_id IN (${placeholders}) AND r.type = 'triggers'
       LIMIT 50`,
    )
    .all(...sourceIds) as Array<{ entity_id: string; title: string; service_id: string }>;
  if (rows.length > 0) {
    const pathSummary =
      start.repoIds.length > 0
        ? `${start.entityType} → in_repo → repo → triggers → ci_run`
        : `${start.entityType} → triggers → ci_run`;
    const hops = start.repoIds.length > 0 ? 2 : 1;
    return {
      findings: rows.map((r) => ({
        category: "pipeline",
        affectedItemId: r.entity_id,
        affectedTitle: r.title,
        serviceId: r.service_id,
        hops,
        pathSummary,
      })),
    };
  }
  const gap = detectMissingEntityType(db, "pipeline_run");
  if (gap !== null) return { gap };
  return {};
}

async function subOncall(
  db: Database,
  _input: ImpactInput,
  start: ResolvedStart | null,
): Promise<SubAgentResult> {
  const gap = detectMissingConnector(db, "pagerduty");
  if (gap !== null) return { gap };
  if (start === null) {
    return {
      gap: {
        category: "missing_relation_emit",
        detail: "Cannot traverse `belongs_to`: start entity did not resolve.",
      },
    };
  }

  const rows = db
    .query(
      `SELECT
         e.id   AS entity_id,
         e.label AS title
       FROM graph_relation r
       JOIN graph_entity   e ON e.id = r.to_id AND e.type = 'oncall_rotation'
       WHERE r.from_id = ? AND r.type = 'belongs_to'
       LIMIT 50`,
    )
    .all(start.entityId) as Array<{ entity_id: string; title: string }>;
  if (rows.length === 0) return {};
  return {
    findings: rows.map((r) => ({
      category: "oncall_rotation",
      affectedItemId: r.entity_id,
      affectedTitle: r.title,
      serviceId: "pagerduty",
      hops: 2,
      pathSummary: "service → belongs_to → oncall_rotation",
    })),
  };
}

async function subDashboards(
  db: Database,
  _input: ImpactInput,
  start: ResolvedStart | null,
): Promise<SubAgentResult> {
  const gap = detectMissingEntityType(db, "dashboard");
  if (gap !== null) return { gap };
  if (start === null) return {};

  const rows = db
    .query(
      `SELECT
         e.id   AS entity_id,
         e.label AS title,
         COALESCE(e.service, 'unknown') AS service_id
       FROM graph_relation r
       JOIN graph_entity   e ON e.id = r.to_id AND e.type = 'dashboard'
       WHERE r.from_id = ? AND r.type = 'upstream_refs'
       LIMIT 50`,
    )
    .all(start.entityId) as Array<{ entity_id: string; title: string; service_id: string }>;
  if (rows.length === 0) return {};
  const pathSummary = `${start.entityType} → upstream_refs → dashboard`;
  return {
    findings: rows.map((r) => ({
      category: "dashboard",
      affectedItemId: r.entity_id,
      affectedTitle: r.title,
      serviceId: r.service_id,
      hops: 1,
      pathSummary,
    })),
  };
}

async function subDownstreamRepos(
  db: Database,
  _input: ImpactInput,
  start: ResolvedStart | null,
): Promise<SubAgentResult> {
  if (start === null) {
    return {
      gap: {
        category: "missing_relation_emit",
        detail: "Cannot resolve downstream repos: start entity did not resolve.",
      },
    };
  }
  if (start.repoIds.length === 0) return {};
  const placeholders = start.repoIds.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT id, label, COALESCE(service, 'github') AS service_id
         FROM graph_entity
         WHERE id IN (${placeholders})`,
    )
    .all(...start.repoIds) as Array<{ id: string; label: string; service_id: string }>;
  if (rows.length === 0) return {};
  return {
    findings: rows.map((r) => ({
      category: "service",
      affectedItemId: r.id,
      affectedTitle: r.label,
      serviceId: r.service_id,
      hops: 1,
      pathSummary: "pr → in_repo → repo",
    })),
  };
}
