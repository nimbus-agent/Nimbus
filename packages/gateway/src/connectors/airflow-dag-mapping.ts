import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export interface AirflowMappingContext {
  readonly baseUrl: string;
  readonly syncedAt: number;
}

export type AirflowMappedRow = MappedRow<"airflow", "dag">;

const TITLE_MAX = 200;

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

export function dagUrl(baseUrl: string, dagId: string): string {
  return `${trimTrailingSlash(baseUrl)}/dags/${encodeURIComponent(dagId)}/grid`;
}

/** Parse an ISO-8601 timestamp string into unix ms, or null if absent/unparseable. */
export function parseIsoMs(raw: unknown): number | null {
  if (typeof raw !== "string" || raw === "") {
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

function owners(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const o of raw) {
    if (typeof o === "string" && o !== "") {
      out.push(o);
    }
  }
  return out;
}

function tagNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const names: string[] = [];
  for (const t of raw) {
    const row = asRecord(t);
    if (row === undefined) {
      continue;
    }
    const name = stringField(row, "name");
    if (name !== undefined && name !== "") {
      names.push(name);
    }
  }
  return names;
}

/** Airflow schedule_interval is `{ __type, value }`; surface the human-readable value. */
function scheduleInterval(raw: unknown): string | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const value = row["value"];
  if (typeof value === "string" && value !== "") {
    return value;
  }
  return null;
}

function clampTitle(s: string): string {
  return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX)}…` : s;
}

export function mapAirflowDagToItem(
  raw: unknown,
  ctx: AirflowMappingContext,
): AirflowMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const dagId = stringField(row, "dag_id");
  if (dagId === undefined || dagId === "") {
    return null;
  }

  const isPaused = row["is_paused"] === true;
  const isActive = row["is_active"] === true;
  const description = stringField(row, "description") ?? null;
  const fileloc = stringField(row, "fileloc") ?? null;
  const ownerList = owners(row["owners"]);
  const tags = tagNames(row["tags"]);
  const schedule = scheduleInterval(row["schedule_interval"]);
  const nextDagrun = parseIsoMs(row["next_dagrun"]);
  const lastParsedTime = parseIsoMs(row["last_parsed_time"]);

  const canonicalUrl = dagUrl(ctx.baseUrl, dagId);
  const title = clampTitle(
    description !== null && description !== "" ? `${dagId} — ${description}` : dagId,
  );
  const bodyPreview =
    description !== null && description !== "" ? `${dagId}: ${description}` : `DAG: ${dagId}`;
  const modifiedAt = lastParsedTime ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    dag_id: dagId,
    is_paused: isPaused,
    is_active: isActive,
    owners: ownerList,
    description,
    schedule_interval: schedule,
    tags,
    fileloc,
    next_dagrun: nextDagrun,
    last_parsed_time: lastParsedTime,
    canonical_url: canonicalUrl,
  };

  return {
    service: "airflow",
    type: "dag",
    externalId: dagId,
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
