import type { Database } from "bun:sqlite";

import type { ServiceConfig } from "../metrics/dora-config.ts";
import type { ActionEventKind } from "./action-links.ts";
import type { IncidentRecordV1 } from "./incident-record-types.ts";
import { getById, type RecordRow } from "./incident-store.ts";
import { oneLine } from "./lanes/caps.ts";
import { readTimelineWithCaps } from "./timeline-read.ts";
import { TRIGGER_SERVICES } from "./trigger-sources.ts";

/**
 * The investigation of one incident record (Phase 10 IC9a, incident-engine spec § 5.9, REDUCED): what the LOCAL
 * INDEX says about the incident beyond the record itself. Read-only and pure over a `Database`, the declared
 * service configs and a clock value: no network, no connector, no executor, no model, no write (static D46(a),
 * I57 (a)). The spec's live fan-out of read tools is NOT built; a backend whose state is not in the index
 * (Datadog monitors, Grafana alert rules, New Relic violations, CloudWatch log search) is a Gap that says so.
 *
 * Sources: the stored record (current version); Sentry `error_issue` rows bound to the record's service by the
 * service's declared `sentry_projects` and active (`lastSeen`) in the window; the other open records of the same
 * service; the data lane already inside the record; and the Nimbus actions linked to the record by IC4 (the
 * timeline's action events). Provider text is capped to one line here and escaped again by the renderer.
 */

export const INVESTIGATE_ROW_CAP = 100;
export const INVESTIGATE_LOOKBACK_MS = 6 * 3_600_000;
export const INVESTIGATE_SENTRY_SCAN_CAP = 5_000;
export const INVESTIGATE_LEAD_CAP = 10;
const DATA_SHOWN = 20;
const TITLE_MAX = 200;

export type SentryIssueRow = {
  readonly itemId: string;
  readonly title: string;
  readonly url: string | null;
  readonly project: string;
  readonly level: string | null;
  readonly status: string | null;
  readonly count: number | null;
  readonly userCount: number | null;
  readonly firstSeenMs: number | null;
  readonly lastSeenMs: number;
  /** Timing only: the issue's first sighting is at or after the record's deployment start. */
  readonly newSinceDeploy: boolean;
};

export type SentryBlock = {
  /**
   * `ok`: listed. `not_scoped`: the record is not bound to a service, so nothing is listed. `no_projects`: the
   * service declares no `sentry_projects`. `no_config`: the service configuration could not be read.
   */
  readonly status: "ok" | "not_scoped" | "no_projects" | "no_config";
  readonly projects: readonly string[];
  readonly rows: readonly SentryIssueRow[];
  readonly total: number;
  /** True when the scan hit its row cap, so older rows in the window may be missing. */
  readonly scanCapped: boolean;
};

export type RelatedOpen = {
  readonly recordId: string;
  readonly source: string;
  readonly severity: string | null;
  readonly title: string;
  readonly openedAtMs: number | null;
};

export type LinkedAction = {
  readonly atMs: number;
  readonly kind: ActionEventKind;
  readonly text: string;
};

export type Lead = {
  readonly kind: "deployment" | "sentry_issue" | "open_record";
  readonly refId: string;
  readonly text: string;
};

export type InvestigationDataBlock = {
  readonly models: readonly string[];
  readonly totals: {
    readonly lineage: number;
    readonly orchestration: number;
    readonly prs: number;
  };
  readonly lineage: readonly { readonly model: string; readonly to: string }[];
  readonly orchestration: readonly {
    readonly id: string;
    readonly service: string;
    readonly type: string;
    readonly title: string;
    readonly url: string | null;
  }[];
};

export type Investigation = {
  readonly recordId: string;
  readonly version: number;
  readonly asOfMs: number;
  readonly span: { readonly fromMs: number; readonly toMs: number };
  readonly trigger: {
    readonly itemId: string;
    readonly service: string;
    readonly type: string;
    readonly title: string;
    readonly url: string | null;
    readonly status: string;
    readonly severity: string | null;
    readonly openedAtMs: number | null;
    readonly closedAtMs: number | null;
  };
  readonly binding: {
    readonly bound: boolean;
    readonly service: string | null;
    readonly via: string | null;
  };
  readonly sentry: SentryBlock;
  readonly data: InvestigationDataBlock | null;
  readonly relatedOpen: { readonly items: readonly RelatedOpen[]; readonly total: number };
  readonly actions: readonly LinkedAction[];
  readonly leads: readonly Lead[];
  readonly gaps: readonly { readonly code: string; readonly detail: string }[];
  readonly freshness: readonly {
    readonly service: string;
    readonly connected: boolean;
    readonly lastSyncMs: number | null;
  }[];
  readonly recordAssembledAtMs: number;
};

/** The backends whose state is not indexed: each is a Gap that names whether its connector is connected. */
const LIVE_BACKENDS: readonly { readonly connector: string; readonly label: string }[] = [
  { connector: "datadog", label: "Datadog monitors" },
  { connector: "grafana", label: "Grafana alert rules" },
  { connector: "newrelic", label: "New Relic violations" },
  { connector: "cloudwatch", label: "CloudWatch log search" },
];

const FRESHNESS_SERVICES: readonly string[] = [
  ...new Set(["sentry", ...TRIGGER_SERVICES, ...LIVE_BACKENDS.map((b) => b.connector)]),
];

type ItemRow = {
  id: string;
  title: string;
  url: string | null;
  modified_at: number;
  metadata: string | null;
};

function metaRecord(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
/** Sentry reports `count` as a decimal string. */
const countOf = (v: unknown): number | null =>
  typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : numOrNull(v);

function readSentry(
  db: Database,
  input: {
    readonly projects: readonly string[];
    readonly fromMs: number;
    readonly toMs: number;
    readonly excludeItemId: string;
    readonly deployStartMs: number | null;
  },
): { rows: SentryIssueRow[]; scanCapped: boolean } {
  if (input.projects.length === 0) return { rows: [], scanCapped: false };
  // The project filter runs in SQL, before the cap, so other projects' newer issues cannot crowd this
  // service's out of the scan. `json_extract` runs only on valid JSON (a CASE, not AND order); a malformed
  // or project-less row reads NULL and fails the IN test.
  const marks = input.projects.map(() => "?").join(", ");
  const scanned = db
    .query(
      `SELECT id, title, url, modified_at, metadata FROM item
        WHERE service = 'sentry' AND type = 'error_issue' AND modified_at >= ? AND modified_at <= ?
          AND CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.project') END IN (${marks})
        ORDER BY modified_at DESC, id ASC LIMIT ?`,
    )
    .all(input.fromMs, input.toMs, ...input.projects, INVESTIGATE_SENTRY_SCAN_CAP) as ItemRow[];
  const projects = new Set(input.projects);
  const rows: SentryIssueRow[] = [];
  for (const r of scanned) {
    if (r.id === input.excludeItemId) continue;
    const m = metaRecord(r.metadata);
    const project = m === null ? null : strOrNull(m["project"]);
    if (m === null || project === null || !projects.has(project)) continue;
    const firstSeenMs = numOrNull(m["firstSeen"]);
    rows.push({
      itemId: r.id,
      title: oneLine(r.title, TITLE_MAX),
      url: r.url,
      project,
      level: strOrNull(m["level"]),
      status: strOrNull(m["status"]),
      count: countOf(m["count"]),
      userCount: numOrNull(m["userCount"]),
      firstSeenMs,
      lastSeenMs: r.modified_at,
      newSinceDeploy:
        input.deployStartMs !== null && firstSeenMs !== null && firstSeenMs >= input.deployStartMs,
    });
  }
  return { rows, scanCapped: scanned.length >= INVESTIGATE_SENTRY_SCAN_CAP };
}

function dataBlock(record: IncidentRecordV1): InvestigationDataBlock | null {
  const d = record.data;
  if (d === null) return null;
  return {
    models: d.models,
    totals: d.totals,
    lineage: d.lineage.slice(0, DATA_SHOWN).map((l) => ({ model: l.model, to: l.to })),
    orchestration: d.orchestration.slice(0, DATA_SHOWN).map((o) => ({
      id: o.id,
      service: o.service,
      type: o.type,
      title: oneLine(o.title, TITLE_MAX),
      url: o.url,
    })),
  };
}

function minutes(fromMs: number, toMs: number): number {
  return Math.max(0, Math.round((toMs - fromMs) / 60_000));
}

function buildLeads(
  record: IncidentRecordV1,
  sentry: readonly SentryIssueRow[],
  related: readonly RelatedOpen[],
): Lead[] {
  const leads: Lead[] = [];
  const dep = record.change.deployment;
  if (dep !== null) {
    leads.push({
      kind: "deployment",
      refId: dep.id,
      text: `Candidate: the last deployment before the alert (${String(dep.minutesBeforeOpen)} min before it); timing only, not a proven cause.`,
    });
  }
  for (const s of sentry) {
    if (!s.newSinceDeploy || dep === null || s.firstSeenMs === null) continue;
    leads.push({
      kind: "sentry_issue",
      refId: s.itemId,
      text: `Candidate: a Sentry issue first seen ${String(minutes(dep.startedAtMs, s.firstSeenMs))} min after that deployment started; timing only, not a proven cause.`,
    });
  }
  for (const r of related) {
    leads.push({
      kind: "open_record",
      refId: r.recordId,
      text: "Another open record of the same service; it may share a cause.",
    });
  }
  return leads.slice(0, INVESTIGATE_LEAD_CAP);
}

function gapsFor(
  sentry: SentryBlock,
  bound: boolean,
  freshness: Investigation["freshness"],
  record: IncidentRecordV1,
  actionsTruncated: boolean,
): { code: string; detail: string }[] {
  const gaps: { code: string; detail: string }[] = [];
  if (sentry.status === "not_scoped") {
    gaps.push({
      code: "sentry_not_scoped",
      detail:
        "This record is not bound to a configured service, so no Sentry issue is listed: nothing says which projects belong to it.",
    });
  } else if (sentry.status === "no_projects") {
    gaps.push({
      code: "sentry_no_projects",
      detail:
        "The service declares no `sentry_projects` in nimbus.toml, so no Sentry issue is listed for it.",
    });
  } else if (sentry.status === "no_config") {
    gaps.push({
      code: "sentry_no_config",
      detail: "The service configuration could not be read, so no Sentry issue is listed.",
    });
  } else if (sentry.scanCapped) {
    gaps.push({
      code: "sentry_scan_capped",
      detail: `Only the ${String(INVESTIGATE_SENTRY_SCAN_CAP)} most recently seen Sentry issues of this service's projects in the window were scanned; older ones may be missing.`,
    });
  }
  if (sentry.total > sentry.rows.length) {
    gaps.push({
      code: "sentry_rows_capped",
      detail: `Sentry issues are capped at ${String(INVESTIGATE_ROW_CAP)} rows; ${String(sentry.total)} matched.`,
    });
  }
  for (const b of LIVE_BACKENDS) {
    const f = freshness.find((x) => x.service === b.connector);
    gaps.push({
      code: `live_${b.connector}`,
      detail: `${b.label} are not read: their state is not in the local index and this command makes no live call (${f?.connected === true ? "the connector is connected" : "the connector is not connected"}).`,
    });
  }
  if (actionsTruncated) {
    gaps.push({
      code: "actions_scan_capped",
      detail:
        "More audit rows link to this record than were read, so the linked Nimbus actions listed may be incomplete.",
    });
  }
  if (!bound) {
    gaps.push({
      code: "record_unbound",
      detail:
        "The record is not bound to a service, so the other-open-records and Sentry sections cannot be scoped.",
    });
  }
  if (record.gaps.length > 0) {
    gaps.push({
      code: "record_gaps",
      detail: `The record itself lists ${String(record.gaps.length)} gap(s); see \`nimbus incident show\`.`,
    });
  }
  return gaps;
}

export type InvestigateInput = {
  readonly recordId: string;
  readonly nowMs: number;
  /** The declared service configs, or `null` when they could not be read. */
  readonly serviceConfigs: ReadonlyMap<string, ServiceConfig> | null;
};

function freshnessOf(db: Database): Investigation["freshness"] {
  const q = db.query("SELECT last_sync_at FROM sync_state WHERE connector_id = ? LIMIT 1");
  return FRESHNESS_SERVICES.map((service) => {
    const row = q.get(service) as { last_sync_at: number | null } | null;
    return { service, connected: row !== null, lastSyncMs: row?.last_sync_at ?? null };
  });
}

function relatedOf(db: Database, row: RecordRow): Investigation["relatedOpen"] {
  if (row.service === null) return { items: [], total: 0 };
  const total = (
    db
      .query(
        "SELECT count(*) AS n FROM incident_record WHERE status = 'open' AND service = ? AND id <> ?",
      )
      .get(row.service, row.id) as { n: number }
  ).n;
  const rows = db
    .query(
      `SELECT id, trigger_service, severity, title, opened_at_ms FROM incident_record
        WHERE status = 'open' AND service = ? AND id <> ?
        ORDER BY (opened_at_ms IS NULL), opened_at_ms ASC, id ASC LIMIT ?`,
    )
    .all(row.service, row.id, INVESTIGATE_ROW_CAP) as {
    id: string;
    trigger_service: string;
    severity: string | null;
    title: string;
    opened_at_ms: number | null;
  }[];
  return {
    items: rows.map((r) => ({
      recordId: r.id,
      source: r.trigger_service,
      severity: r.severity,
      title: oneLine(r.title, TITLE_MAX),
      openedAtMs: r.opened_at_ms,
    })),
    total,
  };
}

function sentryBlock(
  db: Database,
  record: IncidentRecordV1,
  input: InvestigateInput,
  span: { fromMs: number; toMs: number },
): SentryBlock {
  const none = (status: SentryBlock["status"], projects: readonly string[] = []): SentryBlock => ({
    status,
    projects,
    rows: [],
    total: 0,
    scanCapped: false,
  });
  const service = record.binding.service;
  if (!record.binding.bound || service === null) return none("not_scoped");
  if (input.serviceConfigs === null) return none("no_config");
  const projects = input.serviceConfigs.get(service)?.sentryProjects ?? [];
  if (projects.length === 0) return none("no_projects");
  const found = readSentry(db, {
    projects,
    fromMs: span.fromMs,
    toMs: span.toMs,
    excludeItemId: record.trigger.itemId,
    deployStartMs: record.change.deployment?.startedAtMs ?? null,
  });
  return {
    status: "ok",
    projects: [...projects],
    rows: found.rows.slice(0, INVESTIGATE_ROW_CAP),
    total: found.rows.length,
    scanCapped: found.scanCapped,
  };
}

/** Builds the investigation of a STORED record, or `null` when no record has that id. */
export function investigateRecord(db: Database, input: InvestigateInput): Investigation | null {
  const row = getById(db, input.recordId);
  if (row === null) return null;
  const record = JSON.parse(row.record_json) as IncidentRecordV1;
  const t = record.trigger;
  const anchor = t.opened.ms ?? t.firstObservedMs ?? row.assembled_at_ms;
  const span = {
    fromMs: anchor - INVESTIGATE_LOOKBACK_MS,
    toMs: t.status === "closed" && t.closed.ms !== null ? t.closed.ms : input.nowMs,
  };
  const sentry = sentryBlock(db, record, input, span);
  const related = relatedOf(db, row);
  const freshness = freshnessOf(db);
  const { read: timeline, actionsTruncated } = readTimelineWithCaps(db, row.id);
  const actions: LinkedAction[] = timeline.timeline.events
    .filter(
      (e): e is typeof e & { kind: ActionEventKind } =>
        e.kind === "action_approved" || e.kind === "action_denied" || e.kind === "action_undone",
    )
    .map((e) => ({ atMs: e.atMs, kind: e.kind, text: e.text }));
  return {
    recordId: row.id,
    version: row.version,
    asOfMs: input.nowMs,
    span,
    trigger: {
      itemId: t.itemId,
      service: t.service,
      type: t.type,
      title: oneLine(t.title, TITLE_MAX),
      url: t.url,
      status: t.status,
      severity: t.severity,
      openedAtMs: t.opened.ms,
      closedAtMs: t.closed.ms,
    },
    binding: {
      bound: record.binding.bound,
      service: record.binding.service,
      via: record.binding.via,
    },
    sentry,
    data: dataBlock(record),
    relatedOpen: related,
    actions,
    leads: buildLeads(record, sentry.rows, related.items),
    gaps: gapsFor(sentry, record.binding.bound, freshness, record, actionsTruncated),
    freshness,
    recordAssembledAtMs: row.assembled_at_ms,
  };
}
