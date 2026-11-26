// Phase 7 (the Cost Pack): the change context `nimbus cost why` shows beside a cost comparison - per service, the
// deploys in the range (those near the spike day first), the pull request each deploy shipped (joined by sha) and
// the service's owners.
//
// It lives here and not in `finops/` because static rule D48 keeps `finops/` free of `agents/` and of deploy,
// pull-request and owner types: the IPC layer calls this and passes the result beside the `CostWhy` that
// `finops/cost-why.ts` computes. Read only: no write, no network, no model; bound parameters only (I9).
// Nothing is guessed from names: a deploy is listed only for a configured service, by its `nimbus_service_id`.
import type { Database } from "bun:sqlite";

import { distinctPrServiceColumns, type ServiceConfig } from "../../metrics/dora-config.ts";
import { findServiceEntity, ownersOf } from "../../ownership/ownership-store.ts";

const DAY_MS = 86_400_000;
export const COST_WHY_MAX_DEPLOYS = 10;
export const COST_WHY_MAX_OWNERS = 3;

export interface CostChangePr {
  readonly repo: string | null;
  readonly number: number | null;
  readonly title: string;
  readonly url: string | null;
  readonly author: string | null;
}

export interface CostChangeDeploy {
  readonly sha: string;
  readonly environment: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
  readonly conclusion: string;
  readonly url: string | null;
  /** The CI run id: `ci_run_external_id`, else the annotation's `run_id` in the item metadata. */
  readonly runId: string | null;
  /** On the spike day, the day before or the day after. */
  readonly nearSpike: boolean;
  readonly pr: CostChangePr | null;
}

export interface CostChangeContext {
  readonly serviceId: string;
  readonly configured: boolean;
  readonly deploys: CostChangeDeploy[];
  readonly deploysTruncated: number;
  readonly owners: { readonly label: string; readonly share: number; readonly resolved: boolean }[];
  readonly gaps: string[];
}

export interface CostChangeContextInput {
  readonly serviceIds: readonly string[];
  readonly services: ReadonlyMap<string, ServiceConfig>;
  /** Inclusive. */
  readonly fromMs: number;
  /** Exclusive. */
  readonly toMs: number;
  /** UTC midnight of the spike day, or null when there is none. */
  readonly spikeDayMs: number | null;
  readonly maxDeploys?: number;
}

type DeployRow = {
  sha: string;
  environment: string;
  started_at_ms: number;
  finished_at_ms: number | null;
  conclusion: string;
  workflow_url: string | null;
  run_id: string | number | null;
};

type PrRow = {
  title: string;
  url: string | null;
  external_id: string;
  metadata: string | null;
  display_name: string | null;
};

function metaRecord(raw: string | null): Record<string, unknown> {
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

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) ? v : null;

/** `owner/repo#N` from an external id, when the metadata names neither. */
function splitExternalId(externalId: string): { repo: string | null; number: number | null } {
  const m = /^([^#\s]+\/[^#\s]+)#(\d+)$/.exec(externalId);
  if (m?.[1] === undefined || m[2] === undefined) return { repo: null, number: null };
  return { repo: m[1], number: Number(m[2]) };
}

function selectPr(db: Database, sha: string, prServices: readonly string[]): CostChangePr | null {
  if (sha === "" || prServices.length === 0) return null;
  const placeholders = prServices.map(() => "?").join(",");
  const row = db
    .query(
      `SELECT i.title AS title, i.url AS url, i.external_id AS external_id, i.metadata AS metadata,
              p.display_name AS display_name
         FROM item i
         LEFT JOIN person p ON p.id = i.author_id
        WHERE i.type = 'pr'
          AND i.service IN (${placeholders})
          AND json_valid(i.metadata)
          AND json_extract(i.metadata, '$.merge_commit_sha') = ?
        ORDER BY i.id ASC
        LIMIT 1`,
    )
    .get(...prServices, sha) as PrRow | null;
  if (row === null) return null;
  const meta = metaRecord(row.metadata);
  const fallback = splitExternalId(row.external_id);
  // lane-census: scope=pr
  return {
    repo: str(meta["repo"]) ?? fallback.repo,
    number: int(meta["number"]) ?? fallback.number,
    title: row.title,
    url: row.url,
    author: str(row.display_name) ?? str(meta["user"]),
  };
}

function selectDeploys(db: Database, serviceId: string, fromMs: number, toMs: number): DeployRow[] {
  return db
    .query(
      `SELECT d.sha AS sha, d.environment AS environment, d.started_at_ms AS started_at_ms,
              d.finished_at_ms AS finished_at_ms, d.conclusion AS conclusion, d.workflow_url AS workflow_url,
              COALESCE(d.ci_run_external_id,
                CASE WHEN json_valid(i.metadata) THEN json_extract(i.metadata, '$.run_id') END) AS run_id
         FROM deployment_items d
         JOIN item i ON i.id = d.id AND i.type = 'deployment'
        WHERE d.nimbus_service_id = ?
          AND COALESCE(d.finished_at_ms, d.started_at_ms) >= ?
          AND COALESCE(d.finished_at_ms, d.started_at_ms) < ?`,
    )
    .all(serviceId, fromMs, toMs) as DeployRow[];
}

const deployMsOf = (r: DeployRow): number => r.finished_at_ms ?? r.started_at_ms;

function isNearSpike(ms: number, spikeDayMs: number | null): boolean {
  return spikeDayMs !== null && ms >= spikeDayMs - DAY_MS && ms < spikeDayMs + 2 * DAY_MS;
}

function contextFor(
  db: Database,
  serviceId: string,
  input: CostChangeContextInput,
): CostChangeContext {
  const cfg = input.services.get(serviceId);
  if (cfg === undefined) {
    return {
      serviceId,
      configured: false,
      deploys: [],
      deploysTruncated: 0,
      owners: [],
      gaps: [`service ${serviceId} is not configured ([ci.service.${serviceId}])`],
    };
  }
  const gaps: string[] = [];
  const prServices = distinctPrServiceColumns(cfg.repos);
  if (cfg.repos.length === 0)
    gaps.push(`service ${serviceId} has no repo configured, so no pull request is joined`);
  if (cfg.repos.some((r) => r.provider !== "github")) {
    gaps.push(
      `service ${serviceId}: a deploy is matched to its pull request by merge commit, which only the GitHub connector records`,
    );
  }
  const rows = selectDeploys(db, serviceId, input.fromMs, input.toMs)
    .map((r) => ({ r, ms: deployMsOf(r), near: isNearSpike(deployMsOf(r), input.spikeDayMs) }))
    .sort(
      (a, b) => Number(b.near) - Number(a.near) || b.ms - a.ms || a.r.sha.localeCompare(b.r.sha),
    );
  const max = input.maxDeploys ?? COST_WHY_MAX_DEPLOYS;
  const deploys = rows.slice(0, max).map(({ r, near }) => ({
    sha: r.sha,
    environment: r.environment,
    startedAtMs: r.started_at_ms,
    finishedAtMs: r.finished_at_ms,
    conclusion: r.conclusion,
    url: r.workflow_url,
    runId: r.run_id === null ? null : String(r.run_id),
    nearSpike: near,
    pr: selectPr(db, r.sha, prServices),
  }));
  const entity = findServiceEntity(db, serviceId);
  if (entity === null)
    gaps.push(
      `service ${serviceId} has no ownership entry (nimbus owners --refresh derives one for a bound repo root)`,
    );
  const owners =
    entity === null
      ? []
      : ownersOf(db, entity.id)
          .slice(0, COST_WHY_MAX_OWNERS)
          .map((o) => ({ label: o.label, share: o.share, resolved: o.resolved }));
  return {
    serviceId,
    configured: true,
    deploys,
    deploysTruncated: Math.max(0, rows.length - max),
    owners,
    gaps,
  };
}

/** One context per service id, in the order given. */
export function selectCostChangeContext(
  db: Database,
  input: CostChangeContextInput,
): CostChangeContext[] {
  return input.serviceIds.map((id) => contextFor(db, id, input));
}
