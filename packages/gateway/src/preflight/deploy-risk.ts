import type { Database } from "bun:sqlite";
import {
  readPagerdutySyncFreshness,
  selectLastDeploymentBefore,
} from "../agents/_lib/oncall-queries.ts";
import type { NimbusPreflightRiskToml, RiskFailAt } from "../config/preflight-risk-toml.ts";
import { effectivePreflightRiskZone, RISK_DAYS } from "../config/preflight-risk-toml.ts";
import { queryOncallNow } from "../index/oncall-now-query.ts";
import { deploymentFrequency } from "../metrics/dora.ts";
import type { ServiceConfig } from "../metrics/dora-config.ts";
import { buildServiceIdentityResolver } from "../metrics/service-identity.ts";
import { wallOfInstant } from "../util/zoned-time.ts";

/**
 * The advisory deploy-risk block of the deploy preflight (Phase 17, "Deploy-risk advisor").
 *
 * Deterministic and EXPLAINABLE: four factors, each computed from the local index only and reported with
 * its evidence. No model, no network, no connector call, no write. It is ADVISORY by construction: it
 * never changes the preflight's verdict unless the owner set `[preflight.risk] fail_at`.
 *
 * The rule that matters most: a factor whose data is missing is `unknown`, never `low`. "Nobody is on
 * call" and "no incident is open" are claims about the world; an empty index is not evidence for them.
 */
export type RiskLevel = "low" | "elevated" | "high";
export type RiskResultLevel = RiskLevel | "unknown";
export type RiskFactorId = "system_state" | "change_velocity" | "oncall_coverage" | "time_of_week";

export type RiskFactor = {
  readonly id: RiskFactorId;
  readonly level: RiskResultLevel;
  readonly evidence: string;
  /** False when the index could not answer; the level is then `unknown` and never counts toward the maximum. */
  readonly known: boolean;
};

export type DeployRisk = {
  readonly level: RiskResultLevel;
  readonly why: string;
  readonly factors: readonly RiskFactor[];
  /** Always true: the block is a warning to read, not a decision. */
  readonly advisory: true;
  /** `[preflight.risk] fail_at`, or null when the risk can never change the verdict. */
  readonly fail_at: RiskFailAt | null;
  /** True only when `fail_at` was reached AND the existing checks had said `ok`. */
  readonly verdict_escalated: boolean;
};

/**
 * THE scoring table: every level a factor can take, in one place, so the mapping is reviewable. The
 * overall level is the maximum over the KNOWN factors (`unknown` when none is known), and no row here
 * can produce `unknown`: that comes only from missing data.
 */
export const RISK_SCORING = {
  // ---- system_state: open incidents and alerts, and the last deploy ----
  /** An open (triggered or acknowledged) PagerDuty incident of P1 severity (or a configured P1 alias) on THIS service. */
  open_p1_incident_own: { factor: "system_state", level: "high" },
  /** Any other open incident on this service: the system is already degraded. */
  open_incident_own: { factor: "system_state", level: "elevated" },
  /** Any open incident on a service this one `depends_on`: a change lands on a degraded dependency. */
  open_incident_dependency: { factor: "system_state", level: "elevated" },
  /** An open JSM alert (P1 or P2) bound to this service or a dependency. Lower priorities are listed but not scored. */
  open_alert_p1_p2: { factor: "system_state", level: "elevated" },
  /**
   * An OPEN incident record (Phase 10 IC3) from Sentry, Monte Carlo or Bigeye whose service is this one or a
   * dependency (Phase 10 IC8). PagerDuty and JSM are read from their items above, so they are not counted twice.
   */
  open_record_other_source: { factor: "system_state", level: "elevated" },
  /** The latest deployment of this service in a deploy environment failed within the last 24 hours. */
  recent_failed_deploy: { factor: "system_state", level: "elevated" },
  /** Incident and alert sources are bound and fresh, and none of the above holds. */
  system_clear: { factor: "system_state", level: "low" },
  // ---- change_velocity: successful deploys against the service's own baseline ----
  /** At least 4 deploys in 24 hours AND at least 4x the baseline daily rate (baseline floored at 0.5 a day). */
  velocity_burst_high: { factor: "change_velocity", level: "high" },
  /** At least 2 deploys in 24 hours and 2x the baseline, or at least 6 in 7 days and 2x the baseline week. */
  velocity_burst_elevated: { factor: "change_velocity", level: "elevated" },
  /** Within the service's own pattern. */
  velocity_normal: { factor: "change_velocity", level: "low" },
  // ---- oncall_coverage ----
  /** Fresh shift data for the service's PagerDuty services shows nobody currently on call. */
  oncall_uncovered: { factor: "oncall_coverage", level: "elevated" },
  /** At least one person is on call now. */
  oncall_covered: { factor: "oncall_coverage", level: "low" },
  // ---- time_of_week ----
  /** The service-local time falls on a quiet day or inside a quiet window. */
  time_quiet: { factor: "time_of_week", level: "elevated" },
  /** Outside every quiet day and window. */
  time_normal: { factor: "time_of_week", level: "low" },
} as const satisfies Record<string, { factor: RiskFactorId; level: RiskLevel }>;

type ScoringRow = keyof typeof RISK_SCORING;

const DAY_MS = 86_400_000;
/** The PagerDuty index older than this is not evidence about open incidents. */
export const RISK_INDEX_FRESH_MS = 6 * 3_600_000;
/** The baseline is the 28 days before the last week; fewer than this many deploys in it is "not enough history". */
export const RISK_BASELINE_MIN_SAMPLE = 3;
const BASELINE_DAYS = 28;
const BASELINE_FLOOR_PER_DAY = 0.5;
const LEVEL_RANK: Record<RiskLevel, number> = { low: 0, elevated: 1, high: 2 };

function known(id: RiskFactorId, row: ScoringRow, evidence: string): RiskFactor {
  return { id, level: RISK_SCORING[row].level, evidence, known: true };
}

function unknown(id: RiskFactorId, evidence: string): RiskFactor {
  return { id, level: "unknown", evidence, known: false };
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// system_state
// ---------------------------------------------------------------------------

type OpenRow = { id: string; metadata: string };

function parseMeta(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// lane-census: scope=incident service=pagerduty
function openIncidentRows(db: Database): OpenRow[] {
  return db
    .query(
      `SELECT id, metadata FROM item
       WHERE service = 'pagerduty' AND type = 'incident'
         AND json_extract(metadata, '$.status') IN ('triggered', 'acknowledged')
       LIMIT 2000`,
    )
    .all() as OpenRow[];
}

// lane-census: scope=alert service=jira
function openAlertRows(db: Database): OpenRow[] {
  return db
    .query(
      `SELECT id, metadata FROM item
       WHERE service = 'jira' AND type = 'alert'
         AND json_extract(metadata, '$.status') = 'open'
       LIMIT 2000`,
    )
    .all() as OpenRow[];
}

function syncAgeMs(db: Database, connectorId: string, nowMs: number): number | null {
  const row = db
    .query("SELECT last_sync_at FROM sync_state WHERE connector_id = ? LIMIT 1")
    .get(connectorId) as { last_sync_at: number | null } | null;
  const last = row?.last_sync_at;
  return typeof last === "number" && Number.isFinite(last) ? Math.max(0, nowMs - last) : null;
}

export type RiskInputs = {
  readonly db: Database;
  readonly cfg: ServiceConfig;
  /** Every configured service, for `depends_on` and binding resolution. */
  readonly configs: ReadonlyMap<string, ServiceConfig>;
  readonly riskConfig: NimbusPreflightRiskToml;
  readonly nowMs: number;
};

type Hit = { readonly row: ScoringRow; readonly text: string };

function incidentHits(
  db: Database,
  cfg: ServiceConfig,
  targets: ReadonlySet<string>,
  resolve: ReturnType<typeof buildServiceIdentityResolver>,
): Hit[] {
  const p1 = new Set(["p1", ...cfg.severityP1Aliases.map((a) => a.toLowerCase())]);
  const hits: Hit[] = [];
  for (const r of openIncidentRows(db)) {
    const meta = parseMeta(r.metadata);
    if (meta === null) continue;
    const res = resolve({ service: "pagerduty", type: "incident", metadata: meta });
    if (res.kind !== "bound" || !targets.has(res.serviceId)) continue;
    const own = res.serviceId === cfg.serviceId;
    // lane-census: scope=incident service=pagerduty
    const sev = typeof meta["severity"] === "string" ? meta["severity"].toLowerCase() : "";
    // lane-census: scope=incident service=pagerduty
    const status = String(meta["status"]);
    if (own && p1.has(sev)) {
      hits.push({
        row: "open_p1_incident_own",
        text: `open P1 incident ${r.id} (${status}) on ${cfg.serviceId}`,
      });
    } else {
      hits.push({
        row: own ? "open_incident_own" : "open_incident_dependency",
        text: `open incident ${r.id} (${status}) on ${res.serviceId}`,
      });
    }
  }
  return hits;
}

function alertHits(
  db: Database,
  targets: ReadonlySet<string>,
  resolve: ReturnType<typeof buildServiceIdentityResolver>,
): { hits: Hit[]; unscored: number } {
  const hits: Hit[] = [];
  let unscored = 0;
  for (const r of openAlertRows(db)) {
    const meta = parseMeta(r.metadata);
    if (meta === null) continue;
    const res = resolve({ service: "jira", type: "alert", metadata: meta });
    if (res.kind !== "bound" || !targets.has(res.serviceId)) continue;
    // lane-census: scope=alert service=jira
    const priority = meta["priority"];
    if (priority === "P1" || priority === "P2") {
      hits.push({
        row: "open_alert_p1_p2",
        text: `open ${priority} alert ${r.id} on ${res.serviceId}`,
      });
    } else {
      unscored += 1;
    }
  }
  return { hits, unscored };
}

// The open incident records of the sources the item reads above do not cover (Phase 10 IC8). Only the record's
// stored service and status are read; a record whose service is unbound never counts.
function openRecordHits(db: Database, targets: ReadonlySet<string>): Hit[] {
  const rows = db
    .query(
      `SELECT id, trigger_service, service FROM incident_record
        WHERE status = 'open' AND trigger_service IN ('sentry', 'montecarlo', 'bigeye') AND service IS NOT NULL
        ORDER BY opened_at_ms DESC, id`,
    )
    .all() as { id: string; trigger_service: string; service: string }[];
  return rows
    .filter((r) => targets.has(r.service))
    .map((r) => ({
      row: "open_record_other_source" as const,
      text: `open ${r.trigger_service} incident record ${r.id} on ${r.service}`,
    }));
}

function recentFailedDeploy(inputs: RiskInputs): Hit | null {
  const { db, cfg, nowMs } = inputs;
  const last = selectLastDeploymentBefore(db, cfg.serviceId, cfg.deployEnvironments, nowMs + 1);
  if (last?.conclusion !== "failure") return null;
  const at = last.finishedAtMs ?? last.startedAtMs;
  if (nowMs - at > DAY_MS) return null;
  return {
    row: "recent_failed_deploy",
    text: `the latest ${last.environment} deployment (${last.sha.slice(0, 7)}) failed ${String(Math.max(0, Math.round((nowMs - at) / 3_600_000)))}h ago`,
  };
}

/** The factor row with the highest level among `hits` (the first on a tie, so the order of evidence is stable). */
function worst(hits: readonly Hit[]): ScoringRow {
  let best = hits[0] as Hit;
  for (const h of hits) {
    if (LEVEL_RANK[RISK_SCORING[h.row].level] > LEVEL_RANK[RISK_SCORING[best.row].level]) best = h;
  }
  return best.row;
}

export function systemStateFactor(inputs: RiskInputs): RiskFactor {
  const { db, cfg, configs, nowMs } = inputs;
  const all = new Map(configs);
  all.set(cfg.serviceId, cfg);
  const deps = cfg.dependsOn.filter((d) => d !== cfg.serviceId && all.has(d));
  const unconfiguredDeps = cfg.dependsOn.filter((d) => !all.has(d));
  const targets = new Set([cfg.serviceId, ...deps]);
  const targetCfgs = [...targets].map((id) => all.get(id) as ServiceConfig);

  const pdBound = targetCfgs.some((c) => c.pagerdutyServices.length > 0);
  const pdFresh = readPagerdutySyncFreshness(db, nowMs).ageMs;
  const incidentsReady = pdBound && pdFresh !== null && pdFresh <= RISK_INDEX_FRESH_MS;
  const alertsBound = targetCfgs.some((c) => c.jsmAlertTags.length > 0);
  const jiraAge = syncAgeMs(db, "jira", nowMs);
  const alertsReady = alertsBound && jiraAge !== null && jiraAge <= RISK_INDEX_FRESH_MS;

  const resolve = buildServiceIdentityResolver(all);
  const hits: Hit[] = [];
  let unscoredAlerts = 0;
  if (incidentsReady) hits.push(...incidentHits(db, cfg, targets, resolve));
  if (alertsReady) {
    const a = alertHits(db, targets, resolve);
    hits.push(...a.hits);
    unscoredAlerts = a.unscored;
  }
  hits.push(...openRecordHits(db, targets));
  const failed = recentFailedDeploy(inputs);
  if (failed !== null) hits.push(failed);

  if (hits.length > 0) {
    return known("system_state", worst(hits), hits.map((h) => h.text).join("; "));
  }
  if (!incidentsReady && !alertsReady) {
    return unknown(
      "system_state",
      "no incident or alert source is both bound to this service (or a dependency) and freshly synced, so open incidents cannot be ruled out" +
        "; no failed deployment in the last 24h",
    );
  }
  const checked = [
    incidentsReady ? "incidents" : null,
    alertsReady ? "alerts" : null,
    "the last deployment",
  ].filter((x): x is string => x !== null);
  const depsNote = deps.length > 0 ? `; dependencies: ${deps.join(", ")}` : "";
  const notes = [
    `none open or failed (checked ${checked.join(", ")}${depsNote})`,
    unscoredAlerts > 0
      ? `${plural(unscoredAlerts, "lower-priority alert")} open, not scored`
      : null,
    !incidentsReady
      ? "incident source not bound or not fresh, so incidents were not checked"
      : null,
    !alertsReady ? "alert source not bound or not fresh, so alerts were not checked" : null,
    unconfiguredDeps.length > 0
      ? `depends_on ${unconfiguredDeps.join(", ")} has no configuration and was not checked`
      : null,
  ].filter((x): x is string => x !== null);
  return known("system_state", "system_clear", notes.join("; "));
}

// ---------------------------------------------------------------------------
// change_velocity
// ---------------------------------------------------------------------------

export function changeVelocityFactor(inputs: RiskInputs): RiskFactor {
  const { db, cfg, nowMs } = inputs;
  const d1 = deploymentFrequency(db, cfg, nowMs, DAY_MS);
  const d7 = deploymentFrequency(db, cfg, nowMs, 7 * DAY_MS);
  const d35 = deploymentFrequency(db, cfg, nowMs, (7 + BASELINE_DAYS) * DAY_MS);
  if (d35.value === null) {
    return unknown(
      "change_velocity",
      `no deployment history to compare against (${d35.gap ?? "no data"})`,
    );
  }
  const prior = d35.sample - d7.sample;
  if (prior < RISK_BASELINE_MIN_SAMPLE) {
    return unknown(
      "change_velocity",
      `only ${plural(prior, "deployment")} in the ${String(BASELINE_DAYS)} days before the last week, not enough history for a baseline (${String(d1.sample)} in 24h, ${String(d7.sample)} in 7d)`,
    );
  }
  const baselineDay = Math.max(prior / BASELINE_DAYS, BASELINE_FLOOR_PER_DAY);
  const ratio24 = d1.sample / baselineDay;
  const ratio7 = d7.sample / (7 * baselineDay);
  const facts = `${String(d1.sample)} in 24h and ${String(d7.sample)} in 7d against a baseline of ${(prior / BASELINE_DAYS).toFixed(2)} a day`;
  let row: ScoringRow = "velocity_normal";
  if (d1.sample >= 4 && ratio24 >= 4) row = "velocity_burst_high";
  else if ((d1.sample >= 2 && ratio24 >= 2) || (d7.sample >= 6 && ratio7 >= 2)) {
    row = "velocity_burst_elevated";
  }
  // A bound CI provider the index cannot judge hides some deploys, so a "normal" count is a lower bound.
  const blind = [d1, d7, d35].some((d) => d.gap === "ci_not_evaluable");
  if (row === "velocity_normal" && blind) {
    return unknown(
      "change_velocity",
      `${facts}, but a bound CI provider cannot be judged from the index, so the count may be low`,
    );
  }
  return known("change_velocity", row, facts);
}

// ---------------------------------------------------------------------------
// oncall_coverage
// ---------------------------------------------------------------------------

export function oncallCoverageFactor(inputs: RiskInputs): RiskFactor {
  const { db, cfg, nowMs } = inputs;
  if (cfg.pagerdutyServices.length === 0) {
    return unknown(
      "oncall_coverage",
      "no PagerDuty service is bound to this service, so on-call shifts cannot be matched to it",
    );
  }
  let covered = 0;
  let uncovered = 0;
  let unmatched = 0;
  let unreliable = false;
  for (const id of cfg.pagerdutyServices) {
    const r = queryOncallNow(db, { nowMs, pagerdutyServiceId: id });
    if (r.sources.some((s) => s.stale) || r.gaps.length > 0) unreliable = true;
    if (r.status === "ok") covered += 1;
    else if (r.status === "none_on_call") uncovered += 1;
    else unmatched += 1;
  }
  if (covered > 0 && !unreliable) {
    return known(
      "oncall_coverage",
      "oncall_covered",
      "someone is on call now (from the indexed shifts)",
    );
  }
  if (covered === 0 && uncovered > 0 && unmatched === 0 && !unreliable) {
    return known(
      "oncall_coverage",
      "oncall_uncovered",
      `the indexed shifts show nobody on call now for ${cfg.pagerdutyServices.join(", ")}`,
    );
  }
  const why = unreliable
    ? "the shift data is stale or its service map is incomplete"
    : "no indexed shift matches the bound PagerDuty service(s), or no shift data is indexed";
  return unknown("oncall_coverage", `${why}, so coverage is unknown (not the same as uncovered)`);
}

// ---------------------------------------------------------------------------
// time_of_week
// ---------------------------------------------------------------------------

export function timeOfWeekFactor(inputs: RiskInputs): RiskFactor {
  const { riskConfig, nowMs } = inputs;
  const zone = effectivePreflightRiskZone(riskConfig);
  const wall = wallOfInstant(nowMs, zone);
  if (wall === undefined) {
    return unknown("time_of_week", `the local time in ${zone} could not be computed`);
  }
  const day = new Date(Date.UTC(wall.y, wall.mo - 1, wall.d)).getUTCDay();
  const minute = wall.h * 60 + wall.mi;
  const pad = (n: number): string => String(n).padStart(2, "0");
  const when = `${RISK_DAYS[day] as string} ${pad(wall.h)}:${pad(wall.mi)} in ${zone}`;
  if (riskConfig.quietDays.includes(day)) {
    return known(
      "time_of_week",
      "time_quiet",
      `${when} is a quiet day (${RISK_DAYS[day] as string})`,
    );
  }
  const window = riskConfig.quietHours.find(
    (w) => w.day === day && minute >= w.startMinute && minute < w.endMinute,
  );
  if (window !== undefined) {
    return known(
      "time_of_week",
      "time_quiet",
      `${when} is inside the quiet window ${window.label}`,
    );
  }
  return known("time_of_week", "time_normal", `${when} is outside the quiet days and windows`);
}

// ---------------------------------------------------------------------------
// combination
// ---------------------------------------------------------------------------

/** The overall level: the maximum over the known factors, `unknown` when none is known. */
export function combineRisk(factors: readonly RiskFactor[]): RiskResultLevel {
  let level: RiskLevel | null = null;
  for (const f of factors) {
    if (!f.known || f.level === "unknown") continue;
    if (level === null || LEVEL_RANK[f.level] > LEVEL_RANK[level]) level = f.level;
  }
  return level ?? "unknown";
}

function whyLine(level: RiskResultLevel, factors: readonly RiskFactor[]): string {
  if (level === "unknown") {
    return "No factor could be evaluated from the local index, so the risk is unknown (not low).";
  }
  const drivers = factors.filter((f) => f.known && f.level === level);
  const unknownIds = factors.filter((f) => !f.known).map((f) => f.id);
  const tail = unknownIds.length > 0 ? ` Not evaluated: ${unknownIds.join(", ")}.` : "";
  if (level === "low") return `Low risk: every evaluated factor is within its normal range.${tail}`;
  return `${level === "high" ? "High" : "Elevated"} risk, driven by ${drivers.map((f) => f.id).join(", ")}: ${drivers[0]?.evidence ?? ""}.${tail}`;
}

/** Whether `level` reaches the owner's `fail_at`. `unknown` never does. */
export function reachesFailAt(level: RiskResultLevel, failAt: RiskFailAt | null): boolean {
  if (failAt === null || level === "unknown") return false;
  return LEVEL_RANK[level] >= LEVEL_RANK[failAt];
}

export function computeDeployRisk(inputs: RiskInputs, verdictBefore: "ok" | "warn"): DeployRisk {
  const factors = [
    systemStateFactor(inputs),
    changeVelocityFactor(inputs),
    oncallCoverageFactor(inputs),
    timeOfWeekFactor(inputs),
  ];
  const level = combineRisk(factors);
  const failAt = inputs.riskConfig.failAt;
  return {
    level,
    why: whyLine(level, factors),
    factors,
    advisory: true,
    fail_at: failAt,
    verdict_escalated: verdictBefore === "ok" && reachesFailAt(level, failAt),
  };
}
