import type { Database } from "bun:sqlite";
import { userInfo } from "node:os";
import { AgentCoordinator, type SubTask, type SubTaskResult } from "../engine/coordinator.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { CatchupBrief, CatchupItem, CatchupSection, GapNote } from "./_lib/findings.ts";
import { detectEmptyIndex } from "./_lib/gap-notes.ts";
import { type GitRunner, resolveSelfPerson } from "./_lib/self-person.ts";
import type { SynthesisRunner } from "./_lib/synthesis-llm.ts";

const DEFAULT_SINCE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_SINCE_MS = 90 * 24 * 60 * 60 * 1000;
const PER_SERVICE_QUOTA = 50;

export type CatchupInput = {
  sinceMs?: number;
  service?: string;
  mePersonIdOverride?: string;
  runGitOverride?: GitRunner;
  osUsernameOverride?: string;
};

export type CatchupContext = {
  db: Database;
  runner?: SynthesisRunner;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
};

export type Involvement = {
  ownedServices: string[];
  activeRepos: string[];
  incidentServices: string[];
  collaboratorPersonIds: string[];
};

export type WindowItem = {
  id: string;
  service: string;
  title: string;
  modifiedAt: number;
  repoLabel: string | null;
  authorPersonId: string | null;
};

type SubAgentResult = {
  ownedServices?: string[];
  activeRepos?: string[];
  incidentServices?: string[];
  collaboratorPersonIds?: string[];
  windowItems?: WindowItem[];
  gap?: GapNote;
};

function makeSubAgent(
  fn: (db: Database, selfPersonId: string | null, sinceMs: number) => Promise<SubAgentResult>,
  db: Database,
  selfPersonId: string | null,
  sinceMs: number,
): SubTask {
  return {
    taskType: "agent_step",
    prompt: "",
    execute: async () => {
      const out = await fn(db, selfPersonId, sinceMs);
      return { text: JSON.stringify(out), tokensIn: 0, tokensOut: 0 };
    },
  };
}

function unresolvedIdentityGap(): GapNote {
  return {
    category: "missing_user_identity",
    detail:
      "Could not resolve the current user — no override / git email / OS username matched a known person.",
    remediation:
      "Set `[user] me_person_id` in your active profile's nimbus.toml, or run `nimbus people search <you>` to find your person id.",
  };
}

function failedSubAgentGap(r: SubTaskResult): GapNote {
  return {
    category: "missing_connector",
    detail: `catchup sub-agent #${r.taskIndex} failed${
      r.errorText === undefined ? "" : `: ${r.errorText}`
    }`,
  };
}

function mergeSubAgentResult(
  decoded: SubAgentResult,
  involvement: Involvement,
  windowItems: WindowItem[],
  subAgentGaps: GapNote[],
): void {
  if (decoded.ownedServices !== undefined) involvement.ownedServices.push(...decoded.ownedServices);
  if (decoded.activeRepos !== undefined) involvement.activeRepos.push(...decoded.activeRepos);
  if (decoded.incidentServices !== undefined)
    involvement.incidentServices.push(...decoded.incidentServices);
  if (decoded.collaboratorPersonIds !== undefined)
    involvement.collaboratorPersonIds.push(...decoded.collaboratorPersonIds);
  if (decoded.windowItems !== undefined) windowItems.push(...decoded.windowItems);
  if (decoded.gap !== undefined) subAgentGaps.push(decoded.gap);
}

export async function runCatchup(input: CatchupInput, ctx: CatchupContext): Promise<CatchupBrief> {
  const start = performance.now();
  const sinceMs = Math.min(input.sinceMs ?? DEFAULT_SINCE_MS, MAX_SINCE_MS);

  const preflightGaps: GapNote[] = [];
  const empty = detectEmptyIndex(ctx.db);
  if (empty !== null) preflightGaps.push(empty);

  const osUsername = input.osUsernameOverride ?? safeOsUsername();
  const resolution = await resolveSelfPerson(ctx.db, {
    ...(input.mePersonIdOverride === undefined ? {} : { override: input.mePersonIdOverride }),
    ...(input.runGitOverride === undefined ? {} : { runGit: input.runGitOverride }),
    osUsername,
  });
  if (resolution.source === "unresolved") {
    preflightGaps.push(unresolvedIdentityGap());
  }

  const coordinator = new AgentCoordinator({
    sessionId: ctx.sessionId,
    parentId: `catchup:${ctx.sessionId}`,
    depth: 1,
    toolCallCount: { value: 0 },
  });
  const tasks: SubTask[] = [
    makeSubAgent(subOwnedServices, ctx.db, resolution.personId, sinceMs),
    makeSubAgent(subActiveRepos, ctx.db, resolution.personId, sinceMs),
    makeSubAgent(subRespondedIncidents, ctx.db, resolution.personId, sinceMs),
    makeSubAgent(subCollaborators, ctx.db, resolution.personId, sinceMs),
    makeSubAgent(subWindowItems, ctx.db, resolution.personId, sinceMs),
  ];
  const results = await coordinator.run(tasks);

  const involvement: Involvement = {
    ownedServices: [],
    activeRepos: [],
    incidentServices: [],
    collaboratorPersonIds: [],
  };
  const windowItems: WindowItem[] = [];
  const subAgentGaps: GapNote[] = [];
  for (const r of results) {
    if (r.status !== "done" || r.text === undefined) {
      subAgentGaps.push(failedSubAgentGap(r));
      continue;
    }
    const decoded: SubAgentResult = JSON.parse(r.text);
    mergeSubAgentResult(decoded, involvement, windowItems, subAgentGaps);
  }

  let sections = scoreAndGroup(windowItems, involvement);
  if (input.service !== undefined) {
    sections = sections.filter((s) => s.serviceId === input.service);
  }

  return {
    kind: "catchup",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps: [...preflightGaps, ...subAgentGaps],
    query: { sinceMs },
    selfPersonId: resolution.personId,
    involvement,
    sections,
  };
}

export function emitCatchupBrief(
  input: CatchupInput,
  ctx: CatchupContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "catchup.briefReady",
    briefErrorMethod: "catchup.briefError",
    notify: ctx.notify,
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
    buildBrief: () => runCatchup(input, ctx),
  });
}

function safeOsUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

const SCORE_OWNED_SERVICE = 1;
const SCORE_ACTIVE_REPO = 0.7;
const SCORE_INCIDENT_SERVICE = 0.7;
const SCORE_COLLABORATOR = 0.5;
const SCORE_DEFAULT = 0.1;

function scoreItem(
  item: WindowItem,
  involvement: Involvement,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let raw = 0;
  if (involvement.ownedServices.includes(item.service)) {
    raw += SCORE_OWNED_SERVICE;
    reasons.push(`owned_service:${item.service}`);
  }
  if (item.repoLabel !== null && involvement.activeRepos.includes(item.repoLabel)) {
    raw += SCORE_ACTIVE_REPO;
    reasons.push(`active_repo:${item.repoLabel}`);
  }
  if (involvement.incidentServices.includes(item.service)) {
    raw += SCORE_INCIDENT_SERVICE;
    reasons.push(`incident_service:${item.service}`);
  }
  if (
    item.authorPersonId !== null &&
    involvement.collaboratorPersonIds.includes(item.authorPersonId)
  ) {
    raw += SCORE_COLLABORATOR;
    reasons.push(`collaborator:${item.authorPersonId}`);
  }
  if (raw === 0) {
    raw = SCORE_DEFAULT;
    reasons.push("default");
  }
  const score = Math.min(raw, 1);
  return { score, reasons };
}

export function scoreAndGroup(items: WindowItem[], involvement: Involvement): CatchupSection[] {
  if (items.length === 0) return [];
  const buckets = new Map<string, { items: CatchupItem[]; aggregate: number; total: number }>();
  for (const item of items) {
    const { score, reasons } = scoreItem(item, involvement);
    const ci: CatchupItem = {
      itemId: item.id,
      title: item.title,
      modifiedAt: item.modifiedAt,
      relevanceScore: score,
      relevanceReasons: reasons,
    };
    const slot = buckets.get(item.service);
    if (slot === undefined) {
      buckets.set(item.service, { items: [ci], aggregate: score, total: 1 });
    } else {
      slot.items.push(ci);
      slot.aggregate += score;
      slot.total += 1;
    }
  }
  const ordered = [...buckets.entries()].map(([serviceId, slot]) => ({
    serviceId,
    aggregate: slot.aggregate,
    section: {
      serviceId,
      totalItemsInWindow: slot.total,
      items: slot.items.toSorted((a, b) => {
        if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
        return b.modifiedAt - a.modifiedAt;
      }),
    } satisfies CatchupSection,
  }));
  ordered.sort((a, b) => b.aggregate - a.aggregate);
  return ordered.map((o) => o.section);
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

async function subOwnedServices(
  db: Database,
  selfPersonId: string | null,
  _sinceMs: number,
): Promise<SubAgentResult> {
  if (selfPersonId === null) return { ownedServices: [] };
  const ninetyDaysAgo = Date.now() - NINETY_DAYS_MS;
  const rows = db
    .query(
      `SELECT service, COUNT(*) AS n
         FROM item
         WHERE author_id = ? AND modified_at >= ?
         GROUP BY service
         HAVING n >= 5
         ORDER BY n DESC`,
    )
    .all(selfPersonId, ninetyDaysAgo) as Array<{ service: string; n: number }>;
  return { ownedServices: rows.map((r) => r.service) };
}

async function subActiveRepos(
  db: Database,
  selfPersonId: string | null,
  _sinceMs: number,
): Promise<SubAgentResult> {
  if (selfPersonId === null) return { activeRepos: [] };
  const ninetyDaysAgo = Date.now() - NINETY_DAYS_MS;
  const rows = db
    .query(
      `SELECT DISTINCT
         substr(external_id, 1, instr(external_id, '#') - 1) AS repo_label
         FROM item
         WHERE author_id = ?
           AND modified_at >= ?
           AND type = 'pr'
           AND instr(external_id, '#') > 0`,
    )
    .all(selfPersonId, ninetyDaysAgo) as Array<{ repo_label: string }>;
  return { activeRepos: rows.map((r) => r.repo_label).filter((s) => s.length > 0) };
}

async function subRespondedIncidents(
  db: Database,
  selfPersonId: string | null,
  _sinceMs: number,
): Promise<SubAgentResult> {
  if (selfPersonId === null) return { incidentServices: [] };
  const ninetyDaysAgo = Date.now() - NINETY_DAYS_MS;
  const rows = db
    .query(
      `SELECT DISTINCT i.service AS service
         FROM graph_relation r
         JOIN graph_entity   pe ON pe.id = r.from_id AND pe.type = 'person' AND pe.external_id = ?
         JOIN graph_entity   ie ON ie.id = r.to_id   AND ie.type = 'incident'
         JOIN item           i  ON i.id = ie.external_id
         WHERE r.type = 'resolves' AND i.modified_at >= ?`,
    )
    .all(selfPersonId, ninetyDaysAgo) as Array<{ service: string }>;
  return { incidentServices: rows.map((r) => r.service) };
}

async function subCollaborators(
  db: Database,
  selfPersonId: string | null,
  _sinceMs: number,
): Promise<SubAgentResult> {
  if (selfPersonId === null) return { collaboratorPersonIds: [] };
  const ninetyDaysAgo = Date.now() - NINETY_DAYS_MS;
  const rows = db
    .query(
      `SELECT author_id AS person_id, COUNT(*) AS n
         FROM item
         WHERE author_id IS NOT NULL
           AND author_id != ?
           AND modified_at >= ?
           AND instr(external_id, '#') > 0
           AND substr(external_id, 1, instr(external_id, '#') - 1) IN (
             SELECT DISTINCT substr(external_id, 1, instr(external_id, '#') - 1)
               FROM item
               WHERE author_id = ? AND modified_at >= ? AND instr(external_id, '#') > 0
           )
         GROUP BY author_id
         HAVING n >= 3`,
    )
    .all(selfPersonId, ninetyDaysAgo, selfPersonId, ninetyDaysAgo) as Array<{
    person_id: string;
    n: number;
  }>;
  return { collaboratorPersonIds: rows.map((r) => r.person_id) };
}

async function subWindowItems(
  db: Database,
  _selfPersonId: string | null,
  sinceMs: number,
): Promise<SubAgentResult> {
  const sinceCutoff = Date.now() - sinceMs;
  const rows = db
    .query(
      `SELECT id, service, title, modified_at,
              CASE WHEN instr(external_id, '#') > 0
                   THEN substr(external_id, 1, instr(external_id, '#') - 1)
                   ELSE NULL END AS repo_label,
              author_id
         FROM item
         WHERE modified_at >= ?
         ORDER BY service ASC, modified_at DESC`,
    )
    .all(sinceCutoff) as Array<{
    id: string;
    service: string;
    title: string;
    modified_at: number;
    repo_label: string | null;
    author_id: string | null;
  }>;
  const perService = new Map<string, number>();
  const out: WindowItem[] = [];
  for (const r of rows) {
    const used = perService.get(r.service) ?? 0;
    if (used >= PER_SERVICE_QUOTA) continue;
    perService.set(r.service, used + 1);
    out.push({
      id: r.id,
      service: r.service,
      title: r.title,
      modifiedAt: r.modified_at,
      repoLabel: r.repo_label,
      authorPersonId: r.author_id,
    });
  }
  return { windowItems: out };
}
