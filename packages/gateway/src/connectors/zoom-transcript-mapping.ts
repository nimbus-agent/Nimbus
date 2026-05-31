/**
 * Pure mapping from a Zoom cloud recording's TRANSCRIPT file (already-fetched
 * VTT text) to an `IndexedItem`-shaped row. Lives separately from
 * `zoom-sync.ts` so the VTT parsing + row shape can be tested without HTTP.
 *
 * Emits `service = "zoom", type = "transcript"` rows. `external_id` is the
 * pair `<meeting_uuid>:<recording_file_id>` — stable across re-syncs (Zoom
 * transcripts are immutable once generated; same meeting UUID + same file id
 * always means the same transcript), enabling cheap skip-if-exists checks.
 *
 * `zoom:transcript` is the prose-heavy partner of `zoom:meeting` (PR-2):
 * paragraph-shaped natural language, added to PROSE_HEAVY_TYPES so hybrid-mode
 * embeddings route to OpenAI text-embedding-3-small (1536-dim) when
 * `openai.api_key` is set; MiniLM-only fallback in MiniLM-only mode.
 *
 * The mapper deliberately does NOT fetch the `download_url` — the sync handler
 * is responsible for that (Bearer-header auth, never URL-token, never logged).
 * Receiving already-fetched `plainText` keeps the mapper pure.
 */

import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

const TRANSCRIPT_PREVIEW_MAX_CHARS = 280;

export interface ZoomTranscriptMappingInput {
  /** Parent meeting object from /v2/users/me/recordings → `meetings[]`. */
  readonly meeting: unknown;
  /** One element of `meetings[].recording_files[]` with `file_type === "TRANSCRIPT"`. */
  readonly recordingFile: unknown;
  /** VTT already-converted to plaintext via {@link vttToPlainText}. */
  readonly plainText: string;
  readonly syncedAt: number;
}

export type ZoomTranscriptMappedRow = MappedRow<"zoom", "transcript">;

/** ISO-8601 string → epoch ms, or null for non-strings / unparseable input. */
function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

/**
 * Match VTT inline tags ONLY — not arbitrary text in angle brackets.
 *
 * The WebVTT cue-payload grammar recognizes these tag names: `v` (voice),
 * `c` (class), `b` / `i` / `u` (style), `lang`, `ruby`, `rt` — plus karaoke
 * timestamp tags of the form `<HH:MM:SS.mmm>`. Anything outside that set is
 * preserved as literal text (e.g. a participant on the call literally saying
 * "the `<div>` tag" — the transcribed `<div>` must NOT be stripped). Review
 * point 1.1 narrowed the original `/<[^>]+>/g` greedy form to this allowlist.
 */
const VTT_TAG_REGEX = /<\/?(?:v|c|b|i|u|lang|ruby|rt)(?:[. ][^>]*)?>|<\d{2}:\d{2}:\d{2}\.\d{3}>/g;

/**
 * VTT → plaintext. Strips:
 * - The `WEBVTT` header and any `Kind:` / `Language:` / `NOTE` / `STYLE`
 *   metadata blocks.
 * - Pure-numeric cue-index lines.
 * - Timestamp lines (containing `-->`, with optional position attributes).
 * - Blank lines.
 * - VTT inline tags via {@link VTT_TAG_REGEX} (voice `<v Speaker>` incl.
 *   multi-word names, styling `<b>`/`<i>`/`<u>`/`<c.foo>`, language `<lang>`,
 *   ruby `<ruby>`/`<rt>`, karaoke timestamps `<00:00:01.000>`).
 *
 * Multi-line cue text is merged into a single line per cue, then cues are
 * joined with a space. Whitespace runs collapse to single spaces.
 */
/** True for VTT structural lines (header/metadata/timestamp/cue-index) that carry no cue text. */
function isVttNonContentLine(line: string): boolean {
  if (line === "WEBVTT" || line.startsWith("WEBVTT ")) {
    return true;
  }
  if (line.startsWith("Kind:") || line.startsWith("Language:") || line.startsWith("STYLE")) {
    return true;
  }
  if (line.includes("-->")) {
    // Timestamp line. May carry trailing positioning attributes.
    return true;
  }
  // Pure-numeric cue-index line.
  return /^\d+$/.test(line);
}

export function vttToPlainText(vtt: string): string {
  if (vtt === "") {
    return "";
  }
  const lines = vtt.split(/\r?\n/);
  const cues: string[] = [];
  let buffer: string[] = [];
  let inNoteBlock = false;
  const flushBuffer = (): void => {
    if (buffer.length > 0) {
      cues.push(buffer.join(" "));
      buffer = [];
    }
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") {
      flushBuffer();
      inNoteBlock = false;
      continue;
    }
    if (inNoteBlock) {
      continue;
    }
    if (line.startsWith("NOTE")) {
      inNoteBlock = true;
      continue;
    }
    if (isVttNonContentLine(line)) {
      continue;
    }
    // A cue-text line. Strip VTT-only inline tags (literal `<like this>` in
    // speech is preserved) and accumulate.
    const stripped = line.replaceAll(VTT_TAG_REGEX, "");
    buffer.push(stripped);
  }
  flushBuffer();
  return cues.join(" ").replaceAll(/\s+/g, " ").trim();
}

/**
 * Clip {@link mapZoomTranscriptToItem} `bodyPreview` to {@link
 * TRANSCRIPT_PREVIEW_MAX_CHARS} chars with a word-boundary cut + `…` suffix
 * (review point 1.2 — mid-word clips look bad in UI). When the last
 * `WORD_BOUNDARY_LOOKBACK` chars contain no space (pathological one-long-word
 * input), falls back to a hard clip + `…`.
 */
const WORD_BOUNDARY_LOOKBACK = 40;
function clipTranscriptPreview(text: string): string {
  if (text.length <= TRANSCRIPT_PREVIEW_MAX_CHARS) {
    return text;
  }
  const hard = text.slice(0, TRANSCRIPT_PREVIEW_MAX_CHARS);
  const lastSpace = hard.lastIndexOf(" ");
  if (lastSpace >= TRANSCRIPT_PREVIEW_MAX_CHARS - WORD_BOUNDARY_LOOKBACK) {
    return `${hard.slice(0, lastSpace)}…`;
  }
  return `${hard}…`;
}

export function mapZoomTranscriptToItem(
  input: ZoomTranscriptMappingInput,
): ZoomTranscriptMappedRow | null {
  if (input.plainText.trim() === "") {
    return null;
  }
  const meeting = asRecord(input.meeting);
  if (meeting === undefined) {
    return null;
  }
  const meetingUuid = stringField(meeting, "uuid");
  if (meetingUuid === undefined || meetingUuid === "") {
    return null;
  }
  const file = asRecord(input.recordingFile);
  if (file === undefined) {
    return null;
  }
  const fileId = stringField(file, "id");
  if (fileId === undefined || fileId === "") {
    return null;
  }
  const externalId = `${meetingUuid}:${fileId}`;
  const topic = stringField(meeting, "topic");
  const title =
    topic !== undefined && topic !== "" ? `Transcript — ${topic}` : `Transcript ${fileId}`;
  const playUrl = stringField(file, "play_url");
  const url = playUrl !== undefined && playUrl !== "" ? playUrl : null;
  const recordingStart = parseIsoMs(file["recording_start"]);
  const meetingId = numberField(meeting, "id");
  const bodyPreview = clipTranscriptPreview(input.plainText);
  const metadata: Record<string, unknown> = {
    meeting_id: meetingId ?? null,
    meeting_uuid: meetingUuid,
    recording_file_id: fileId,
    file_type: stringField(file, "file_type") ?? null,
    host_id: stringField(meeting, "host_id") ?? null,
    topic: topic ?? null,
    recording_start: recordingStart,
    play_url: url,
    transcript_text: input.plainText,
    canonical_url: url,
  };
  return {
    service: "zoom",
    type: "transcript",
    externalId,
    title,
    bodyPreview,
    url,
    canonicalUrl: url,
    modifiedAt: recordingStart ?? input.syncedAt,
    metadata,
    syncedAt: input.syncedAt,
  };
}
