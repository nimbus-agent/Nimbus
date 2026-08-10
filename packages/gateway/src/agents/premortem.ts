import type { Database } from "bun:sqlite";

import { type CohortCandidate, type CohortResult, selectCohort } from "../premortem/cohort.ts";
import { affectedServicesForEpic } from "../premortem/epic-services.ts";
import { computeRisks, type Risk } from "../premortem/risks.ts";
import { type PremortemTheme, themesForServices } from "../premortem/theme-store.ts";
import { proposeWatchers, type WatcherProposal } from "../premortem/watcher-proposals.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { GapNote } from "./_lib/findings.ts";
import type { PremortemBrief, PremortemEpicView, PremortemInput } from "./_lib/premortem-types.ts";
import type { SynthesizerLlm } from "./_lib/synthesize.ts";

export type PremortemContext = {
  db: Database;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
  llm?: SynthesizerLlm;
};

const DEFAULT_MAX_CANDIDATE_SCAN = 200;
const DEFAULT_MAX_COHORT_SIZE = 10;
const DAY_MS = 86_400_000;
/** Below this span of cohort history, the honesty rule 1 gap fires. Judgment call, not a spec number. */
const HISTORY_SPAN_SHORT_MS = 180 * DAY_MS;

/**
 * "PROJ-120" or "jira:PROJ-120" both name the bare key `PROJ-120`. Any OTHER
 * prefix (`linear:ABC-1`, ...) names a tracker pre-mortem does not cover —
 * see the foreign-tracker branch in `runPremortem`, which recognizes this
 * from the prefix alone and never touches the database for it.
 */
function parseEpicRef(ref: string): { trackerPrefix: string | null; key: string } {
  const idx = ref.indexOf(":");
  if (idx === -1) return { trackerPrefix: null, key: ref };
  return { trackerPrefix: ref.slice(0, idx), key: ref.slice(idx + 1) };
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lower = sorted.at(mid - 1) ?? 0;
    const upper = sorted.at(mid) ?? 0;
    return (lower + upper) / 2;
  }
  return sorted.at(mid) ?? 0;
}

type ResolvedEpicRow = {
  id: string;
  external_id: string;
  title: string;
  created_at_ms: number | null;
};

/** Only a Jira item carrying `metadata.issue_type = 'Epic'` resolves — matching `selectCohort`'s own candidate filter. */
function resolveEpic(db: Database, key: string): ResolvedEpicRow | null {
  return db
    .query(
      `SELECT id, external_id, title,
              json_extract(metadata, '$.created_at_ms') AS created_at_ms
         FROM item
        WHERE service = 'jira' AND external_id = ?
          AND json_valid(metadata)
          AND json_extract(metadata, '$.issue_type') = 'Epic'`,
    )
    .get(key) as ResolvedEpicRow | null;
}

/**
 * The RAW child count (every `parent_key`-linked child, whether or not it
 * ever resolved to a service) — `computeRisks`'s `targetChildCount` input.
 * Mirrors `cohort.ts`'s `childCountsFor`, but for the single TARGET epic
 * rather than a batch of already-selected cohort candidates.
 */
function childCountFor(db: Database, epicItemId: string, epicKey: string): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS n
         FROM item child
        WHERE json_valid(child.metadata)
          AND json_extract(child.metadata, '$.parent_key') = ?
          AND child.service = (SELECT service FROM item WHERE id = ?)
          AND child.id <> ?`,
    )
    .get(epicKey, epicItemId, epicItemId) as { n: number };
  return row.n;
}

type PrDurationRow = { opened_at_ms: number; merged_at: number };

function toDurations(rows: readonly PrDurationRow[]): number[] {
  return rows.map((r) => r.merged_at - r.opened_at_ms).filter((d) => d >= 0);
}

/**
 * Median PR open→merge duration for the cohort children's own PRs.
 *
 * NEITHER GitHub, GitLab NOR Bitbucket sync (`connectors/{github,gitlab,bitbucket}-sync.ts`)
 * currently indexes a pull request's creation/opened timestamp — only its
 * merge time (`metadata.merged_at`). This queries `metadata.opened_at_ms`,
 * matching the naming PagerDuty already uses for incident open times
 * (`connectors/pagerduty-sync.ts`'s `opened_at_ms`), so review drag starts
 * working the moment any PR connector adds that field. Today no connector
 * does, so this returns `[]` and `reviewDragMedianMs`/`repoReviewMedianMs`
 * both come back `null` — `computeRisks` renders that as the "review drag
 * cannot be measured" gap, never a fabricated number.
 *
 * Reuses the SAME epic → child (`parent_key`, own-service) → `graph_entity`
 * (`issue`) → `resolves` edge → `graph_entity` (`pr`) traversal
 * `affectedServicesForEpic` established, extended one hop further from the
 * PR's graph entity to the PR's own `item` row for its timing metadata.
 */
function cohortPrDurations(db: Database, epicItemIds: readonly string[]): number[] {
  if (epicItemIds.length === 0) {
    return [];
  }
  const placeholders = epicItemIds.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT DISTINCT pr_item.id AS id,
              json_extract(pr_item.metadata, '$.opened_at_ms') AS opened_at_ms,
              json_extract(pr_item.metadata, '$.merged_at')    AS merged_at
         FROM item epic
         JOIN item child ON json_valid(child.metadata)
                          AND json_extract(child.metadata, '$.parent_key') = epic.external_id
                          AND child.service = epic.service
                          AND child.id <> epic.id
         JOIN graph_entity child_ent ON child_ent.type = 'issue'
                                      AND child_ent.external_id = child.id
         JOIN graph_relation res     ON res.to_id = child_ent.id AND res.type = 'resolves'
         JOIN graph_entity pr_ent    ON pr_ent.id = res.from_id AND pr_ent.type = 'pr'
         JOIN item pr_item           ON pr_item.id = pr_ent.external_id
        WHERE epic.id IN (${placeholders})
          AND json_valid(pr_item.metadata)
          AND json_extract(pr_item.metadata, '$.opened_at_ms') IS NOT NULL
          AND json_extract(pr_item.metadata, '$.merged_at') IS NOT NULL`,
    )
    .all(...epicItemIds) as Array<{ id: string; opened_at_ms: number; merged_at: number }>;
  return toDurations(rows);
}

/** The repo-wide baseline over the same services, merged within the cohort's own indexed window. */
function repoPrDurations(
  db: Database,
  services: readonly string[],
  windowFromMs: number,
  windowToMs: number,
): number[] {
  if (services.length === 0) {
    return [];
  }
  const placeholders = services.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT json_extract(metadata, '$.opened_at_ms') AS opened_at_ms,
              json_extract(metadata, '$.merged_at')    AS merged_at
         FROM item
        WHERE type = 'pr'
          AND json_valid(metadata)
          AND json_extract(metadata, '$.repo') IN (${placeholders})
          AND json_extract(metadata, '$.opened_at_ms') IS NOT NULL
          AND json_extract(metadata, '$.merged_at') IS NOT NULL
          AND json_extract(metadata, '$.merged_at') BETWEEN ? AND ?`,
    )
    .all(...services, windowFromMs, windowToMs) as Array<{
    opened_at_ms: number;
    merged_at: number;
  }>;
  return toDurations(rows);
}

function reviewDragMedians(
  db: Database,
  cohort: CohortResult,
  services: readonly string[],
  nowMs: number,
): { reviewDragMedianMs: number | null; repoReviewMedianMs: number | null } {
  const cohortDurations = cohortPrDurations(
    db,
    cohort.members.map((m) => m.itemId),
  );
  if (cohortDurations.length === 0) {
    // Pass null for EITHER median when the cohort has no PRs (Task 4 contract) —
    // there is nothing to compare a repo baseline against either.
    return { reviewDragMedianMs: null, repoReviewMedianMs: null };
  }
  const windowFromMs = cohort.oldestResolvedAtMs ?? nowMs;
  const repoDurations = repoPrDurations(db, services, windowFromMs, nowMs);
  return {
    reviewDragMedianMs: median(cohortDurations),
    repoReviewMedianMs: median(repoDurations),
  };
}

/**
 * The count of cohort epics having an incident `correlates_with` a deploy of
 * one of THAT epic's own services, during THAT epic's own window
 * (`createdAtMs` .. `resolvedAtMs`). Reuses the `correlates_with` edge
 * `graph/graph-populator.ts`'s `syncTimelineEventGraph` already writes
 * (deployment --correlates_with--> incident, keyed on
 * `metadata.affectedService`) — no second correlation rule.
 */
function countIncidentCoupledEpics(db: Database, members: readonly CohortCandidate[]): number {
  let count = 0;
  for (const member of members) {
    if (member.services.length === 0) {
      continue;
    }
    const windowFrom = member.createdAtMs ?? member.resolvedAtMs;
    const windowTo = member.resolvedAtMs;
    const placeholders = member.services.map(() => "?").join(", ");
    const row = db
      .query(
        `SELECT 1
           FROM graph_entity dep
           JOIN graph_relation rel ON rel.from_id = dep.id AND rel.type = 'correlates_with'
           JOIN graph_entity inc  ON inc.id = rel.to_id AND inc.type = 'incident'
          WHERE dep.type = 'deployment'
            AND json_valid(dep.metadata)
            AND json_extract(dep.metadata, '$.affectedService') IN (${placeholders})
            AND json_extract(dep.metadata, '$.occurredAt') BETWEEN ? AND ?
          LIMIT 1`,
      )
      .get(...member.services, windowFrom, windowTo);
    if (row !== null) {
      count++;
    }
  }
  return count;
}

/** Honesty rule 2: rows with `body_complete = 0`, over the cohort's own member items. */
function cohortBodyTruncation(
  db: Database,
  itemIds: readonly string[],
): { total: number; truncated: number } {
  if (itemIds.length === 0) {
    return { total: 0, truncated: 0 };
  }
  const placeholders = itemIds.map(() => "?").join(", ");
  const row = db
    .query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN body_complete = 0 THEN 1 ELSE 0 END), 0) AS truncated
         FROM item
        WHERE id IN (${placeholders})`,
    )
    .get(...itemIds) as { total: number; truncated: number };
  return row;
}

function nonJiraTrackerDetail(epicRef: string, trackerPrefix: string): string {
  if (trackerPrefix.toLowerCase() === "linear") {
    return (
      `\`${epicRef}\` is a Linear reference. Pre-mortem covers Jira epics only, ` +
      "and no Linear project items are indexed."
    );
  }
  return `\`${epicRef}\` is not a Jira epic reference — pre-mortem covers Jira epics only.`;
}

function noChildrenDetail(epicKey: string): string {
  return (
    `\`${epicKey}\` has no \`parent_key\` children in the index. This looks like a ` +
    "company-managed Jira project (`parent_key` is only populated for team-managed projects) " +
    "— pass `--service`, or re-run once child PRs land."
  );
}

function noChildrenWithPrsDetail(epicKey: string, childCount: number): string {
  return (
    `\`${epicKey}\` has ${String(childCount)} child item(s), but none resolve to a merged ` +
    "pull request yet, so no affected service could be derived — pass `--service`, or re-run " +
    "once child PRs land."
  );
}

/**
 * The four honesty rules, plus the two B2-specific statements, all
 * unconditional — pushed on EVERY brief regardless of which branch above
 * produced it, mirroring `ownership.ts`'s own unconditional authorship-limit
 * note (always the last push in its `buildGaps`, reached from every branch).
 */
function pushUnconditionalGaps(gaps: GapNote[]): void {
  gaps.push(
    {
      category: "missing_relation_emit",
      detail:
        '"Comparable" means these epics touched some of the same services. It does not mean ' +
        "they were architecturally or organisationally similar, and these are correlations, " +
        "not causes.",
    },
    {
      category: "missing_connector",
      detail:
        "Theme confidence tops out at 0.86, not 1.0: no connector indexes ticket comments, so " +
        "a blocker argued out entirely in a Jira comment thread is invisible to theme " +
        "extraction.",
    },
    {
      category: "missing_connector",
      detail:
        "Pre-mortem covers Jira epics only, and only `parent_key`-linked children on " +
        "team-managed projects — other trackers (e.g. Linear) are not indexed for this brief, " +
        "and a company-managed Jira project's children cannot be traced the same way.",
    },
    {
      category: "missing_relation_emit",
      detail:
        "No deploy-failure watcher is proposed: a deployment item's `item.service` is the " +
        "annotate provider slug (e.g. `github-actions`), while the watcher engine matches " +
        "syncable service ids, so a service-filtered deploy-failure watcher could never fire.",
    },
  );
}

function emptyCohort(): CohortResult {
  return { members: [], scannedCount: 0, oldestResolvedAtMs: null };
}

/**
 * The four lanes, IN ORDER — not via `AgentCoordinator`, unlike the
 * independent-lane agents (`ownership.ts`, `decisions.ts`): each lane here
 * depends on the previous one's output (services -> cohort -> risks; services
 * -> themes), so there is no independent work to parallelize, and `bun:sqlite`
 * is synchronous regardless — wrapping these calls in `Promise.all` would
 * change nothing about wall-clock time, only add a layer that looks parallel
 * and is not.
 *
 * Lane 1: resolve `epicRef` to a Jira epic; `--service` overrides derivation
 * entirely. Lane 2: `selectCohort`. Lane 3: `computeRisks`, fed the three
 * queries this module owns (`reviewDragMedianMs`, `repoReviewMedianMs`,
 * `incidentCoupledCount`). Lane 4: `themesForServices` — no model call on
 * this path; `proposeWatchers` runs alongside it.
 */
export async function runPremortem(
  input: PremortemInput,
  ctx: PremortemContext,
): Promise<PremortemBrief> {
  const start = performance.now();
  const now = Date.now();
  const overrides = input.serviceOverrides ?? [];
  const query = {
    epicRef: input.epicRef,
    serviceOverrides: overrides.length > 0 ? overrides : null,
  };

  const { trackerPrefix, key } = parseEpicRef(input.epicRef);

  if (trackerPrefix !== null && trackerPrefix.toLowerCase() !== "jira") {
    const gaps: GapNote[] = [
      {
        category: "missing_relation_emit",
        detail: nonJiraTrackerDetail(input.epicRef, trackerPrefix),
        remediation: "Pass a Jira epic key, e.g. `PROJ-120` or `jira:PROJ-120`.",
      },
    ];
    pushUnconditionalGaps(gaps);
    return {
      kind: "premortem",
      agentVersion: 1,
      generatedAt: now,
      latencyMs: Math.round(performance.now() - start),
      gaps,
      query,
      epic: null,
      services: [],
      cohort: emptyCohort(),
      risks: [],
      themes: [],
      watchers: [],
    };
  }

  const epicRow = resolveEpic(ctx.db, key);
  if (epicRow === null) {
    throw new Error(`pre-mortem: epic '${input.epicRef}' was not found in the local Jira index`);
  }
  const epic: PremortemEpicView = {
    itemId: epicRow.id,
    key: epicRow.external_id,
    title: epicRow.title,
  };

  const childCount = childCountFor(ctx.db, epic.itemId, epic.key);
  const derivedServices = affectedServicesForEpic(ctx.db, epic.itemId, epic.key);
  const services = overrides.length > 0 ? overrides : derivedServices;

  const gaps: GapNote[] = [];
  let cohort: CohortResult = emptyCohort();
  let risks: Risk[] = [];
  let themes: PremortemTheme[] = [];
  let watchers: WatcherProposal[] = [];

  if (services.length === 0) {
    gaps.push({
      category: "missing_relation_emit",
      detail:
        childCount === 0
          ? noChildrenDetail(epic.key)
          : noChildrenWithPrsDetail(epic.key, childCount),
      remediation: "Pass `--service <repo>`, or re-run once child PRs land.",
    });
  } else {
    cohort = selectCohort(ctx.db, services, {
      maxCandidateScan: DEFAULT_MAX_CANDIDATE_SCAN,
      maxCohortSize: DEFAULT_MAX_COHORT_SIZE,
      excludeItemId: epic.itemId,
    });

    if (cohort.members.length === 0) {
      // No project-based fallback cohort — a named gap, never a silent
      // substitute comparing unrelated work.
      gaps.push({
        category: "missing_entity_type",
        detail:
          `No past epics touching ${services.join(", ")} closed in the indexed window ` +
          `(${String(cohort.scannedCount)} candidate epic(s) scanned).`,
        remediation:
          "Widen history with `nimbus index rebody --service jira --since <days>`, or check " +
          "that `--service` names match real repos.",
      });
    } else {
      const { reviewDragMedianMs, repoReviewMedianMs } = reviewDragMedians(
        ctx.db,
        cohort,
        services,
        now,
      );
      const incidentCoupledCount = countIncidentCoupledEpics(ctx.db, cohort.members);

      risks = computeRisks({
        cohort: cohort.members,
        targetChildCount: childCount,
        targetCreatedAtMs: epicRow.created_at_ms ?? now,
        nowMs: now,
        reviewDragMedianMs,
        repoReviewMedianMs,
        incidentCoupledCount,
        // Pre-mortem is Jira-only (the unconditional gap above states this),
        // so the cohort can never blend trackers with different cancel/done
        // semantics.
        cohortIsMixedTracker: false,
      });

      themes = themesForServices(ctx.db, services);
      if (themes.length === 0) {
        gaps.push({
          category: "missing_connector",
          detail:
            "No pre-mortem themes have been extracted for these services yet — the theme " +
            "pass may not have run, may be disabled (`[premortem].use_llm = false`), or no " +
            "local LLM was reachable. The risk figures above are structural findings only, " +
            "unaffected by this.",
          remediation: "Run `nimbus premortem --refresh`, or configure a local model and re-run.",
        });
      }

      watchers = proposeWatchers(ctx.db, { epicItemId: epic.itemId, services, nowMs: now });

      // Honesty rule 1 (conditional) — history span, silent when deep.
      if (
        cohort.oldestResolvedAtMs !== null &&
        now - cohort.oldestResolvedAtMs < HISTORY_SPAN_SHORT_MS
      ) {
        gaps.push({
          category: "missing_connector",
          detail:
            `${String(cohort.members.length)} epic(s), oldest closed ${isoDay(cohort.oldestResolvedAtMs)} ` +
            "— this is a short history, so the comparison above may not be representative yet.",
          remediation:
            "Run `nimbus index rebody --service jira --since <days>` to widen indexed history.",
        });
      }

      // Honesty rule 2 (conditional) — truncated bodies, silent when none.
      const truncation = cohortBodyTruncation(
        ctx.db,
        cohort.members.map((m) => m.itemId),
      );
      if (truncation.truncated > 0) {
        gaps.push({
          category: "missing_relation_emit",
          detail:
            `${String(truncation.truncated)} of ${String(truncation.total)} source(s) in this ` +
            "cohort were indexed with a truncated body.",
        });
      }
    }
  }

  pushUnconditionalGaps(gaps);

  return {
    kind: "premortem",
    agentVersion: 1,
    generatedAt: now,
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query,
    epic,
    services,
    cohort,
    risks,
    themes,
    watchers,
  };
}

export function emitPremortemBrief(
  input: PremortemInput,
  ctx: PremortemContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "premortem.briefReady",
    briefErrorMethod: "premortem.briefError",
    notify: ctx.notify,
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    buildBrief: () => runPremortem(input, ctx),
  });
}
