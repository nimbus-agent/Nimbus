import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export interface PrefectMappingContext {
  /**
   * The per-tenant workspace API root (e.g. a Prefect Cloud
   * `.../accounts/<id>/workspaces/<id>` URL or a self-hosted `.../api` root).
   * Prefect exposes no clean deployment permalink derivable from the API root
   * generically, so `canonicalUrl`/`url` are always null.
   */
  readonly apiUrl: string;
  readonly syncedAt: number;
}

export type PrefectMappedRow = MappedRow<"prefect", "deployment">;

const TITLE_MAX = 200;

/** Parse an ISO-8601 timestamp string into unix ms, or null if absent/unparseable. */
export function parseIsoMs(raw: unknown): number | null {
  if (typeof raw !== "string" || raw === "") {
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/** Prefect deployment tags are a bare string array. */
function tags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t === "string" && t !== "") {
      out.push(t);
    }
  }
  return out;
}

/**
 * Prefect surfaces schedules as a `schedules` array (newer API) or a single
 * `schedule` object (older API). Either way, stringify the structure for a
 * compact human-readable summary, or null when absent.
 */
function scheduleSummary(row: Record<string, unknown>): string | null {
  const schedules = row["schedules"];
  if (Array.isArray(schedules) && schedules.length > 0) {
    return JSON.stringify(schedules);
  }
  const single = row["schedule"];
  if (single !== null && single !== undefined && typeof single === "object") {
    return JSON.stringify(single);
  }
  return null;
}

function optionalString(row: Record<string, unknown>, key: string): string | null {
  const v = stringField(row, key);
  return v !== undefined && v !== "" ? v : null;
}

function clampTitle(s: string): string {
  return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX)}…` : s;
}

export function mapPrefectDeploymentToItem(
  raw: unknown,
  ctx: PrefectMappingContext,
): PrefectMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const id = stringField(row, "id");
  if (id === undefined || id === "") {
    return null;
  }

  const name = optionalString(row, "name");
  const flowId = optionalString(row, "flow_id");
  const description = optionalString(row, "description");
  const paused = row["paused"] === true;
  const workPoolName = optionalString(row, "work_pool_name");
  const workQueueName = optionalString(row, "work_queue_name");
  const schedule = scheduleSummary(row);
  const status = optionalString(row, "status");
  const created = parseIsoMs(row["created"]);
  const updated = parseIsoMs(row["updated"]);

  const label = name ?? id;
  const title = clampTitle(description !== null ? `${label} — ${description}` : label);
  const bodyPreview = description !== null ? `${label}: ${description}` : `Deployment: ${label}`;
  const modifiedAt = updated ?? created ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    deployment_id: id,
    name,
    flow_id: flowId,
    description,
    tags: tags(row["tags"]),
    paused,
    work_pool_name: workPoolName,
    work_queue_name: workQueueName,
    schedule,
    status,
    created,
    updated,
    canonical_url: null,
  };

  return {
    service: "prefect",
    type: "deployment",
    externalId: id,
    title,
    bodyPreview,
    url: null,
    canonicalUrl: null,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
