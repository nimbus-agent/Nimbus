import type { Database } from "bun:sqlite";
import type { ParsedDoraRepoUrn, ServiceConfig } from "../metrics/dora-config.ts";
import { distinctCiServiceColumns, distinctPrServiceColumns } from "../metrics/dora-config.ts";

export type PreflightGap =
  | null
  // The service id is not in `[metrics.dora.<id>]` or `[ci.service.<id>]` at all, so no check
  // could run. Distinct from `no_repos`, which means the service EXISTS and has no repos bound
  // — a different, and much more fixable-looking, problem. See F24.
  | "unknown_service"
  | "no_pagerduty_mapping"
  | "no_repos"
  | "unknown_mergeable_state"
  | "pagerduty_urgency_without_priority";

export type IncidentFinding = {
  readonly id: string;
  readonly title: string;
  readonly status: "triggered" | "acknowledged";
  readonly severity: string;
  readonly opened_at_ms: number;
  readonly pagerduty_service_id: string;
  readonly url: string | null;
};

export type CiFinding = {
  readonly id: string;
  readonly title: string;
  readonly conclusion: "failure" | "cancelled" | "timed_out";
  readonly modified_at_ms: number;
  readonly branch: string;
  readonly head_sha: string | null;
  readonly url: string | null;
};

export type PrFinding = {
  readonly id: string;
  readonly title: string;
  readonly number: number;
  readonly mergeable_state: string;
  readonly modified_at_ms: number;
  readonly url: string | null;
};

export type PreflightCheck<F> = {
  readonly count: number;
  readonly findings: readonly F[];
  readonly gap: PreflightGap;
};

export type DeployPreflightResult = {
  readonly service: string;
  readonly target_ref: string;
  readonly computed_at: string;
  readonly verdict: "ok" | "warn";
  readonly checks: {
    readonly active_p1_incidents: PreflightCheck<IncidentFinding>;
    readonly failing_ci_runs: PreflightCheck<CiFinding>;
    readonly merge_conflicts: PreflightCheck<PrFinding>;
  };
};

const FAILED_CONCLUSIONS = ["failure", "cancelled", "timed_out"] as const;

function repoFilterClause(repos: readonly ParsedDoraRepoUrn[]): {
  clause: string;
  params: string[];
} {
  const repoIds = repos
    .filter((r) => r.provider === "github" || r.provider === "bitbucket" || r.provider === "gitlab")
    .map((r) => r.providerId);
  if (repoIds.length === 0) return { clause: "1=0", params: [] };
  const placeholders = repoIds.map(() => "?").join(",");
  return {
    clause: `(json_extract(metadata, '$.repo') IN (${placeholders}) OR json_extract(metadata, '$.project') IN (${placeholders}))`,
    params: [...repoIds, ...repoIds],
  };
}

function selectActiveP1Incidents(
  db: Database,
  cfg: ServiceConfig,
  maxFindings: number,
): { count: number; findings: IncidentFinding[]; gap: PreflightGap } {
  if (cfg.pagerdutyServices.length === 0) {
    return { count: 0, findings: [], gap: "no_pagerduty_mapping" };
  }
  const severityMatches = Array.from(new Set(["p1", ...cfg.severityP1Aliases]));
  const sevPlaceholders = severityMatches.map(() => "?").join(",");
  const pdPlaceholders = cfg.pagerdutyServices.map(() => "?").join(",");
  const where = `
    service = 'pagerduty'
    AND type = 'incident'
    AND json_extract(metadata, '$.pagerduty_service_id') IN (${pdPlaceholders})
    AND json_extract(metadata, '$.status') IN ('triggered', 'acknowledged')
    AND LOWER(json_extract(metadata, '$.severity')) IN (${sevPlaceholders})
  `;
  const countParams = [...cfg.pagerdutyServices, ...severityMatches];
  const countRow = db
    .query(`SELECT COUNT(*) as c FROM item WHERE ${where}`)
    .get(...countParams) as { c: number };
  const rows = db
    .query(
      `SELECT id, title, url, metadata
       FROM item
       WHERE ${where}
       ORDER BY json_extract(metadata, '$.opened_at_ms') DESC
       LIMIT ?`,
    )
    .all(...countParams, maxFindings) as {
    id: string;
    title: string;
    url: string | null;
    metadata: string;
  }[];
  const findings: IncidentFinding[] = rows.map((r) => {
    const meta = JSON.parse(r.metadata) as Record<string, unknown>;
    return {
      id: r.id,
      title: r.title,
      status: meta["status"] as "triggered" | "acknowledged",
      severity: typeof meta["severity"] === "string" ? meta["severity"] : "P1",
      opened_at_ms: typeof meta["opened_at_ms"] === "number" ? meta["opened_at_ms"] : 0,
      pagerduty_service_id:
        typeof meta["pagerduty_service_id"] === "string" ? meta["pagerduty_service_id"] : "",
      url: r.url,
    };
  });
  let gap: PreflightGap = null;
  if (countRow.c === 0) {
    const probeRow = db
      .query(
        `SELECT COUNT(*) as c FROM item
         WHERE service = 'pagerduty'
           AND type = 'incident'
           AND json_extract(metadata, '$.pagerduty_service_id') IN (${pdPlaceholders})
           AND json_extract(metadata, '$.status') IN ('triggered', 'acknowledged')
           AND json_extract(metadata, '$.urgency') = 'high'
           AND (json_extract(metadata, '$.severity') IS NULL
                OR json_extract(metadata, '$.severity') = '')`,
      )
      .get(...cfg.pagerdutyServices) as { c: number };
    if (probeRow.c > 0) gap = "pagerduty_urgency_without_priority";
  }
  return { count: countRow.c, findings, gap };
}

function selectFailingCiRuns(
  db: Database,
  cfg: ServiceConfig,
  targetRef: string,
  maxFindings: number,
): { count: number; findings: CiFinding[]; gap: PreflightGap } {
  const ciServices = distinctCiServiceColumns(cfg.repos);
  if (ciServices.length === 0) {
    return { count: 0, findings: [], gap: "no_repos" };
  }
  const servicePlaceholders = ciServices.map(() => "?").join(",");
  const conclusionPlaceholders = FAILED_CONCLUSIONS.map(() => "?").join(",");
  const sql = `
    WITH ranked AS (
      SELECT
        id, service, type, title, url, modified_at, metadata,
        ROW_NUMBER() OVER (
          PARTITION BY service, COALESCE(
            json_extract(metadata, '$.workflow_name'),
            title,
            COALESCE(json_extract(metadata, '$.headSha'), '') || ':' || COALESCE(json_extract(metadata, '$.branch'), '')
          )
          ORDER BY modified_at DESC
        ) AS rn
      FROM item
      WHERE service IN (${servicePlaceholders})
        AND type = 'ci_run'
        AND json_extract(metadata, '$.branch') = ?
        AND json_extract(metadata, '$.conclusion') IN (${conclusionPlaceholders})
    )
    SELECT id, title, url, modified_at, metadata FROM ranked WHERE rn = 1
  `;
  const params = [...ciServices, targetRef, ...FAILED_CONCLUSIONS];
  const allLatest = db.query(sql).all(...params) as {
    id: string;
    title: string;
    url: string | null;
    modified_at: number;
    metadata: string;
  }[];
  const count = allLatest.length;
  const findings: CiFinding[] = allLatest
    .slice()
    .sort((a, b) => b.modified_at - a.modified_at)
    .slice(0, maxFindings)
    .map((r) => {
      const meta = JSON.parse(r.metadata) as Record<string, unknown>;
      return {
        id: r.id,
        title: r.title,
        conclusion: meta["conclusion"] as "failure" | "cancelled" | "timed_out",
        modified_at_ms: r.modified_at,
        branch: typeof meta["branch"] === "string" ? meta["branch"] : targetRef,
        head_sha: typeof meta["headSha"] === "string" ? meta["headSha"] : null,
        url: r.url,
      };
    });
  return { count, findings, gap: null };
}

function selectMergeConflicts(
  db: Database,
  cfg: ServiceConfig,
  maxFindings: number,
): { count: number; findings: PrFinding[]; gap: PreflightGap } {
  const prServices = distinctPrServiceColumns(cfg.repos);
  if (prServices.length === 0) {
    return { count: 0, findings: [], gap: "no_repos" };
  }
  const servicePlaceholders = prServices.map(() => "?").join(",");
  const repoFilter = repoFilterClause(cfg.repos);
  const baseWhere = `
    service IN (${servicePlaceholders})
    AND type = 'pr'
    AND json_extract(metadata, '$.state') = 'open'
    AND ${repoFilter.clause}
  `;
  const countRow = db
    .query(
      `SELECT COUNT(*) as c FROM item
       WHERE ${baseWhere}
         AND json_extract(metadata, '$.mergeable_state') = 'dirty'`,
    )
    .get(...prServices, ...repoFilter.params) as { c: number };
  const nullRow = db
    .query(
      `SELECT COUNT(*) as c FROM item
       WHERE ${baseWhere}
         AND json_extract(metadata, '$.mergeable_state') IS NULL`,
    )
    .get(...prServices, ...repoFilter.params) as { c: number };
  const gap: PreflightGap = nullRow.c > 0 ? "unknown_mergeable_state" : null;
  const rows = db
    .query(
      `SELECT id, title, url, modified_at, metadata FROM item
       WHERE ${baseWhere}
         AND json_extract(metadata, '$.mergeable_state') = 'dirty'
       ORDER BY modified_at DESC
       LIMIT ?`,
    )
    .all(...prServices, ...repoFilter.params, maxFindings) as {
    id: string;
    title: string;
    url: string | null;
    modified_at: number;
    metadata: string;
  }[];
  const findings: PrFinding[] = rows.map((r) => {
    const meta = JSON.parse(r.metadata) as Record<string, unknown>;
    return {
      id: r.id,
      title: r.title,
      number: typeof meta["number"] === "number" ? meta["number"] : 0,
      mergeable_state:
        typeof meta["mergeable_state"] === "string" ? meta["mergeable_state"] : "dirty",
      modified_at_ms: r.modified_at,
      url: r.url,
    };
  });
  return { count: countRow.c, findings, gap };
}

export function computeDeployPreflight(
  db: Database,
  cfg: ServiceConfig,
  targetRef: string,
  nowMs: number,
  maxFindings: number,
): DeployPreflightResult {
  const incidents = selectActiveP1Incidents(db, cfg, maxFindings);
  const ciRuns = selectFailingCiRuns(db, cfg, targetRef, maxFindings);
  const conflicts = selectMergeConflicts(db, cfg, maxFindings);
  const verdict =
    incidents.count === 0 && ciRuns.count === 0 && conflicts.count === 0 ? "ok" : "warn";
  return {
    service: cfg.serviceId,
    target_ref: targetRef,
    computed_at: new Date(nowMs).toISOString(),
    verdict,
    checks: {
      active_p1_incidents: incidents,
      failing_ci_runs: ciRuns,
      merge_conflicts: conflicts,
    },
  };
}
