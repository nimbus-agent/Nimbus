import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface ZoomMeetingMappingContext {
  readonly syncedAt: number;
}

export interface ZoomMeetingMappedRow {
  readonly service: "zoom";
  readonly type: "meeting";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

export function mapZoomMeetingToItem(
  raw: unknown,
  ctx: ZoomMeetingMappingContext,
): ZoomMeetingMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const id = numberField(row, "id");
  if (id === undefined) {
    return null;
  }
  const externalId = String(id);
  const topic = stringField(row, "topic");
  const title = topic !== undefined && topic !== "" ? topic : `Meeting ${externalId}`;
  const joinUrl = stringField(row, "join_url");
  const url = joinUrl !== undefined && joinUrl !== "" ? joinUrl : null;
  const agenda = stringField(row, "agenda");
  const bodyPreview =
    agenda !== undefined && agenda !== ""
      ? agenda
      : topic !== undefined && topic !== ""
        ? topic
        : title;
  const startMs = parseIsoMs(row["start_time"]);
  const createdMs = parseIsoMs(row["created_at"]);
  const metadata: Record<string, unknown> = {
    meeting_id: id,
    uuid: stringField(row, "uuid") ?? null,
    host_id: stringField(row, "host_id") ?? null,
    topic: topic ?? null,
    type: numberField(row, "type") ?? null,
    start_time: startMs,
    duration_min: numberField(row, "duration") ?? null,
    timezone: stringField(row, "timezone") ?? null,
    agenda: agenda ?? null,
    join_url: joinUrl ?? null,
    created_at: createdMs,
    canonical_url: url,
  };
  return {
    service: "zoom",
    type: "meeting",
    externalId,
    title,
    bodyPreview,
    url,
    canonicalUrl: url,
    modifiedAt: createdMs ?? ctx.syncedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
