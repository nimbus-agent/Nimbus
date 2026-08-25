import { itemPrimaryKey } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";
import { mapZoomMeetingToItem } from "./zoom-meeting-mapping.ts";
import { mapZoomTranscriptToItem, vttToPlainText } from "./zoom-transcript-mapping.ts";

const SERVICE_ID = "zoom";
const CURSOR_PREFIX = "nimbus-zoom1:";
const BASE = "https://api.zoom.us";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const INITIAL_RECORDINGS_DEPTH_DAYS = 30;
const RECORDINGS_WINDOW_DAYS = 30; // Zoom requires ≤1 month per call; 30 days is safe.
const MS_PER_DAY = 86_400_000;

type ZoomCursorV1 = {
  pass: number;
  /**
   * ISO-8601 boundary of the most-recent recordings walk's `to` parameter.
   * Null on first run; advanced after each successful Walk B cycle.
   * Used by the next cycle's incremental window (`from = lastRecordingsTo`).
   */
  lastRecordingsTo: string | null;
};

function emptyCursor(): ZoomCursorV1 {
  return { pass: 1, lastRecordingsTo: null };
}

function encodeCursor(c: ZoomCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function decodeCursor(raw: string | null): ZoomCursorV1 {
  if (raw === null || raw === "") {
    return emptyCursor();
  }
  const parsed = decodeNimbusJsonCursorPayload(raw, CURSOR_PREFIX);
  const rec = asRecord(parsed);
  if (rec === undefined) {
    return emptyCursor();
  }
  const lastTo = rec["lastRecordingsTo"];
  return {
    pass: 1,
    lastRecordingsTo: typeof lastTo === "string" && lastTo !== "" ? lastTo : null,
  };
}

export type ZoomSyncableOptions = {
  ensureZoomMcpRunning: () => Promise<void>;
};

function meetingsPath(pageToken: string): string {
  const params = new URLSearchParams({
    type: "scheduled",
    page_size: String(PAGE_SIZE),
  });
  if (pageToken !== "") {
    params.set("next_page_token", pageToken);
  }
  return `/v2/users/me/meetings?${params.toString()}`;
}

function recordingsPath(from: string, to: string, pageToken: string): string {
  const params = new URLSearchParams({
    from,
    to,
    page_size: String(PAGE_SIZE),
  });
  if (pageToken !== "") {
    params.set("next_page_token", pageToken);
  }
  return `/v2/users/me/recordings?${params.toString()}`;
}

function zoomGet(ctx: SyncContext, token: string, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
}

function extractPage(parsed: unknown): { meetings: unknown[]; nextPageToken: string } {
  const root = asRecord(parsed);
  if (root === undefined) {
    return { meetings: [], nextPageToken: "" };
  }
  const meetings = root["meetings"];
  const nextRaw = root["next_page_token"];
  return {
    meetings: Array.isArray(meetings) ? meetings : [],
    nextPageToken: typeof nextRaw === "string" ? nextRaw : "",
  };
}

function upsertMeetings(ctx: SyncContext, meetings: readonly unknown[], now: number): number {
  let upserted = 0;
  for (const m of meetings) {
    const mapped = mapZoomMeetingToItem(m, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    ctx.upsertItem(mapped);
    upserted += 1;
  }
  return upserted;
}

/**
 * Pure window calculator for the recordings walk. Zoom's
 * `/v2/users/me/recordings` requires a `from`/`to` pair spanning ≤1 month.
 * - Initial sync (`lastTo === null`): walk back {@link
 *   INITIAL_RECORDINGS_DEPTH_DAYS} days from now.
 * - Incremental (`lastTo !== null`): one ≤{@link RECORDINGS_WINDOW_DAYS}-day
 *   window from `lastTo`. Returns null when `lastTo >= now` (nothing to walk)
 *   or `lastTo` is unparseable.
 */
function nextRecordingsWindow(
  lastTo: string | null,
  nowMs: number,
): { from: string; to: string } | null {
  const windowMs = RECORDINGS_WINDOW_DAYS * MS_PER_DAY;
  if (lastTo === null) {
    const fromMs = nowMs - INITIAL_RECORDINGS_DEPTH_DAYS * MS_PER_DAY;
    return { from: new Date(fromMs).toISOString(), to: new Date(nowMs).toISOString() };
  }
  const lastToMs = Date.parse(lastTo);
  if (!Number.isFinite(lastToMs) || lastToMs >= nowMs) {
    return null;
  }
  const toMs = Math.min(lastToMs + windowMs, nowMs);
  return { from: new Date(lastToMs).toISOString(), to: new Date(toMs).toISOString() };
}

/**
 * Cheap skip-if-exists check exploiting transcript immutability: a transcript
 * at `<meeting_uuid>:<recording_file_id>` never changes, so an existing row
 * means we can skip re-downloading the VTT. A plain read — not subject to I14.
 */
function transcriptAlreadyIndexed(ctx: SyncContext, meetingUuid: string, fileId: string): boolean {
  const id = itemPrimaryKey("zoom", `${meetingUuid}:${fileId}`);
  return ctx.itemExists(id);
}

/**
 * Outcome of processing one meeting's TRANSCRIPT-typed recording files.
 * The caller threads `upserted` into its running total and treats
 * `rateLimited === true` as the graceful-break signal: stop the walk
 * immediately, do NOT advance `lastRecordingsTo`, let the next cycle replay
 * (skip-if-exists makes the replay cheap; external_id dedupe makes it correct).
 */
type TranscriptOutcome = {
  upserted: number;
  bytes: number;
  rateLimited: boolean;
};

/**
 * Result of processing one TRANSCRIPT-typed recording file:
 * - `skip`: not a downloadable/new transcript (continue to next file).
 * - `rate_limited`: 429 on download — caller must graceful-break.
 * - `done`: HTTP completed; `bytes` always counted, `upserted` 0 or 1.
 */
type TranscriptFileResult =
  | { kind: "skip" }
  | { kind: "rate_limited" }
  | { kind: "done"; bytes: number; upserted: number };

function selectTranscriptFile(
  ctx: SyncContext,
  file: Record<string, unknown>,
  meetingUuid: string,
): { fileId: string; downloadUrl: string } | null {
  if (stringField(file, "file_type") !== "TRANSCRIPT") {
    return null;
  }
  const fileId = stringField(file, "id");
  if (fileId === undefined || fileId === "") {
    return null;
  }
  if (transcriptAlreadyIndexed(ctx, meetingUuid, fileId)) {
    // Already-indexed transcripts are immutable; do not re-download.
    return null;
  }
  const downloadUrl = stringField(file, "download_url");
  if (downloadUrl === undefined || downloadUrl === "") {
    return null;
  }
  return { fileId, downloadUrl };
}

async function processTranscriptFile(
  ctx: SyncContext,
  token: string,
  meeting: Record<string, unknown>,
  file: Record<string, unknown>,
  meetingUuid: string,
  now: number,
): Promise<TranscriptFileResult> {
  const selected = selectTranscriptFile(ctx, file, meetingUuid);
  if (selected === null) {
    return { kind: "skip" };
  }
  const { fileId, downloadUrl } = selected;
  // Bearer-header auth ONLY. Never include `?access_token=` in the URL.
  // Never log the URL — it may carry a Zoom-issued auth token in older
  // recording flows. Log only the meeting_uuid + file_id + HTTP status.
  // We use a raw fetch (not connectorFetch) precisely because connectorFetch
  // logs the URL on failure; the rate limiter is acquired manually first to
  // preserve the same gating connectorFetch applies.
  await ctx.rateLimiter.acquire(SERVICE_ID);
  let res: Response;
  try {
    res = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/vtt, text/plain, */*" },
    });
  } catch {
    // Network error on download — skip this file (don't fail the whole cycle).
    ctx.logger.warn(
      { serviceId: SERVICE_ID, meetingUuid, fileId },
      "zoom transcript download failed (network)",
    );
    return { kind: "skip" };
  }
  if (res.status === 429) {
    ctx.logger.warn(
      { serviceId: SERVICE_ID, meetingUuid, fileId, status: 429 },
      "zoom transcript download 429 — graceful break",
    );
    return { kind: "rate_limited" };
  }
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn(
      { serviceId: SERVICE_ID, meetingUuid, fileId, status: res.status },
      "zoom transcript download failed",
    );
    return { kind: "done", bytes: text.length, upserted: 0 };
  }
  const row = mapZoomTranscriptToItem({
    meeting,
    recordingFile: file,
    plainText: vttToPlainText(text),
    syncedAt: now,
  });
  if (row === null) {
    return { kind: "done", bytes: text.length, upserted: 0 };
  }
  ctx.upsertItem(row);
  return { kind: "done", bytes: text.length, upserted: 1 };
}

async function processTranscriptsForMeeting(
  ctx: SyncContext,
  token: string,
  meeting: Record<string, unknown>,
  now: number,
): Promise<TranscriptOutcome> {
  const out: TranscriptOutcome = { upserted: 0, bytes: 0, rateLimited: false };
  const filesRaw = meeting["recording_files"];
  if (!Array.isArray(filesRaw)) {
    return out;
  }
  const meetingUuid = stringField(meeting, "uuid");
  if (meetingUuid === undefined || meetingUuid === "") {
    return out;
  }
  for (const fileRaw of filesRaw) {
    const file = asRecord(fileRaw);
    if (file === undefined) {
      continue;
    }
    const result = await processTranscriptFile(ctx, token, meeting, file, meetingUuid, now);
    if (result.kind === "skip") {
      continue;
    }
    if (result.kind === "rate_limited") {
      out.rateLimited = true;
      return out;
    }
    out.bytes += result.bytes;
    out.upserted += result.upserted;
  }
  return out;
}

type RecordingsWalkResult = {
  upserted: number;
  bytes: number;
  /** ISO-8601 to commit to `lastRecordingsTo` on success; null if walk was rate-limited mid-flight. */
  advancedTo: string | null;
};

/**
 * Process one recordings meeting: parent-meeting dedupe upsert + its
 * transcripts. `rateLimited` propagates the graceful-break signal upward.
 */
async function processRecordingsMeeting(
  ctx: SyncContext,
  token: string,
  meeting: Record<string, unknown>,
  nowMs: number,
): Promise<{ upserted: number; bytes: number; rateLimited: boolean }> {
  let upserted = 0;
  let bytes = 0;
  // Parent-meeting dedupe upsert. Walk A only sees type=scheduled; past
  // recorded meetings (one-time, completed) are surfaced here under the
  // same external_id = String(<meeting_id>), so a single row covers both.
  const meetingRow = mapZoomMeetingToItem(meeting, { syncedAt: nowMs });
  if (meetingRow !== null) {
    ctx.upsertItem(meetingRow);
    upserted += 1;
  }
  const transcripts = await processTranscriptsForMeeting(ctx, token, meeting, nowMs);
  upserted += transcripts.upserted;
  bytes += transcripts.bytes;
  return { upserted, bytes, rateLimited: transcripts.rateLimited };
}

/** Page-level result: `rateLimited` and `errored` both stop the walk without advancing. */
type RecordingsPageResult = {
  upserted: number;
  bytes: number;
  nextPageToken: string;
  stop: boolean;
  rateLimited: boolean;
};

async function processRecordingsPage(
  ctx: SyncContext,
  token: string,
  root: Record<string, unknown>,
  nowMs: number,
): Promise<RecordingsPageResult> {
  const result: RecordingsPageResult = {
    upserted: 0,
    bytes: 0,
    nextPageToken: "",
    stop: false,
    rateLimited: false,
  };
  const meetingsRaw = root["meetings"];
  const meetings = Array.isArray(meetingsRaw) ? meetingsRaw : [];
  for (const meetingRaw of meetings) {
    const meeting = asRecord(meetingRaw);
    if (meeting === undefined) {
      continue;
    }
    const m = await processRecordingsMeeting(ctx, token, meeting, nowMs);
    result.upserted += m.upserted;
    result.bytes += m.bytes;
    if (m.rateLimited) {
      result.rateLimited = true;
      return result;
    }
  }
  const nextTokenRaw = root["next_page_token"];
  const nextPageToken = typeof nextTokenRaw === "string" ? nextTokenRaw : "";
  result.nextPageToken = nextPageToken;
  result.stop = meetings.length === 0 || nextPageToken === "";
  return result;
}

async function runRecordingsWalk(
  ctx: SyncContext,
  token: string,
  window: { from: string; to: string },
  nowMs: number,
): Promise<RecordingsWalkResult> {
  const out: RecordingsWalkResult = { upserted: 0, bytes: 0, advancedTo: null };
  let pageToken = "";
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const outcome = await zoomGet(ctx, token, recordingsPath(window.from, window.to, pageToken));
    out.bytes += outcome.bytes;
    if (outcome.kind !== "ok") {
      // Mid-walk http/parse error: keep whatever we already upserted, do not
      // advance lastRecordingsTo. Next cycle replays this window.
      return out;
    }
    const root = asRecord(outcome.parsed);
    if (root === undefined) {
      break;
    }
    const pageResult = await processRecordingsPage(ctx, token, root, nowMs);
    out.upserted += pageResult.upserted;
    out.bytes += pageResult.bytes;
    if (pageResult.rateLimited) {
      // Graceful break — return without advancing the cursor.
      return out;
    }
    if (pageResult.stop) {
      break;
    }
    pageToken = pageResult.nextPageToken;
  }
  // Walk completed cleanly (either by exhausting pages or hitting MAX_PAGES).
  out.advancedTo = window.to;
  return out;
}

/**
 * Walk A result. `firstPageError` is non-null ONLY when page 1 failed — the
 * caller returns an empty pass-cursor result and does NOT run Walk B (matches
 * the original early-return). A mid-walk error (page ≥ 2) leaves
 * `firstPageError === null` so Walk B still runs.
 */
type MeetingsWalkResult = {
  upserted: number;
  bytes: number;
  firstPageError: "http_error" | "parse_error" | null;
};

async function runMeetingsWalk(
  ctx: SyncContext,
  token: string,
  nowMs: number,
): Promise<MeetingsWalkResult> {
  let upserted = 0;
  let bytes = 0;
  let pageToken = "";
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const outcome = await zoomGet(ctx, token, meetingsPath(pageToken));
    bytes += outcome.bytes;
    if (outcome.kind !== "ok") {
      if (page === 1) {
        return { upserted, bytes, firstPageError: outcome.kind };
      }
      // Mid-walk meetings-list error: stop Walk A but still run Walk B for
      // this cycle (a transient meetings failure should not block it).
      break;
    }
    const { meetings, nextPageToken } = extractPage(outcome.parsed);
    upserted += upsertMeetings(ctx, meetings, nowMs);
    if (meetings.length === 0 || nextPageToken === "") {
      break;
    }
    pageToken = nextPageToken;
  }
  return { upserted, bytes, firstPageError: null };
}

export function createZoomSyncable(options: ZoomSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureZoomMcpRunning();

      const raw = await ctx.getSecret("oauth");
      if (raw === null || raw === "") {
        return syncNoopResult(cursor, t0);
      }
      let token: string;
      try {
        token = await ctx.accessToken();
      } catch {
        return syncNoopResult(cursor, t0);
      }
      if (token === "") {
        return syncNoopResult(cursor, t0);
      }

      const prev = decodeCursor(cursor);
      const nowMs = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;

      // --- Walk A: scheduled meetings -------------------------------------
      const walkA = await runMeetingsWalk(ctx, token, nowMs);
      totalBytes += walkA.bytes;
      totalUpserted += walkA.upserted;
      if (walkA.firstPageError !== null) {
        const fallbackCursor = encodeCursor(prev);
        return walkA.firstPageError === "http_error"
          ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, fallbackCursor)
          : syncPassCursorParseEmpty(t0, totalBytes, fallbackCursor);
      }

      // --- Walk B: recordings + transcripts --------------------------------
      const window = nextRecordingsWindow(prev.lastRecordingsTo, nowMs);
      let nextCursorState: ZoomCursorV1 = prev;
      if (window !== null) {
        const result = await runRecordingsWalk(ctx, token, window, nowMs);
        totalBytes += result.bytes;
        totalUpserted += result.upserted;
        if (result.advancedTo !== null) {
          nextCursorState = { pass: 1, lastRecordingsTo: result.advancedTo };
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, encodeCursor(nextCursorState), totalUpserted);
    },
  };
}
