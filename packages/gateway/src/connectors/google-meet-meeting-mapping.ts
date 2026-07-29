import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

/**
 * A participant on a Google Meet conference record, reduced to what identifies
 * the person and nothing else.
 *
 * `kind` distinguishes the three mutually-exclusive union members the API
 * returns (`signedinUser` / `anonymousUser` / `phoneUser`), because "Ada
 * Lovelace signed in with a Workspace account" and "someone typed 'Ada' into
 * the anonymous join box" are very different claims about identity.
 *
 * **Deliberately absent: `earliestStartTime` / `latestEndTime`.** They answer
 * "how long did each person stay", which is attendance surveillance rather than
 * "who was in that meeting" — the question this connector is answering. The
 * conference record's own `startTime` / `endTime` already bound the meeting.
 *
 * **Deliberately absent: the participant resource `name`** — an opaque
 * per-conference handle. `id` (the `users/{id}` directory id, interoperable
 * with the People API / Admin SDK) is the durable identity, and the field a
 * future people-graph link would key on.
 */
export interface GoogleMeetParticipant {
  readonly kind: "signed_in" | "anonymous" | "phone";
  /** `users/{id}` for a signed-in user; null for anonymous + phone joins. */
  readonly id: string | null;
  /**
   * For a phone join this is the partially-redacted number Google itself
   * returns — kept because it is the ONLY thing identifying a dial-in
   * participant, and dropping it would leave an unattributable blank.
   */
  readonly displayName: string | null;
}

export interface GoogleMeetMappingContext {
  readonly syncedAt: number;
  /** Participants for THIS conference record; omit when none were fetched. */
  readonly participants?: readonly GoogleMeetParticipant[];
  /**
   * The collection's `totalSize`, which can exceed the stored roster once the
   * sync handler's fetch cap clips it. Falls back to the stored length.
   */
  readonly participantCount?: number;
}

export type GoogleMeetMappedRow = MappedRow<"google_meet", "meeting">;

/** Names carried in the synthesized title before it collapses to a `+N` suffix. */
const TITLE_NAME_LIMIT = 3;

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

function nonEmpty(v: string | undefined): string | null {
  return v !== undefined && v !== "" ? v : null;
}

/**
 * Map one `conferenceRecords.participants.list` entry. Returns null when the
 * entry carries no union member, or carries one with nothing identifying in it
 * — an entry with neither an id nor a display name is a blank row, not a person.
 */
export function mapGoogleMeetParticipant(raw: unknown): GoogleMeetParticipant | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const signedIn = asRecord(row["signedinUser"]);
  if (signedIn !== undefined) {
    const id = nonEmpty(stringField(signedIn, "user"));
    const displayName = nonEmpty(stringField(signedIn, "displayName"));
    if (id === null && displayName === null) {
      return null;
    }
    return { kind: "signed_in", id, displayName };
  }

  const anonymous = asRecord(row["anonymousUser"]);
  if (anonymous !== undefined) {
    const displayName = nonEmpty(stringField(anonymous, "displayName"));
    return displayName === null ? null : { kind: "anonymous", id: null, displayName };
  }

  const phone = asRecord(row["phoneUser"]);
  if (phone !== undefined) {
    const displayName = nonEmpty(stringField(phone, "displayName"));
    return displayName === null ? null : { kind: "phone", id: null, displayName };
  }

  return null;
}

/** Map a `participants` array, skipping unusable entries and clipping at `max`. */
export function mapGoogleMeetParticipants(
  raw: unknown,
  max: number,
): readonly GoogleMeetParticipant[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: GoogleMeetParticipant[] = [];
  for (const entry of raw) {
    if (out.length >= max) {
      break;
    }
    const mapped = mapGoogleMeetParticipant(entry);
    if (mapped !== null) {
      out.push(mapped);
    }
  }
  return out;
}

function participantNames(participants: readonly GoogleMeetParticipant[]): string[] {
  const names: string[] = [];
  for (const p of participants) {
    if (p.displayName !== null) {
      names.push(p.displayName);
    }
  }
  return names;
}

/**
 * Conference records carry no human-authored title, so one is synthesized.
 *
 * v1 used the start date alone (`Meeting 2024-01-02`), which is close to
 * unsearchable — nobody recalls a meeting by its date. With participants
 * available the title leads with who was there (`Meeting with Ada Lovelace,
 * Grace Hopper — 2024-01-02`), capped at `TITLE_NAME_LIMIT` names plus a `+N`
 * remainder so a 40-person all-hands does not produce a 40-name title. The v1
 * shape stays as the fallback whenever no participant carried a name.
 */
function deriveTitle(
  startTime: string | null,
  id: string,
  names: readonly string[],
  totalCount: number,
): string {
  const ms = parseIsoMs(startTime);
  const suffix = ms === null ? id : new Date(ms).toISOString().slice(0, 10);
  if (names.length === 0) {
    return `Meeting ${suffix}`;
  }
  const shown = names.slice(0, TITLE_NAME_LIMIT);
  const hidden = totalCount - shown.length;
  const who = hidden > 0 ? `${shown.join(", ")} +${String(hidden)}` : shown.join(", ");
  return `Meeting with ${who} — ${suffix}`;
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

  const participants = ctx.participants ?? [];
  const participantCount = ctx.participantCount ?? participants.length;
  const names = participantNames(participants);

  const title = deriveTitle(startTime, id, names, participantCount);
  // The full stored roster goes in the body so every attendee is searchable,
  // not just the handful the title has room for.
  const bodyPreview = names.length > 0 ? names.join(", ") : title;

  const metadata: Record<string, unknown> = {
    name,
    space,
    startTime,
    endTime,
    participants,
    participantCount,
  };

  return {
    service: "google_meet",
    type: "meeting",
    externalId: id,
    title,
    bodyPreview,
    // Conference records carry no productUrl; the pure mapper has no space meetingUri.
    url: null,
    canonicalUrl: null,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
