import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export interface GoogleMeetMappingContext {
  readonly syncedAt: number;
}

export type GoogleMeetMappedRow = MappedRow<"google_meet", "meeting">;

/**
 * Google Meet conference-record timestamps (`startTime`, `endTime`) are RFC-3339
 * ISO-8601 strings. Return epoch-milliseconds, or null when unrecognizable.
 */
function parseIsoMs(v: unknown): number | null {
  if (typeof v !== "string" || v === "") {
    return null;
  }
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The conference-record `name` is `conferenceRecords/<id>`. Strip the collection
 * prefix to obtain the stable native id used as `external_id`.
 */
function conferenceRecordId(name: string): string {
  const slash = name.lastIndexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

/**
 * Conference records carry no human-authored title. Derive one from the start
 * date (ISO date portion) when available, else from the id.
 */
function deriveTitle(startTime: string | null, id: string): string {
  if (startTime !== null && startTime !== "") {
    const ms = parseIsoMs(startTime);
    if (ms !== null) {
      const isoDate = new Date(ms).toISOString().slice(0, 10);
      return `Meeting ${isoDate}`;
    }
  }
  return `Meeting ${id}`;
}

export function mapGoogleMeetRecordToItem(
  raw: unknown,
  ctx: GoogleMeetMappingContext,
): GoogleMeetMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const name = stringField(row, "name");
  if (name === undefined || name === "") {
    return null;
  }
  const id = conferenceRecordId(name);
  if (id === "") {
    return null;
  }

  const startTime = stringField(row, "startTime") ?? null;
  const endTime = stringField(row, "endTime") ?? null;
  const space = stringField(row, "space") ?? null;

  const startMs = parseIsoMs(startTime);
  const endMs = parseIsoMs(endTime);
  const modifiedAt = endMs ?? startMs ?? ctx.syncedAt;

  const title = deriveTitle(startTime, id);

  const metadata: Record<string, unknown> = {
    name,
    space,
    startTime,
    endTime,
  };

  return {
    service: "google_meet",
    type: "meeting",
    externalId: id,
    title,
    bodyPreview: title,
    // Conference records carry no productUrl; the pure mapper has no space meetingUri.
    url: null,
    canonicalUrl: null,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
