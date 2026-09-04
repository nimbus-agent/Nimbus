import type { Database } from "bun:sqlite";

import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import { AgentCoordinator, type SubTask, type SubTaskResult } from "../engine/coordinator.ts";
import { resolveItemByUrl } from "../index/resolve-by-url.ts";
import type { BlameLookup } from "../security/blame-store.ts";
import { type BlameSpawn, ensureBlameLine } from "./_lib/blame-on-demand.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { GapNote, WhyChangeSubject, WhyItemSubject } from "./_lib/findings.ts";
import {
  aggregateMissingEntityTypes,
  detectEmptyIndex,
  detectMissingEntityType,
  detectMissingRelationEmit,
  detectMissingRelationToEntityType,
} from "./_lib/gap-notes.ts";
import { reverseDependsOn } from "./_lib/graph-traversals.ts";
import { resolvePrSubject } from "./_lib/pr-subject.ts";
import type { SynthesisRunner } from "./_lib/synthesis-llm.ts";
import { parseRef, resolveWhySubject } from "./_lib/why-subject.ts";
import type { WhyBrief, WhyFinding, WhyInput, WhyRefInput, WhySubject } from "./_lib/why-types.ts";
import { isWhyItemInput, isWhyPrInput } from "./_lib/why-types.ts";

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
  /**
   * The pull request the lanes answer about, resolved ONCE by whichever entry
   * point ran: blame -> sha -> findPrForSha on the ref arm, the index resolver
   * on the prUrl arm. The lanes must not care which — that is what makes this
   * an entry point rather than a second code path.
   */
  pr: PrForSha | null;
  /**
   * The indexed item the lanes answer about, on the `item` arm only — null on
   * every other arm, and null on `item` when the item had no graph entity.
   */
  itemEntityId: string | null;
  /** Blame's author time on the ref arm, the item's or PR's own timestamp otherwise. */
  occurredAt: number | null;
  /**
   * Which entry point ran. `subAuthorship` and `subDownstream` are file/line
   * lanes by nature — they stay silent on `"change"` and `"item"` alike rather
   * than reporting a gap for the file subject neither question ever had.
   * Explicit, not inferred from `subject === null`: inference would also silence
   * the genuine ref-arm case where a ref legitimately fails to resolve, which
   * must keep its gap note.
   */
  arm: "ref" | "change" | "item";
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

interface WhyLaneResolution {
  readonly subject: WhySubject | null;
  readonly blame: BlameLookup | null;
  readonly pr: PrForSha | null;
  /** `undefined` on the ref arm (the field is omitted entirely); `null` when a change */
  /** was asked about and could not be named. The two are NOT interchangeable. */
  readonly changeSubject: WhyChangeSubject | null | undefined;
  /** The same three states as `changeSubject`, for the `itemUrl` arm. */
  readonly itemSubject: WhyItemSubject | null | undefined;
  /**
   * The `graph_entity.id` the item lanes traverse from, on the `item` arm only.
   *
   * Always null when `itemSubject` is null: the two are decided together, because
   * an indexed item with no graph entity is precisely the case the lanes cannot
   * answer, and a subject without an entity would promise otherwise.
   */
  readonly itemEntityId: string | null;
  readonly queryRef: string;
  readonly queryLine: number | null;
}

/** The `--pr` arm: resolve the change subject and the PR shape the lanes consume. */
function resolvePrArm(db: Database, prUrl: string): WhyLaneResolution {
  const resolved = resolvePrSubject(db, prUrl);
  return {
    subject: null,
    blame: null,
    pr: resolved.ok
      ? {
          entityId: resolved.subject.entityId,
          number: resolved.subject.number,
          title: resolved.subject.title,
          url: resolved.subject.url,
          modifiedAt: resolved.subject.modifiedAt,
        }
      : null,
    // null, not absent: the caller asked about a change and we could not name it.
    changeSubject: resolved.ok ? resolved.subject : null,
    itemSubject: undefined,
    itemEntityId: null,
    queryRef: prUrl,
    queryLine: null,
  };
}

/**
 * The `itemUrl` arm: resolve the indexed item the lanes answer about.
 *
 * Two lookups, not one. `resolveItemByUrl` answers from the `item` table, but every
 * lane on this arm traverses `graph_relation`, which hangs off a `graph_entity` — and
 * `syncGraphFromIndexedItem` writes no entity for a type outside
 * `ITEM_LINKED_ENTITY_TYPES` / `GRAPH_SYNC_BY_TYPE`. A Confluence page (`type: "page"`)
 * is exactly that case: fully indexed, resolvable by URL, and with nothing for a lane to
 * walk.
 *
 * So "resolved, but no entity" is a MISS here. Returning a subject without an entity
 * would name an item the lanes then answer nothing about, which reads to a caller as
 * "no context exists" rather than "this kind of item carries none".
 */
/**
 * The PR that `resolves` this item, or null.
 *
 * The INVERSE of `ticketRowsForPr`'s traversal: that one walks `resolves` outward from a
 * `pr` entity to find the issues a change closed, this one walks inward from the issue to
 * find the change that closed it. The direction is the whole difference between the two
 * arms, and it is why the item arm could not simply reuse the PR arm's queries.
 */
function prResolvingItem(db: Database, itemEntityId: string): PrForSha | null {
  const row = db
    .query(
      `SELECT pe.id AS entity_id, i.title AS title, i.url AS url, i.modified_at AS modified_at,
              json_extract(i.metadata, '$.number') AS number
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'pr'
         JOIN item i ON i.id = pe.external_id
        WHERE r.to_id = ? AND r.type = 'resolves'
        ORDER BY i.modified_at DESC, pe.id ASC
        LIMIT 1`,
    )
    .get(itemEntityId) as {
    entity_id: string;
    title: string;
    url: string | null;
    modified_at: number;
    number: number | null;
  } | null;
  if (row === null) return null;
  return {
    entityId: row.entity_id,
    number: row.number,
    title: row.title,
    url: row.url,
    modifiedAt: row.modified_at,
  };
}

function resolveItemArm(db: Database, itemUrl: string): WhyLaneResolution {
  const miss: WhyLaneResolution = {
    subject: null,
    blame: null,
    pr: null,
    changeSubject: undefined,
    // null, not absent: the caller asked about an item and we could not name it.
    itemSubject: null,
    itemEntityId: null,
    queryRef: itemUrl,
    queryLine: null,
  };

  const resolved = resolveItemByUrl(db, itemUrl);
  if (!resolved.found) return miss;
  const item = resolved.item;

  // Constrained by type as well as external_id: `deterministicGraphEntityId` hashes
  // (type, externalId), so one external id can legitimately exist under more than one
  // type and a bare external_id lookup could return the wrong node.
  const entity = db
    .query("SELECT id FROM graph_entity WHERE external_id = ? AND type = ? LIMIT 1")
    .get(item.id, item.type) as { id?: string } | null;
  if (entity?.id === undefined) return miss;

  const numberRow = db
    .query("SELECT json_extract(metadata, '$.number') AS number FROM item WHERE id = ? LIMIT 1")
    .get(item.id) as { number: number | null } | null;

  return {
    subject: null,
    blame: null,
    // The PR that resolved this item, if one did — the inverse of the traversal the
    // prUrl arm makes. Populating `pr` here rather than teaching four lanes about items
    // is what keeps this arm small: `subPullRequest`, `subTicket`, `subDiscussion` and
    // `subDriver` already answer from `lane.pr`, and "the change that closed this issue"
    // is exactly what a `why` question about an issue is asking for.
    pr: prResolvingItem(db, entity.id),
    changeSubject: undefined,
    itemSubject: {
      itemId: item.id,
      entityId: entity.id,
      number: numberRow?.number ?? null,
      // `ResolveCandidate.url` is nullable and `WhyItemSubject.url` matches it. NOT a
      // fallback to `itemUrl`: that would substitute the URL we were asked with for the
      // one the item carries — a fabricated field inside a subject.
      url: item.url,
      title: item.title,
      // `modified_at` is `number` on a found candidate, not nullable. No `??` here.
      modifiedAt: item.modified_at,
      service: item.service,
      type: item.type,
    },
    itemEntityId: entity.id,
    queryRef: itemUrl,
    queryLine: null,
  };
}

/**
 * The ref arm. Resolve-once design: two lanes need the blamed SHA, and running `ensureBlameLine`
 * inside parallel sub-agents could double-spawn on a cold line. Resolve it here, once, and hand
 * the result to every lane.
 */
async function resolveRefArm(input: WhyRefInput, ctx: WhyContext): Promise<WhyLaneResolution> {
  const subject = resolveWhySubject(ctx.db, ctx.roots, input);
  let blame: BlameLookup | null = null;
  if (subject !== null && subject.lineNo !== null) {
    blame = await ensureBlameLine(
      ctx.db,
      { repoRoot: subject.repoRoot, filePath: subject.filePath },
      subject.lineNo,
      ctx.spawn,
    );
  }
  return {
    subject,
    blame,
    pr: blame === null ? null : findPrForSha(ctx.db, blame.commitSha),
    changeSubject: undefined,
    itemSubject: undefined,
    itemEntityId: null,
    queryRef: input.ref,
    queryLine: input.line ?? parseRef(input.ref).line,
  };
}

/** Decode the sub-agent results into findings + gap notes; a failed lane becomes a gap, not a throw. */
function collectLaneOutput(results: readonly SubTaskResult[]): {
  findings: WhyFinding[];
  gaps: GapNote[];
} {
  const findings: WhyFinding[] = [];
  const gaps: GapNote[] = [];
  for (const r of results) {
    if (r.status !== "done" || r.text === undefined) {
      gaps.push({
        category: "missing_connector",
        detail: `why sub-agent #${r.taskIndex} failed${
          r.errorText === undefined ? "" : `: ${r.errorText}`
        }`,
      });
      continue;
    }
    // Unguarded `JSON.parse` on purpose, and it stays safe only while this holds: `r.text` on a
    // `done` result is ALWAYS `JSON.stringify` of a locally-typed `SubAgentResult`, produced by
    // `makeSubAgent` above from one of the six lane functions in this file. No LLM output, no
    // network payload and no user input reaches it, so the text cannot be malformed and
    // `findings` cannot be a non-array. A throw inside `execute()` never arrives here either —
    // the coordinator converts it to `status: "error"`, which the branch above turns into a gap.
    //
    // A try/catch here today would be a branch no test could reach, which the branch-coverage
    // floor would then charge us for. If a lane is ever backed by a model or a remote call,
    // that stops being true: parse into `unknown`, validate, and route a bad payload down the
    // failed-lane gap path above.
    const decoded: SubAgentResult = JSON.parse(r.text);
    if (decoded.findings !== undefined) findings.push(...decoded.findings);
    if (decoded.gap !== undefined) gaps.push(decoded.gap);
  }
  return { findings, gaps };
}

/** Which arm a request names. One place, so the dispatch and `LaneInput.arm` cannot disagree. */
function armOf(input: WhyInput): LaneInput["arm"] {
  if (isWhyPrInput(input)) return "change";
  return isWhyItemInput(input) ? "item" : "ref";
}

/**
 * Which arm resolves this input's subject.
 *
 * The three arms are mutually exclusive and ORDERED — `isWhyPrInput` before `isWhyItemInput`
 * before the ref fallback — so the fallback is genuinely a fallback rather than a fourth case.
 * Written as guarded early returns rather than a chained conditional so that ordering is the
 * shape of the function instead of something a reader reconstructs from indentation.
 */
async function resolveArm(input: WhyInput, ctx: WhyContext): Promise<WhyLaneResolution> {
  if (isWhyPrInput(input)) return resolvePrArm(ctx.db, input.prUrl);
  if (isWhyItemInput(input)) return resolveItemArm(ctx.db, input.itemUrl);
  return resolveRefArm(input, ctx);
}

/**
 * The subject's timestamp, taken from the arm that resolved it and from nowhere else.
 *
 * Computed per-arm rather than through one shared nullish chain: on the ref arm
 * `blame.authorTimeMs` can itself be null (no `author-time` line in the `git blame
 * --line-porcelain` output) while `pr` is still non-null — a shared
 * `blame?.authorTimeMs ?? pr?.modifiedAt ?? null` would silently borrow the PR's timestamp
 * for a ref-arm answer, which is a different (and wrong) answer, not a missing one. The item
 * arm takes its own timestamp for the same reason, rather than borrowing the PR's. Written as
 * a switch over the arm so that "one arm, one source" is the shape of the function.
 */
function occurredAtOf(
  arm: LaneInput["arm"],
  sources: Pick<WhyLaneResolution, "blame" | "pr" | "itemSubject">,
): number | null {
  switch (arm) {
    case "item":
      return sources.itemSubject?.modifiedAt ?? null;
    case "change":
      return sources.pr?.modifiedAt ?? null;
    default:
      return sources.blame?.authorTimeMs ?? null;
  }
}

export async function runWhy(input: WhyInput, ctx: WhyContext): Promise<WhyBrief> {
  const start = performance.now();
  const preflightGaps: GapNote[] = [];
  const empty = detectEmptyIndex(ctx.db);
  if (empty !== null) preflightGaps.push(empty);

  const arm = armOf(input);
  const { subject, blame, pr, changeSubject, itemSubject, itemEntityId, queryRef, queryLine } =
    await resolveArm(input, ctx);

  const lane: LaneInput = {
    subject,
    blame,
    pr,
    itemEntityId,
    occurredAt: occurredAtOf(arm, { blame, pr, itemSubject }),
    arm,
  };

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
  const { findings: allFindings, gaps: laneGaps } = collectLaneOutput(results);

  const gaps = aggregateMissingEntityTypes([...preflightGaps, ...laneGaps]);

  return {
    kind: "why",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query: { ref: queryRef, line: queryLine },
    subject,
    ...(changeSubject === undefined ? {} : { changeSubject }),
    ...(itemSubject === undefined ? {} : { itemSubject }),
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
  // `number | null`, not `number`: findPrForSha's own row always has one (the
  // `item.modified_at` column is NOT NULL), but resolvePrSubject's
  // WhyChangeSubject — the prUrl arm's source for this field — types it
  // nullable across every connector, so PrForSha must accept both.
  modifiedAt: number | null;
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
  // Line-level by nature: a `prUrl` question never had a file/line subject to
  // begin with, so that absence is the shape of the question, not a gap in
  // anyone's index — nothing here is actionable on the change arm.
  // `change` and `item` alike: neither question ever had a file subject, so a gap
  // here would report something missing that was never asked for. The ref arm keeps
  // its gap, which is why this branches on the arm and not on `subject === null`.
  if (lane.arm !== "ref") return {};
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
  const pr = lane.pr;
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
  const pr = lane.pr;
  if (pr === null) return {};

  // On the item arm the PR was found BY walking `resolves` from this very item, so the
  // item is always in its own ticket list. Listing an issue as a ticket referenced by
  // the change that closed it is circular, not informative — drop it and report what
  // else that PR touched.
  const rows = ticketRowsForPr(db, pr.entityId).filter((r) => r.entityId !== lane.itemEntityId);
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
  // A commit-message thread genuinely needs the SHA — there is none on the
  // prUrl arm, so this half stays guarded on `lane.blame`.
  const sha = lane.blame?.commitSha;
  if (sha !== undefined) {
    const commit = findCommitEntity(db, sha, lane.subject?.repoRoot ?? "");
    if (commit !== null) targetIds.push(commit.id);
  }

  const pr = lane.pr;
  if (pr !== null) {
    targetIds.push(pr.entityId);
    const ticket = ticketRowsForPr(db, pr.entityId).at(0);
    if (ticket !== undefined) targetIds.push(ticket.entityId);
  }

  // The item itself, on the item arm. Added directly rather than via the PR, because a
  // discussion can mention an issue that no change ever closed — precisely the case where
  // this lane has something to say and no PR to reach it through.
  //
  // It may duplicate the ticket pushed just above, and that is harmless: `targetIds` is
  // spliced into an `IN (...)`, which is set membership, so a repeated id matches the same
  // rows once. (It is NOT de-duplicated first — do not add a `DISTINCT` here believing it
  // is compensating for that.)
  if (lane.itemEntityId !== null) targetIds.push(lane.itemEntityId);

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

  const occurredAt = lane.occurredAt;
  if (occurredAt === null) return {};

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
    .all(occurredAt - DRIVER_WINDOW_MS, occurredAt) as Array<{
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
  // File-shaped by nature — `agents.impact` already answers this question for
  // a `prUrl`, so a missing file subject here is the shape of the question,
  // not a gap in anyone's index.
  // `change` and `item` alike: neither question ever had a file subject, so a gap
  // here would report something missing that was never asked for. The ref arm keeps
  // its gap, which is why this branches on the arm and not on `subject === null`.
  if (lane.arm !== "ref") return {};
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
