import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface CloudwatchMappingContext {
  readonly syncedAt: number;
  /** Optional stream COUNT for the group (stream metadata, not events). */
  readonly streamCount?: number;
  /** Optional last-event epoch-millis timestamp across the group's streams. */
  readonly lastEventTimestamp?: number;
}

export type CloudwatchMappedRow = MappedRow<"cloudwatch", "log_group">;

const TITLE_MAX = 256;
const BODY_MAX = 512;

/**
 * CloudWatch Logs timestamps (`creationTime`, `lastEventTimestamp`) arrive as
 * epoch MILLIS numbers from the AWS CLI. Parse defensively to unix millis, else
 * null. A bare number < 1e12 is treated as seconds (defensive); larger numbers
 * are assumed to already be millis.
 */
/** Normalise a finite epoch number to millis: a value < 1e12 is seconds. */
function epochToMs(n: number): number {
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function parseTimestampMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return epochToMs(v);
  }
  if (typeof v === "string" && v.trim() !== "") {
    const trimmed = v.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isFinite(n) ? epochToMs(n) : null;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Pure mapper: CloudWatch `describe-log-groups` entry → IndexedItem. Stores
 * log-GROUP metadata ONLY — name, ARN, retention, stored bytes, creation time,
 * metric-filter count, and (optionally) a stream COUNT + last-event timestamp.
 * NEVER stores log-event messages / row data. Returns null when the log-group
 * name is missing.
 */
export function mapCloudwatchLogGroupToItem(
  raw: unknown,
  ctx: CloudwatchMappingContext,
): CloudwatchMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const logGroupName = stringField(row, "logGroupName");
  if (logGroupName === undefined || logGroupName === "") {
    return null;
  }

  const arn = stringField(row, "arn") ?? null;
  const retentionInDays = numberField(row, "retentionInDays");
  const storedBytes = numberField(row, "storedBytes");
  const metricFilterCount = numberField(row, "metricFilterCount");
  const creationTime = parseTimestampMs(row["creationTime"]);
  const lastEventTimestamp =
    ctx.lastEventTimestamp !== undefined && Number.isFinite(ctx.lastEventTimestamp)
      ? ctx.lastEventTimestamp
      : null;

  const title = clamp(logGroupName, TITLE_MAX);

  const bodyParts: string[] = [];
  if (retentionInDays !== undefined) {
    bodyParts.push(`retention:${retentionInDays}d`);
  }
  if (storedBytes !== undefined) {
    bodyParts.push(`storedBytes:${storedBytes}`);
  }
  if (metricFilterCount !== undefined) {
    bodyParts.push(`metricFilters:${metricFilterCount}`);
  }
  const bodyPreview = clamp(bodyParts.length > 0 ? bodyParts.join(", ") : logGroupName, BODY_MAX);

  const modifiedAt = lastEventTimestamp ?? creationTime ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    logGroupName,
    ...(arn === null ? {} : { arn }),
    ...(retentionInDays === undefined ? {} : { retentionInDays }),
    ...(storedBytes === undefined ? {} : { storedBytes }),
    ...(metricFilterCount === undefined ? {} : { metricFilterCount }),
    ...(ctx.streamCount === undefined ? {} : { streamCount: ctx.streamCount }),
    ...(lastEventTimestamp === null ? {} : { lastEventTimestamp }),
    ...(creationTime === null ? {} : { creationTime }),
  };

  return {
    service: "cloudwatch",
    type: "log_group",
    externalId: arn ?? logGroupName,
    title,
    bodyPreview,
    url: null,
    canonicalUrl: null,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
