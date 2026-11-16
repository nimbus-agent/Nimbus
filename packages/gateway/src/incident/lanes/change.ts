import type { Database } from "bun:sqlite";

import {
  selectChangeForDeployment,
  selectCiRunForDeployment,
  selectLastDeploymentBefore,
} from "../../agents/_lib/oncall-queries.ts";
import { deterministicGraphEntityId } from "../../graph/relationship-graph.ts";
import { distinctPrServiceColumns, type ServiceConfig } from "../../metrics/dora-config.ts";
import type {
  ChangeLane,
  CiView,
  DeploymentView,
  GapNote,
  PrView,
} from "../incident-record-types.ts";
import { gap, oneLine } from "./caps.ts";

/**
 * Lane 2, change (Phase 10 IC3, design C step 4): the last deployment before the trigger opened, inside the
 * service's `incident_window_minutes`; then the commit, the pull request and the CI run behind it, first through
 * the IC2 graph edges (`deployed`, `merged_as`, `built_by`), then through the SQL joins the shipped `oncall`
 * brief uses. TIMING ONLY: a deployment is "the last deployment before the alert", never a proven cause.
 */

export type ChangeResult = { readonly lane: ChangeLane; readonly gaps: readonly GapNote[] };

const MINUTE_MS = 60_000;

type ItemMeta = {
  id: string;
  service: string;
  title: string;
  url: string | null;
  modified_at: number;
  metadata: string | null;
};

function parseMeta(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function itemById(db: Database, id: string): ItemMeta | null {
  return db
    .query("SELECT id, service, title, url, modified_at, metadata FROM item WHERE id = ?")
    .get(id) as ItemMeta | null;
}

function prViewFromItem(item: ItemMeta, rule: PrView["rule"]): PrView {
  const meta = parseMeta(item.metadata);
  // lane-census: scope=pr service=github
  return {
    id: item.id,
    title: oneLine(item.title),
    url: item.url,
    service: item.service,
    mergedAtMs: num(meta["merged_at"]),
    additions: num(meta["additions"]),
    deletions: num(meta["deletions"]),
    changedFiles: num(meta["changed_files"]),
    rule,
  };
}

function ciViewFromItem(item: ItemMeta, rule: CiView["rule"]): CiView {
  const meta = parseMeta(item.metadata);
  // lane-census: scope=ci_run service=github_actions
  const conclusion = meta["conclusion"];
  return {
    id: item.id,
    title: oneLine(item.title),
    url: item.url,
    service: item.service,
    conclusion: typeof conclusion === "string" && conclusion !== "" ? conclusion : null,
    atMs: item.modified_at,
    rule,
  };
}

/** The target item ids of `type` edges leaving a deployment entity, to an entity of `entityType`, by id. */
function linkedItemIds(
  db: Database,
  fromEntityId: string,
  relation: "deployed" | "built_by",
  entityType: "ci_run" | "commit",
): string[] {
  return (
    db
      .query(
        `SELECT t.external_id AS ext FROM graph_relation r
           JOIN graph_entity t ON t.id = r.to_id
          WHERE r.from_id = ? AND r.type = ? AND t.type = ?
          ORDER BY t.external_id ASC`,
      )
      .all(fromEntityId, relation, entityType) as { ext: string }[]
  ).map((r) => r.ext);
}

function prItemIdsMergedInto(db: Database, commitExternalIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const ext of commitExternalIds) {
    const rows = db
      .query(
        `SELECT p.external_id AS ext FROM graph_entity c
           JOIN graph_relation m ON m.to_id = c.id AND m.type = 'merged_as'
           JOIN graph_entity p ON p.id = m.from_id AND p.type = 'pr'
          WHERE c.type = 'commit' AND c.external_id = ?
          ORDER BY p.external_id ASC`,
      )
      .all(ext) as { ext: string }[];
    for (const r of rows) out.push(r.ext);
  }
  return out;
}

/** A `correlates_with` edge from this deployment to the trigger's entity, or null when the trigger has none. */
function graphCorrelated(
  db: Database,
  deploymentId: string,
  triggerEntityType: string,
  triggerItemId: string,
): boolean | null {
  const triggerEntityId = deterministicGraphEntityId(triggerEntityType, triggerItemId);
  const exists = db.query("SELECT 1 AS n FROM graph_entity WHERE id = ?").get(triggerEntityId);
  if (exists === null) return null;
  const edge = db
    .query(
      "SELECT 1 AS n FROM graph_relation WHERE from_id = ? AND to_id = ? AND type = 'correlates_with'",
    )
    .get(deterministicGraphEntityId("deployment", deploymentId), triggerEntityId);
  return edge !== null;
}

/** The graph entity type a trigger item is written under (`graph/graph-populator.ts`). */
export function triggerEntityTypeOf(service: string): string {
  if (service === "pagerduty") return "incident";
  if (service === "jira") return "alert";
  if (service === "sentry") return "error_issue";
  return "data_quality_test";
}

function deploymentView(
  d: NonNullable<ReturnType<typeof selectLastDeploymentBefore>>,
  openedAtMs: number,
): DeploymentView {
  return {
    id: d.id,
    title: oneLine(d.title),
    url: d.url,
    provider: d.provider,
    environment: d.environment,
    sha: d.sha,
    ref: d.ref,
    startedAtMs: d.startedAtMs,
    finishedAtMs: d.finishedAtMs,
    conclusion: d.conclusion,
    minutesBeforeOpen: Math.floor((openedAtMs - d.startedAtMs) / MINUTE_MS),
    rule: "last_deployment_before_open",
  };
}

function forgeGap(cfg: ServiceConfig): GapNote | null {
  const forges = new Set(cfg.repos.map((r) => r.provider));
  const nonGithub = ["gitlab", "bitbucket"].filter((p) => forges.has(p as "gitlab"));
  if (nonGithub.length === 0) return null;
  return gap(
    "missing_relation_emit",
    `The pull request behind a deployment is found only on GitHub: ${nonGithub.join(" and ")} writes no merge-commit link, so a deployment of such a repository gets no pull request here and its absence says nothing about whether a change shipped.`,
  );
}

function emptyLane(skipped: ChangeLane["skipped"]): ChangeLane {
  return { skipped, deployment: null, graphCorrelated: null, pr: null, ci: null };
}

function pickPr(
  db: Database,
  dep: DeploymentView,
  cfg: ServiceConfig,
  depEntityId: string,
): PrView | null {
  const commits = linkedItemIds(db, depEntityId, "deployed", "commit");
  for (const id of prItemIdsMergedInto(db, commits)) {
    const item = itemById(db, id);
    if (item !== null) return prViewFromItem(item, "graph:deployed+merged_as");
  }
  const sql = selectChangeForDeployment(db, dep.sha, distinctPrServiceColumns(cfg.repos));
  if (sql === null) return null;
  const item = itemById(db, sql.id);
  return item === null
    ? {
        id: sql.id,
        title: oneLine(sql.title),
        url: sql.url,
        service: sql.service,
        mergedAtMs: sql.mergedAtMs,
        additions: sql.additions,
        deletions: sql.deletions,
        changedFiles: sql.changedFiles,
        rule: "merge_commit_sha",
      }
    : prViewFromItem(item, "merge_commit_sha");
}

function pickCi(db: Database, ciRunExternalId: string | null, depEntityId: string): CiView | null {
  for (const id of linkedItemIds(db, depEntityId, "built_by", "ci_run")) {
    const item = itemById(db, id);
    if (item !== null) return ciViewFromItem(item, "graph:built_by");
  }
  const sql = selectCiRunForDeployment(db, ciRunExternalId);
  if (sql === null) return null;
  const item = itemById(db, sql.id);
  return item === null ? null : ciViewFromItem(item, "ci_run_external_id");
}

function linkGaps(
  dep: DeploymentView,
  cfg: ServiceConfig,
  pr: PrView | null,
  ci: CiView | null,
  ciRunExternalId: string | null,
): GapNote[] {
  const out: GapNote[] = [];
  const forge = forgeGap(cfg);
  if (dep.sha === "") {
    out.push(gap("missing_relation_emit", "No deployed commit is recorded for this deployment."));
  } else if (pr === null && forge !== null) {
    out.push(forge);
  }
  if (ci === null) {
    out.push(
      ciRunExternalId === null
        ? gap(
            "missing_relation_emit",
            "This deployment carries no CI run link (it was annotated, not synced from CI), so the CI result is unknown, which does not mean no CI ran.",
          )
        : gap("missing_connector", "The CI run behind this deployment is not in the index."),
    );
  }
  return out;
}

/**
 * The change lane for a bound trigger with an open time. The nearest earlier deployment outside the service's
 * window is NOT a candidate; a gap names its distance.
 */
export function changeLane(
  db: Database,
  input: {
    readonly cfg: ServiceConfig;
    readonly triggerItemId: string;
    readonly triggerService: string;
    readonly openedAtMs: number;
  },
): ChangeResult {
  const { cfg, openedAtMs } = input;
  const last = selectLastDeploymentBefore(db, cfg.serviceId, cfg.deployEnvironments, openedAtMs);
  if (last === null) {
    return {
      lane: emptyLane(null),
      gaps: [
        gap(
          "missing_entity_type",
          `No deployment of \`${cfg.serviceId}\` before this item opened is in the index.`,
          "Annotate deployments with `POST /v1/deployments` or sync a CI/CD connector bound to the service.",
        ),
      ],
    };
  }
  const dep = deploymentView(last, openedAtMs);
  const windowMin = cfg.incidentWindowMinutes;
  if (dep.minutesBeforeOpen > windowMin) {
    return {
      lane: emptyLane(null),
      gaps: [
        gap(
          "missing_relation_emit",
          `The last deployment was ${String(dep.minutesBeforeOpen)} minutes before, outside the configured window of ${String(windowMin)} minutes, so it is not listed as a candidate.`,
        ),
      ],
    };
  }
  const depEntityId = deterministicGraphEntityId("deployment", last.id);
  const pr = pickPr(db, dep, cfg, depEntityId);
  const ci = pickCi(db, last.ciRunExternalId, depEntityId);
  return {
    lane: {
      skipped: null,
      deployment: dep,
      graphCorrelated: graphCorrelated(
        db,
        last.id,
        triggerEntityTypeOf(input.triggerService),
        input.triggerItemId,
      ),
      pr,
      ci,
    },
    gaps: linkGaps(dep, cfg, pr, ci, last.ciRunExternalId),
  };
}

export function skippedChange(reason: "unbound" | "no_open_time"): ChangeResult {
  return { lane: emptyLane(reason), gaps: [] };
}
