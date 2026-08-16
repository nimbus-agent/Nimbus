import type { Database } from "bun:sqlite";

import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import { AgentCoordinator, type SubTask } from "../engine/coordinator.ts";
import type { BlameLookup } from "../security/blame-store.ts";
import { type BlameSpawn, ensureBlameLine } from "./_lib/blame-on-demand.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { GapNote } from "./_lib/findings.ts";
import {
  aggregateMissingEntityTypes,
  detectEmptyIndex,
  detectMissingEntityType,
  detectMissingRelationEmit,
  detectMissingRelationToEntityType,
} from "./_lib/gap-notes.ts";
import { reverseDependsOn } from "./_lib/graph-traversals.ts";
import type { SynthesisRunner } from "./_lib/synthesis-llm.ts";
import { parseRef, resolveWhySubject } from "./_lib/why-subject.ts";
import type { WhyBrief, WhyFinding, WhyInput, WhySubject } from "./_lib/why-types.ts";

export type WhyContext = {
  db: Database;
  roots: readonly NimbusFilesystemRootToml[];
  runner?: SynthesisRunner;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
  spawn?: BlameSpawn;
};

/** A change "responds to" an incident well before the 2h deploy-correlation window — 48h is the human-latency window. */
const DRIVER_WINDOW_MS = 48 * 60 * 60 * 1000;
const SHA_PORTION = "substr(external_id, instr(external_id, ':') + 1)";

type LaneInput = {
  subject: WhySubject | null;
  blame: BlameLookup | null;
};

type SubAgentResult = {
  findings?: WhyFinding[];
  gap?: GapNote;
};

function makeSubAgent(
  fn: (db: Database, lane: LaneInput) => Promise<SubAgentResult>,
  db: Database,
  lane: LaneInput,
): SubTask {
  return {
    taskType: "agent_step",
    prompt: "",
    execute: async () => {
      const out = await fn(db, lane);
      return { text: JSON.stringify(out), tokensIn: 0, tokensOut: 0 };
    },
  };
}

export async function runWhy(input: WhyInput, ctx: WhyContext): Promise<WhyBrief> {
  const start = performance.now();

  const preflightGaps: GapNote[] = [];
  const empty = detectEmptyIndex(ctx.db);
  if (empty !== null) preflightGaps.push(empty);

  const subject = resolveWhySubject(ctx.db, ctx.roots, input);
  const parsedLine = parseRef(input.ref).line;

  // Resolve-once design: two lanes need the blamed SHA, and running
  // `ensureBlameLine` inside parallel sub-agents could double-spawn on a
  // cold line. Resolve it here, once, and hand the result to every lane.
  let blame: BlameLookup | null = null;
  if (subject !== null && subject.lineNo !== null) {
    blame = await ensureBlameLine(
      ctx.db,
      { repoRoot: subject.repoRoot, filePath: subject.filePath },
      subject.lineNo,
      ctx.spawn,
    );
  }
  const lane: LaneInput = { subject, blame };

  const coordinator = new AgentCoordinator({
    sessionId: ctx.sessionId,
    parentId: `why:${ctx.sessionId}`,
    depth: 1,
    toolCallCount: { value: 0 },
  });

  const tasks: SubTask[] = [
    makeSubAgent(subAuthorship, ctx.db, lane),
    makeSubAgent(subPullRequest, ctx.db, lane),
    makeSubAgent(subTicket, ctx.db, lane),
    makeSubAgent(subDiscussion, ctx.db, lane),
    makeSubAgent(subDriver, ctx.db, lane),
    makeSubAgent(subDownstream, ctx.db, lane),
  ];

  const results = await coordinator.run(tasks);

  const allFindings: WhyFinding[] = [];
  const laneGaps: GapNote[] = [];
  for (const r of results) {
    if (r.status !== "done" || r.text === undefined) {
      laneGaps.push({
        category: "missing_connector",
        detail: `why sub-agent #${r.taskIndex} failed${
          r.errorText === undefined ? "" : `: ${r.errorText}`
        }`,
      });
      continue;
    }
    const decoded: SubAgentResult = JSON.parse(r.text);
    if (decoded.findings !== undefined) allFindings.push(...decoded.findings);
    if (decoded.gap !== undefined) laneGaps.push(decoded.gap);
  }

  const gaps = aggregateMissingEntityTypes([...preflightGaps, ...laneGaps]);

  return {
    kind: "why",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query: { ref: input.ref, line: input.line ?? parsedLine },
    subject,
    findings: allFindings,
  };
}

export function emitWhyBrief(input: WhyInput, ctx: WhyContext): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "why.briefReady",
    briefErrorMethod: "why.briefError",
    notify: ctx.notify,
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
    buildBrief: () => runWhy(input, ctx),
  });
}

// ---------------------------------------------------------------------------
// Shared lane helpers — self-contained duplicates of why-peek.ts's queries
// (see the task brief: why.ts must not import from why-peek.ts).
// ---------------------------------------------------------------------------

function findCommitEntity(
  db: Database,
  sha: string,
  repoRoot: string,
): { id: string; label: string } | null {
  return db
    .query(
      `SELECT id, label FROM graph_entity
        WHERE type = 'commit' AND ${SHA_PORTION} = ?
        ORDER BY CASE WHEN json_extract(metadata, '$.repoRoot') = ? THEN 0 ELSE 1 END, id ASC
        LIMIT 1`,
    )
    .get(sha, repoRoot) as { id: string; label: string } | null;
}

type PrForSha = {
  entityId: string;
  number: number | null;
  title: string;
  url: string | null;
  modifiedAt: number;
};

function findPrForSha(db: Database, sha: string): PrForSha | null {
  const row = db
    .query(
      `SELECT p.id AS entity_id,
              CAST(json_extract(i.metadata, '$.number') AS INTEGER) AS number,
              i.title AS title,
              i.url   AS url,
              i.modified_at AS modified_at
         FROM graph_relation r
         JOIN graph_entity c ON c.id = r.to_id   AND c.type = 'commit'
         JOIN graph_entity p ON p.id = r.from_id AND p.type = 'pr'
         JOIN item i ON i.id = p.external_id
        WHERE r.type = 'merged_as'
          AND substr(c.external_id, instr(c.external_id, ':') + 1) = ?
        LIMIT 1`,
    )
    .get(sha) as {
    entity_id: string;
    number: number | null;
    title: string;
    url: string | null;
    modified_at: number;
  } | null;
  return row === null
    ? null
    : {
        entityId: row.entity_id,
        number: row.number,
        title: row.title,
        url: row.url,
        modifiedAt: row.modified_at,
      };
}

type TicketRow = {
  entityId: string;
  key: string;
  title: string;
  url: string | null;
  modifiedAt: number;
};

/** Both endpoints type-scoped: `resolves` is polysemous (also emitted person → incident). */
function ticketRowsForPr(db: Database, prEntityId: string): TicketRow[] {
  const rows = db
    .query(
      `SELECT ie.id AS entity_id, i.external_id AS key, i.title AS title, i.url AS url,
              i.modified_at AS modified_at
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'pr'
         JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'issue'
         JOIN item i ON i.id = ie.external_id
        WHERE r.from_id = ? AND r.type = 'resolves'
        LIMIT 10`,
    )
    .all(prEntityId) as Array<{
    entity_id: string;
    key: string;
    title: string;
    url: string | null;
    modified_at: number;
  }>;
  return rows.map((r) => ({
    entityId: r.entity_id,
    key: r.key,
    title: r.title,
    url: r.url,
    modifiedAt: r.modified_at,
  }));
}

// ---------------------------------------------------------------------------
// Lane 1: authorship
// ---------------------------------------------------------------------------

async function subAuthorship(db: Database, lane: LaneInput): Promise<SubAgentResult> {
  if (lane.subject?.lineNo == null) {
    return {
      gap: {
        category: "missing_relation_emit",
        detail: "Cannot anchor authorship: no resolvable file/line subject for this ref.",
      },
    };
  }
  if (lane.blame === null) {
    return {
      gap: {
        category: "missing_relation_emit",
        detail:
          "No blame available for this line (outside an indexed root, not a git repo, or git blame failed).",
      },
    };
  }
  const commit = findCommitEntity(db, lane.blame.commitSha, lane.subject.repoRoot);
  return {
    findings: [
      {
        lane: "authorship",
        title: `${lane.blame.authorName ?? "unknown"} · ${lane.blame.commitSha.slice(0, 12)}`,
        detail: commit?.label ?? lane.blame.commitSha,
        url: null,
        occurredAt: lane.blame.authorTimeMs,
        entityId: commit?.id ?? null,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Lane 2: pull_request
// ---------------------------------------------------------------------------

/**
 * Resolution-aware probe for the `reviewed` lane — mirrors the shape of
 * `expert.ts`'s `detectUnresolvedReviewedRelation`, but scoped to a single
 * PR: unlike `expert.ts`'s `subPrReviewed` (a free-text topic search across
 * *all* PRs, where "does anything resolve anywhere" is the right question),
 * `why.ts`'s `subPullRequest` lane is already scoped to one resolved
 * `pr.entityId` — its `reviewerRows` query filters `WHERE r.to_id = ?` bound
 * to that PR. A probe that asks "does ANY `reviewed` edge ANYWHERE resolve"
 * would report "all clear" as soon as a *different* PR's edge resolves,
 * silencing a real per-PR failure (a `reviewed` edge on *this* PR with a
 * dangling `from_id` or no matching `person` graph_entity) the moment the
 * graph holds more than one PR's review data. So this probe binds
 * `prEntityId` into the resolution check too, matching `reviewerRows`.
 *
 * `detectMissingRelationEmit` only checks that *some* `graph_relation` row of
 * type `reviewed` exists — it does not require that row to resolve through
 * the person/pr join chain this lane's reviewer query needs. Without this
 * check, a `reviewed` edge on this PR whose `person` graph_entity doesn't
 * exist makes the reviewer query return 0 rows AND makes
 * `detectMissingRelationEmit` report "all clear" — silently empty instead of
 * explaining itself.
 *
 * Returns:
 *   - the "no `reviewed` edges at all" gap if none exist anywhere,
 *   - a distinct "edges exist but none resolve on this PR" gap if edges
 *     exist elsewhere but the join chain never completes for this PR's
 *     `pr.entityId` specifically (a real indexing gap for this PR),
 *   - `null` if at least one edge resolves on this PR — the real query
 *     already surfaced the reviewer in that case.
 */
function detectUnresolvedReviewedRelation(db: Database, prEntityId: string): GapNote | null {
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
        WHERE gr.type = 'reviewed' AND gr.to_id = ?
        LIMIT 1`,
    )
    .get(prEntityId) as { n?: number } | null;
  if (resolvedRow !== null) return null;

  return {
    category: "missing_relation_emit",
    detail:
      "`reviewed` edges exist in the graph but none resolve to a reviewer for this PR — its reviewers are not (yet) indexed.",
    remediation:
      "Sync the GitHub connector so this PR's reviewed events and their authors are indexed.",
  };
}

async function subPullRequest(db: Database, lane: LaneInput): Promise<SubAgentResult> {
  const sha = lane.blame?.commitSha;
  const pr = sha === undefined ? null : findPrForSha(db, sha);
  if (pr === null) {
    const gap = detectMissingRelationEmit(
      db,
      "merged_as",
      "PRs emit `merged_as` when github-sync records a merge commit SHA — sync the connector for this repo.",
    );
    return gap !== null ? { gap } : {};
  }

  const authorRow = db
    .query(
      `SELECT pe.label AS label
         FROM graph_relation a
         JOIN graph_entity pe ON pe.id = a.from_id AND pe.type = 'person'
        WHERE a.to_id = ? AND a.type = 'authored'
        LIMIT 1`,
    )
    .get(pr.entityId) as { label: string } | null;

  const REVIEWER_DISPLAY_LIMIT = 5;
  const reviewerRows = db
    .query(
      `SELECT DISTINCT pe.label AS label
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
        WHERE r.to_id = ? AND r.type = 'reviewed'
        ORDER BY label
        LIMIT ?`,
    )
    .all(pr.entityId, REVIEWER_DISPLAY_LIMIT) as Array<{ label: string }>;
  const reviewerCountRow = db
    .query(
      `SELECT COUNT(DISTINCT pe.label) AS n
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
        WHERE r.to_id = ? AND r.type = 'reviewed'`,
    )
    .get(pr.entityId) as { n: number } | null;
  const reviewerTotal = reviewerCountRow?.n ?? reviewerRows.length;
  const reviewerOverflow = reviewerTotal - reviewerRows.length;

  const openedBy =
    authorRow !== null ? `Opened by ${authorRow.label}` : "PR author not resolved in the graph.";
  // A total truncated silently is a lie by omission — name the cut, don't
  // hide it. Discloses the overflow inline as ", and N more", the same
  // truncation-disclosure format `packages/cli/src/commands/glossary.ts` uses
  // when rendering a truncated list (the `decisions` agent instead discloses
  // truncation via a separate gap note).
  const reviewerList =
    reviewerRows.map((r) => r.label).join(", ") +
    (reviewerOverflow > 0 ? `, and ${String(reviewerOverflow)} more` : "");
  const detail = reviewerRows.length === 0 ? openedBy : `${openedBy} · Reviewed by ${reviewerList}`;

  const finding: WhyFinding = {
    lane: "pull_request",
    title: `#${pr.number ?? "?"} ${pr.title}`,
    detail,
    url: pr.url,
    occurredAt: pr.modifiedAt,
    entityId: pr.entityId,
  };

  // Reviewers come from `review` items indexed off the GitHub events feed.
  // The gap note now means "no reviews indexed yet anywhere" or "this PR's
  // reviewed edges don't resolve to an indexed reviewer" — never
  // "unimplemented".
  const reviewedGap = detectUnresolvedReviewedRelation(db, pr.entityId);
  return reviewedGap !== null ? { findings: [finding], gap: reviewedGap } : { findings: [finding] };
}

// ---------------------------------------------------------------------------
// Lane 3: ticket
// ---------------------------------------------------------------------------

async function subTicket(db: Database, lane: LaneInput): Promise<SubAgentResult> {
  const sha = lane.blame?.commitSha;
  const pr = sha === undefined ? null : findPrForSha(db, sha);
  if (pr === null) return {};

  const rows = ticketRowsForPr(db, pr.entityId);
  if (rows.length === 0) {
    const gap = detectMissingRelationToEntityType(
      db,
      "resolves",
      "issue",
      "PR bodies emit `resolves` since 1a — reference the ticket key in the PR body.",
    );
    return gap !== null ? { gap } : {};
  }

  return {
    findings: rows.map((r) => ({
      lane: "ticket",
      title: `${r.key} ${r.title}`,
      detail: "Referenced from the merged PR.",
      url: r.url,
      occurredAt: r.modifiedAt,
      entityId: r.entityId,
    })),
  };
}

// ---------------------------------------------------------------------------
// Lane 4: discussion
// ---------------------------------------------------------------------------

async function subDiscussion(db: Database, lane: LaneInput): Promise<SubAgentResult> {
  const targetIds: string[] = [];
  const sha = lane.blame?.commitSha;
  if (sha !== undefined) {
    const commit = findCommitEntity(db, sha, lane.subject?.repoRoot ?? "");
    if (commit !== null) targetIds.push(commit.id);

    const pr = findPrForSha(db, sha);
    if (pr !== null) {
      targetIds.push(pr.entityId);
      const ticket = ticketRowsForPr(db, pr.entityId).at(0);
      if (ticket !== undefined) targetIds.push(ticket.entityId);
    }
  }

  let rows: Array<{
    id: string;
    title: string;
    body_preview: string | null;
    url: string | null;
    modified_at: number;
  }> = [];
  if (targetIds.length > 0) {
    const placeholders = targetIds.map(() => "?").join(",");
    rows = db
      .query(
        `SELECT m.id AS id, i.title AS title, i.body_preview AS body_preview, i.url AS url,
                i.modified_at AS modified_at
           FROM graph_relation r
           JOIN graph_entity m ON m.id = r.from_id AND m.type = 'message'
           JOIN item i ON i.id = m.external_id
          WHERE r.to_id IN (${placeholders}) AND r.type = 'mentions'
          ORDER BY i.modified_at DESC
          LIMIT 20`,
      )
      .all(...targetIds) as typeof rows;
  }

  if (rows.length === 0) {
    const gap = detectMissingRelationEmit(
      db,
      "mentions",
      "Messages emit `mentions` since 1a — connect Slack/Teams and sync.",
    );
    return gap !== null ? { gap } : {};
  }

  return {
    findings: rows.map((r) => ({
      lane: "discussion",
      title: r.title,
      detail: r.body_preview ?? "",
      url: r.url,
      occurredAt: r.modified_at,
      entityId: r.id,
    })),
  };
}

// ---------------------------------------------------------------------------
// Lane 5: driver
// ---------------------------------------------------------------------------

async function subDriver(db: Database, lane: LaneInput): Promise<SubAgentResult> {
  const missingEntityGap = detectMissingEntityType(db, "incident");
  if (missingEntityGap !== null) return { gap: missingEntityGap };

  const authorTimeMs = lane.blame?.authorTimeMs;
  if (authorTimeMs === null || authorTimeMs === undefined) return {};

  const rows = db
    .query(
      `SELECT e.id AS id, e.label AS label, i.url AS url,
              CAST(json_extract(e.metadata, '$.occurredAt') AS INTEGER) AS occurred_at
         FROM graph_entity e
         JOIN item i ON i.id = e.external_id
        WHERE e.type = 'incident'
          AND CAST(json_extract(e.metadata, '$.occurredAt') AS INTEGER) BETWEEN ? AND ?
        ORDER BY occurred_at DESC, e.id ASC
        LIMIT 10`,
    )
    .all(authorTimeMs - DRIVER_WINDOW_MS, authorTimeMs) as Array<{
    id: string;
    label: string;
    url: string | null;
    occurred_at: number;
  }>;

  const findings: WhyFinding[] = rows.map((r) => {
    const dep = db
      .query(
        `SELECT d.label AS label
           FROM graph_relation rel
           JOIN graph_entity d ON d.id = rel.from_id AND d.type = 'deployment'
          WHERE rel.to_id = ? AND rel.type = 'correlates_with'
          LIMIT 1`,
      )
      .get(r.id) as { label: string } | null;
    return {
      lane: "driver",
      title: r.label,
      detail:
        dep !== null
          ? `Correlated deployment: ${dep.label}`
          : "No correlated deployment within the 2h correlation window.",
      url: r.url,
      occurredAt: r.occurred_at,
      entityId: r.id,
    };
  });

  // Permanent honesty note: no populator emits `affects` — driver attribution
  // here is temporal (48h window), never causal.
  const affectsGap = detectMissingRelationEmit(
    db,
    "affects",
    "No populator emits `affects`; driver attribution is temporal (48 h window), not causal.",
  );

  const result: SubAgentResult = {};
  if (findings.length > 0) result.findings = findings;
  if (affectsGap !== null) result.gap = affectsGap;
  return result;
}

// ---------------------------------------------------------------------------
// Lane 6: downstream
// ---------------------------------------------------------------------------

const NO_SYMBOLS_DETAIL =
  "No indexed code symbols for this file — enable code_index on the root and sync.";

async function subDownstream(db: Database, lane: LaneInput): Promise<SubAgentResult> {
  if (lane.subject === null) {
    return { gap: { category: "missing_relation_emit", detail: NO_SYMBOLS_DETAIL } };
  }

  const symbols = db
    .query(
      `SELECT id, label FROM graph_entity
        WHERE type = 'symbol'
          AND json_extract(metadata, '$.file') = ?
          AND json_extract(metadata, '$.repoRoot') = ?
        LIMIT 20`,
    )
    .all(lane.subject.filePath, lane.subject.repoRoot) as Array<{ id: string; label: string }>;

  if (symbols.length === 0) {
    return { gap: { category: "missing_relation_emit", detail: NO_SYMBOLS_DETAIL } };
  }

  const seen = new Set<string>();
  const findings: WhyFinding[] = [];
  for (const sym of symbols) {
    for (const r of reverseDependsOn(db, sym.id, 25)) {
      if (seen.has(r.entityId)) continue;
      seen.add(r.entityId);
      findings.push({
        lane: "downstream",
        title: r.label,
        detail: `depends on ${sym.label}`,
        entityId: r.entityId,
        url: null,
        occurredAt: null,
      });
    }
  }

  if (findings.length === 0) {
    return {
      gap: {
        category: "missing_relation_emit",
        detail: "No reverse `depends_on` edges to this file's symbols.",
        remediation:
          "graph-populator currently emits `depends_on` only at workspace→package granularity; symbol-level `depends_on` is a populator follow-up.",
      },
    };
  }
  return { findings };
}
