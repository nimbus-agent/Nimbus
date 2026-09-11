import type { Database } from "bun:sqlite";
// Module-private at `dora.ts:60` today. EXPORT it there rather than copying the matcher —
// two definitions would let a service mean one thing here and another in `metrics dora`.
import { repoLikeMatchesUrn } from "../metrics/dora.ts";
import type { ServiceConfig } from "../metrics/dora-config.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import { type ChangelogCategory, eventTimeFor } from "./_lib/changelog-event-time.ts";

/**
 * ABSOLUTE epoch bounds, half-open `[fromMs, toMs)`.
 *
 * Named `fromMs`/`toMs` and NOT `sinceMs` on purpose. Repo-wide, `sinceMs` on an agent input is
 * a lookback DURATION — `agents/decisions.ts:190` states the convention and points at
 * `catchup.ts`'s `now - sinceMs`. Passing that duration straight into SQL would compare
 * `merged_at >= 604800000`, i.e. January 1970, and silently return the entire index as though
 * it all happened this week. The conversion happens exactly once, in `buildChangelogBrief`.
 */
export type Window = {
  readonly fromMs: number;
  readonly toMs: number;
  readonly scope: ChangelogScope;
};

/**
 * How a `--service` maps onto rows.
 *
 * `item.service` is the CONNECTOR id — `github`, `pagerduty`, `github_actions` — never a
 * business service name. `AND i.service = 'payment-service'` therefore matches nothing, in
 * every one of these queries, and returns an empty changelog rather than an error.
 *
 * A business service reaches its rows exactly as `metrics/dora.ts` says it does: repo URNs for
 * PRs and CI runs, `pagerduty_service_id` for incidents, `deployment_items.nimbus_service_id`
 * for annotated deploys. Reusing `ServiceConfig` is also what keeps `nimbus changelog` and
 * `nimbus metrics dora` agreeing on what a service IS.
 */
export type ChangelogScope =
  | { readonly kind: "all" }
  | { readonly kind: "service"; readonly cfg: ServiceConfig };

export type ChangelogRow = {
  readonly id: string;
  readonly service: string;
  readonly title: string;
  readonly url: string | null;
  readonly atMs: number;
  readonly timeSource: "event" | "index";
};

type RawRow = {
  id: string;
  service: string;
  external_id: string;
  title: string;
  url: string | null;
  modified_at: number;
  metadata: string | null;
};

/**
 * Rows whose service membership is decided by REPO, in TypeScript.
 *
 * `repoLikeMatchesUrn` reads `metadata.repo` / `.project` / `.jobName` per provider, which is
 * not expressible as one bound `WHERE` clause — and `dora.ts` already filters these in
 * TypeScript for the same reason. **Export it from `metrics/dora.ts`** (it is currently
 * module-private at `dora.ts:60`); do NOT copy it, or the two definitions drift and a service
 * means one thing to `changelog` and another to `metrics dora`.
 */
function keepByRepo(rows: ChangelogRow[], raw: RawRow[], scope: ChangelogScope): ChangelogRow[] {
  if (scope.kind === "all") return rows;
  const metaById = new Map<string, { meta: Record<string, unknown> | null; externalId: string }>();
  for (const r of raw) {
    let meta: Record<string, unknown> | null = null;
    try {
      meta = r.metadata === null ? null : (JSON.parse(r.metadata) as Record<string, unknown>);
    } catch {
      meta = null;
    }
    metaById.set(r.id, { meta, externalId: r.external_id });
  }
  return rows.filter((row) => {
    const m = metaById.get(row.id);
    if (m === undefined) return false;
    return scope.cfg.repos.some((urn) => repoLikeMatchesUrn(m.meta, m.externalId, urn));
  });
}

/** Incidents scope by `pagerduty_service_id`, which IS expressible as a bound clause. */
function incidentScopeClause(scope: ChangelogScope): { sql: string; params: string[] } {
  if (scope.kind === "all") return { sql: "", params: [] };
  const ids = scope.cfg.pagerdutyServices;
  // An empty list must match NOTHING, not everything — `IN ()` is a syntax error, and omitting
  // the clause would silently widen a scoped query back to every service.
  if (ids.length === 0) return { sql: " AND 1 = 0", params: [] };
  return {
    sql: ` AND json_extract(i.metadata, '$.pagerduty_service_id') IN (${ids.map(() => "?").join(",")})`,
    params: [...ids],
  };
}

/**
 * Windows on the EVENT field directly, with no `modified_at` pre-filter.
 *
 * The pre-filter looks free — `modified_at` is indexed — and is unsound: `index/item-store.ts`
 * writes `modified_at = excluded.modified_at`, a wholesale replacement rather than a MAX(), so
 * monotonicity is a property of each upstream API and not a local guarantee. The failure mode
 * is a merged PR silently missing from the changelog with nothing saying it was dropped.
 * `metrics/dora.ts`'s `selectAttributionIncidents` already makes this same trade.
 */
function selectByEventField(
  db: Database,
  w: Window,
  opts: {
    type: string;
    jsonPath: string;
    category: ChangelogCategory;
    extraSql?: string;
    extraParams?: string[];
  },
): { rows: ChangelogRow[]; raw: RawRow[] } {
  const raw = db
    .query(
      `SELECT i.id, i.service, i.external_id, i.title, i.url, i.modified_at, i.metadata
         FROM item i
        WHERE i.type = ?
          AND json_valid(i.metadata)
          AND json_extract(i.metadata, '${opts.jsonPath}') >= ?
          AND json_extract(i.metadata, '${opts.jsonPath}') < ?
          ${opts.extraSql ?? ""}`,
    )
    .all(opts.type, w.fromMs, w.toMs, ...(opts.extraParams ?? [])) as RawRow[];
  return { rows: toRows(raw, opts.category), raw };
}

function selectByModifiedAt(
  db: Database,
  w: Window,
  opts: { type: string; category: ChangelogCategory; extraSql?: string; extraParams?: string[] },
): { rows: ChangelogRow[]; raw: RawRow[] } {
  const raw = db
    .query(
      `SELECT i.id, i.service, i.external_id, i.title, i.url, i.modified_at, i.metadata
         FROM item i
        WHERE i.type = ?
          AND i.modified_at >= ?
          AND i.modified_at < ?
          ${opts.extraSql ?? ""}`,
    )
    .all(opts.type, w.fromMs, w.toMs, ...(opts.extraParams ?? [])) as RawRow[];
  return { rows: toRows(raw, opts.category), raw };
}

function toRows(rows: RawRow[], category: ChangelogCategory): ChangelogRow[] {
  const out: ChangelogRow[] = [];
  for (const r of rows) {
    let meta: unknown = null;
    try {
      meta = r.metadata === null ? {} : JSON.parse(r.metadata);
    } catch {
      continue;
    }
    const t = eventTimeFor(category, meta, r.modified_at);
    if (t === null) continue;
    out.push({
      id: r.id,
      service: r.service,
      title: r.title,
      url: r.url,
      atMs: t.atMs,
      timeSource: t.source,
    });
  }
  out.sort(byRecencyThenId);
  return out;
}

/**
 * Newest first, ties broken by `id`.
 *
 * The tiebreak is not cosmetic: `changelog.ts`'s `cap()` keeps the FIRST 50 rows of each
 * category, so with more than 50 rows sharing a timestamp — a bulk backfill, a batch of deploys
 * from one pipeline run — SQLite's unspecified `SELECT` order would decide which entries a reader
 * sees, and two runs over an unchanged index could list different ones. `nimbus fleet digest`
 * compares `findings_json` between runs to report what moved, so that instability would surface
 * as a fabricated change. `codeUnitCompare`, never `localeCompare`: the latter is locale-
 * dependent and would order the same index differently on two machines.
 */
function byRecencyThenId(a: ChangelogRow, b: ChangelogRow): number {
  return b.atMs - a.atMs || codeUnitCompare(a.id, b.id);
}

/** The indexed type is `pr`. Never `pull_request` — no connector writes that. */
export function selectMergedPrs(db: Database, w: Window): ChangelogRow[] {
  const { rows, raw } = selectByEventField(db, w, {
    type: "pr",
    jsonPath: "$.merged_at",
    category: "merged_pr",
  });
  return keepByRepo(rows, raw, w.scope);
}

/**
 * Deployments come from TWO sources, exactly as `metrics/dora.ts` defines them — a successful
 * CI run whose title matches the deploy pattern, and an ANNOTATED deploy posted to
 * `POST /v1/deployments`. Counting every successful `ci_run` instead would report "Run tests",
 * "Lint" and "CodeQL" as deployments.
 *
 * The pattern is applied in TypeScript, not SQL: SQLite has no regex, and `dora.ts:111` makes
 * the same move. With no configured service this uses the project's own shipped default,
 * `DEFAULT_DEPLOY_WORKFLOW_PATTERN` (`^[Dd]eploy`), so the command works with zero config
 * rather than reporting nothing until someone writes a `[ci.service.<id>]` block.
 */
export function selectDeployments(db: Database, w: Window, pattern: RegExp): ChangelogRow[] {
  const { rows, raw } = selectByModifiedAt(db, w, {
    type: "ci_run",
    category: "deployment",
    extraSql:
      " AND json_valid(i.metadata) AND json_extract(i.metadata, '$.conclusion') = 'success'",
  });
  const fromCi = keepByRepo(rows, raw, w.scope).filter((r) => pattern.test(r.title));
  return [...fromCi, ...selectAnnotatedDeployments(db, w)].sort(byRecencyThenId);
}

/**
 * The one place a time is NOT resolved through `changelog-event-time.ts`, and deliberately so:
 * `deployment_items.finished_at_ms` is a typed INTEGER column under a CHECK-constrained table
 * (V28), not free-form connector JSON, so the registry's whole job — guarding untyped metadata
 * that might hold a string where a number belongs — does not apply. It is a REAL event time, so
 * these entries report `source: "event"`.
 *
 * Note this is better than `dora.ts` does for the same rows: `selectAnnotatedDeploys` windows on
 * `i.modified_at` and leaves `finished_at_ms` unread.
 *
 * Scoping is `d.nimbus_service_id`, the business service id — NOT `i.service`, which here is the
 * CI connector (`github_actions`, `vercel`) and would match nothing.
 *
 * Every environment is included, not just `prod`. A changelog answers "what happened", and a
 * staging deploy happened; the environment is carried on the entry so the reader can tell.
 */
function selectAnnotatedDeployments(db: Database, w: Window): ChangelogRow[] {
  const scoped =
    w.scope.kind === "service"
      ? { sql: " AND d.nimbus_service_id = ?", params: [w.scope.cfg.serviceId] }
      : { sql: "", params: [] as string[] };

  const rows = db
    .query(
      `SELECT i.id, i.service, i.title, i.url, d.environment,
              COALESCE(d.finished_at_ms, d.started_at_ms) AS at_ms
         FROM item i
         JOIN deployment_items d ON d.id = i.id
        WHERE i.type = 'deployment'
          AND d.conclusion = 'success'
          AND COALESCE(d.finished_at_ms, d.started_at_ms) >= ?
          AND COALESCE(d.finished_at_ms, d.started_at_ms) < ?${scoped.sql}`,
    )
    .all(w.fromMs, w.toMs, ...scoped.params) as Array<{
    id: string;
    service: string;
    title: string;
    url: string | null;
    environment: string;
    at_ms: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    service: r.service,
    title: `${r.title} (${r.environment})`,
    url: r.url,
    atMs: r.at_ms,
    timeSource: "event" as const,
  }));
}

export function selectIncidentsOpened(db: Database, w: Window): ChangelogRow[] {
  const sc = incidentScopeClause(w.scope);
  return selectByEventField(db, w, {
    type: "incident",
    jsonPath: "$.opened_at_ms",
    category: "incident_opened",
    extraSql: sc.sql,
    extraParams: sc.params,
  }).rows;
}

export function selectIncidentsResolved(db: Database, w: Window): ChangelogRow[] {
  const sc = incidentScopeClause(w.scope);
  return selectByModifiedAt(db, w, {
    type: "incident",
    category: "incident_resolved",
    extraSql:
      " AND json_valid(i.metadata) AND json_extract(i.metadata, '$.status') = 'resolved'" + sc.sql,
    extraParams: sc.params,
  }).rows;
}

/**
 * How many merged PRs this changelog CANNOT see.
 *
 * `metadata.merged_at` is written by `connectors/github-sync.ts` alone — neither
 * `gitlab-sync.ts` nor `bitbucket-sync.ts` populates it — so every merged GitLab MR and
 * Bitbucket PR is invisible to `selectMergedPrs`. Counting them is what turns a silent
 * substrate hole into a disclosed one. `metrics/stats.ts` ships the same gap as
 * `github_only_merge_data`.
 *
 * **This is an ESTIMATE, and its caller must say so.** The absence of `merged_at` is the whole
 * reason this function exists, so there is no merge timestamp to window on and it falls back to
 * `i.modified_at` — last touch. That misses in BOTH directions: a PR merged inside the window
 * whose row has not been re-synced since is not counted, and one merged months ago that a
 * comment or label touched during the window IS. `changelog.ts`'s gap note discloses that; a
 * bare count presented beside four event-windowed ones would read as the same kind of number.
 */
export function nonGithubMergedPrCount(db: Database, w: Window): number {
  const raw = db
    .query(
      `SELECT i.id, i.service, i.external_id, i.title, i.url, i.modified_at, i.metadata
         FROM item i
        WHERE i.type = 'pr'
          AND i.service <> 'github'
          AND i.modified_at >= ?
          AND i.modified_at < ?
          AND json_valid(i.metadata)
          AND json_extract(i.metadata, '$.state') = 'merged'`,
    )
    .all(w.fromMs, w.toMs) as RawRow[];

  if (w.scope.kind === "all") return raw.length;
  // Reuse the same repo matcher so a scoped count cannot disagree with a scoped listing.
  const asRows: ChangelogRow[] = raw.map((r) => ({
    id: r.id,
    service: r.service,
    title: r.title,
    url: r.url,
    atMs: r.modified_at,
    timeSource: "index" as const,
  }));
  return keepByRepo(asRows, raw, w.scope).length;
}
