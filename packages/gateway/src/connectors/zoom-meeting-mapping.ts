/**
 * Pure mapping from a Zoom `GET /v2/users/me/meetings?type=scheduled` list
 * element to the {@link upsertIndexedItemForSync} row shape. Lives separately
 * from `zoom-sync.ts` so the REST path and the indexing path can be tested
 * independently.
 *
 * Emits `service = "zoom", type = "meeting"` rows. `external_id = String(id)`
 * (Zoom meeting ids are numbers, like Raindrop's `_id` and Stack Overflow's
 * question ids); the row is skipped when `id` is missing/non-numeric.
 *
 * IMPORTANT: Zoom's `start_time` and `created_at` are ISO-8601 STRINGS (e.g.
 * `"2026-06-01T10:00:00Z"`), like the Stack Overflow / Readwise / Raindrop
 * connectors. Parse them to epoch-ms with the local {@link parseIsoMs}; never
 * pass through verbatim and never treat as epoch seconds.
 *
 * `zoom:meeting` is sparse-structured (topic + start_time + ids) — it is
 * deliberately NOT added to `PROSE_HEAVY_TYPES`. PR-3 adds `zoom:transcript`
 * to the prose-heavy set.
 */

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

/** ISO-8601 string → epoch ms, or null for non-strings / unparseable input. */
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
    // modifiedAt uses created_at, NOT start_time. start_time is when the
    // meeting will happen — for scheduled future meetings it would produce a
    // future modifiedAt, which would corrupt "modified since X" queries.
    // Zoom's /v2/users/me/meetings list endpoint does not return an
    // updated_at field (only the GET /v2/meetings/{id} endpoint does); when
    // we eventually add per-meeting GET enrichment we can prefer updated_at.
    modifiedAt: createdMs ?? ctx.syncedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
