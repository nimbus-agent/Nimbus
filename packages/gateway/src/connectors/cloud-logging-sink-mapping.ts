import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export interface CloudLoggingMappingContext {
  readonly project: string;
  readonly syncedAt: number;
}

export type CloudLoggingMappedRow = MappedRow<"cloud_logging", "sink">;

const TITLE_MAX = 256;
const BODY_MAX = 512;

/**
 * Parse a `gcloud logging` RFC3339 ISO timestamp string (e.g. `createTime`,
 * `updateTime`) into unix millis, or null if absent/unparseable.
 */
export function parseIsoMs(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }
  const ms = Date.parse(raw.trim());
  return Number.isNaN(ms) ? null : ms;
}

function boolField(r: Record<string, unknown>, key: string): boolean | undefined {
  const v = r[key];
  return typeof v === "boolean" ? v : undefined;
}

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Pure mapper: a GCP Cloud Logging routing SINK config (one entry from
 * `gcloud logging sinks list --format json`) → IndexedItem. Stores sink
 * CONFIG METADATA ONLY — sink name, destination, filter expression,
 * description, disabled flag, and create/update timestamps. NEVER stores log
 * ENTRIES / row data — there is no log-line payload here, only the routing
 * configuration. Returns null when the sink name is missing.
 */
export function mapCloudLoggingSinkToItem(
  raw: unknown,
  ctx: CloudLoggingMappingContext,
): CloudLoggingMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const sinkName = stringField(row, "name");
  if (sinkName === undefined || sinkName === "") {
    return null;
  }

  const destination = stringField(row, "destination") ?? null;
  const filter = stringField(row, "filter") ?? null;
  const description = stringField(row, "description") ?? null;
  const disabled = boolField(row, "disabled");
  const createTime = parseIsoMs(row["createTime"]);
  const updateTime = parseIsoMs(row["updateTime"]);

  const title = clamp(sinkName, TITLE_MAX);

  const bodyParts: string[] = [];
  if (destination !== null) {
    bodyParts.push(`destination:${destination}`);
  }
  if (filter !== null) {
    bodyParts.push(`filter:${filter}`);
  }
  if (disabled !== undefined) {
    bodyParts.push(`disabled:${disabled}`);
  }
  const bodyPreview = clamp(bodyParts.length > 0 ? bodyParts.join(", ") : sinkName, BODY_MAX);

  const modifiedAt = updateTime ?? createTime ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    project: ctx.project,
    sinkName,
    ...(destination !== null ? { destination } : {}),
    ...(filter !== null ? { filter } : {}),
    ...(description !== null ? { description } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
    ...(createTime !== null ? { createTime } : {}),
    ...(updateTime !== null ? { updateTime } : {}),
  };

  return {
    service: "cloud_logging",
    type: "sink",
    externalId: `${ctx.project}/${sinkName}`,
    title,
    bodyPreview,
    url: null,
    canonicalUrl: null,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
