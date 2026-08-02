import { describe, expect, it } from "bun:test";

import { mapZoomTranscriptToItem, vttToPlainText } from "./zoom-transcript-mapping.ts";

const SYNCED_AT = 1_700_000_000_000;

describe("vttToPlainText", () => {
  it("strips WEBVTT header, cue indices, timestamps, and blank lines", () => {
    const vtt = [
      "WEBVTT",
      "",
      "1",
      "00:00:00.500 --> 00:00:03.200",
      "Hello world.",
      "",
      "2",
      "00:00:03.500 --> 00:00:08.100",
      "How are you?",
      "",
    ].join("\n");
    expect(vttToPlainText(vtt)).toBe("Hello world. How are you?");
  });

  it("strips voice tags like <v Alice>", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.500 --> 00:00:03.200",
      "<v Alice>Welcome to the call.",
      "",
      "00:00:03.500 --> 00:00:06.000",
      "<v Bob>Thanks Alice.",
    ].join("\n");
    expect(vttToPlainText(vtt)).toBe("Welcome to the call. Thanks Alice.");
  });

  it("preserves literal text in angle brackets that is NOT a VTT tag", () => {
    // Speech transcribed with angle-bracketed content (rare but possible —
    // discussing HTML/code on a call). The allowlist regex only strips
    // known VTT tags + karaoke timestamps; arbitrary natural-language
    // content inside `<...>` must survive verbatim. Review point 1.1.
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "We talked about <div> tags in HTML.",
      "",
      "00:00:02.000 --> 00:00:04.000",
      "And the <like this> shorthand they were using.",
    ].join("\n");
    expect(vttToPlainText(vtt)).toBe(
      "We talked about <div> tags in HTML. And the <like this> shorthand they were using.",
    );
  });

  it("strips karaoke-style timestamp tags <HH:MM:SS.mmm>", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:05.000",
      "Hello <00:00:01.500>world <00:00:03.000>everyone.",
    ].join("\n");
    expect(vttToPlainText(vtt)).toBe("Hello world everyone.");
  });

  it("strips styling tags <b>, <i>, <c.red>", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "I have <b>three</b> things to cover.",
      "",
      "00:00:02.000 --> 00:00:04.000",
      "And one is <i>especially</i> important.",
      "",
      "00:00:04.000 --> 00:00:06.000",
      "<c.red>Critical</c.red> finding.",
    ].join("\n");
    expect(vttToPlainText(vtt)).toBe(
      "I have three things to cover. And one is especially important. Critical finding.",
    );
  });

  it("merges multi-line cue text into a single line per cue", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:05.000",
      "This is the first half",
      "and this is the second half of the same cue.",
      "",
      "00:00:05.000 --> 00:00:08.000",
      "Next cue.",
    ].join("\n");
    expect(vttToPlainText(vtt)).toBe(
      "This is the first half and this is the second half of the same cue. Next cue.",
    );
  });

  it("drops NOTE blocks, Kind:, and Language: metadata lines", () => {
    const vtt = [
      "WEBVTT",
      "Kind: captions",
      "Language: en",
      "",
      "NOTE This is a comment that VTT spec says to ignore.",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "Actual content.",
    ].join("\n");
    expect(vttToPlainText(vtt)).toBe("Actual content.");
  });

  it("collapses runs of whitespace within a cue", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "Hello    world\t\ttab    spaces.",
    ].join("\n");
    expect(vttToPlainText(vtt)).toBe("Hello world tab spaces.");
  });

  it("returns empty string for empty input", () => {
    expect(vttToPlainText("")).toBe("");
    expect(vttToPlainText("WEBVTT\n\n")).toBe("");
  });

  it("supports multi-word voice tag attributes like <v Alice Smith>", () => {
    // The allowlist regex must accept `v` followed by a space and arbitrary
    // attribute text up to `>`. Review point 1.1 narrowing must not regress
    // this.
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "<v Alice Smith>Welcome from Alice.",
    ].join("\n");
    expect(vttToPlainText(vtt)).toBe("Welcome from Alice.");
  });

  it("tolerates timestamp lines with positioning attributes", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:02.000 align:start position:10%",
      "Positioned cue.",
    ].join("\n");
    expect(vttToPlainText(vtt)).toBe("Positioned cue.");
  });
});

describe("mapZoomTranscriptToItem", () => {
  const RECORDING_FILE = {
    id: "rec-file-abc",
    meeting_id: "abcd==",
    file_type: "TRANSCRIPT",
    recording_start: "2026-06-01T10:05:00Z",
    play_url: "https://zoom.us/rec/play/xyz",
    download_url: "https://api.zoom.us/v2/...",
  };
  const MEETING = {
    id: 83476203401,
    uuid: "abcd==",
    topic: "Weekly Sync",
    host_id: "host-1",
  };
  const PLAIN_TEXT = "Welcome to the call. We covered three things.";

  it("emits a zoom:transcript row with stable external_id = <uuid>:<file_id>", () => {
    const row = mapZoomTranscriptToItem({
      meeting: MEETING,
      recordingFile: RECORDING_FILE,
      plainText: PLAIN_TEXT,
      syncedAt: SYNCED_AT,
    });
    expect(row).not.toBeNull();
    expect(row?.service).toBe("zoom");
    expect(row?.type).toBe("transcript");
    expect(row?.externalId).toBe("abcd==:rec-file-abc");
    expect(row?.title).toBe("Transcript — Weekly Sync");
    expect(row?.canonicalUrl).toBe("https://zoom.us/rec/play/xyz");
    expect(row?.url).toBe("https://zoom.us/rec/play/xyz");
    expect(row?.metadata).toMatchObject({
      meeting_id: 83476203401,
      meeting_uuid: "abcd==",
      recording_file_id: "rec-file-abc",
      file_type: "TRANSCRIPT",
      host_id: "host-1",
    });
    expect(row?.metadata["recording_start"]).toBe(Date.parse("2026-06-01T10:05:00Z"));
    expect(row?.metadata["transcript_text"]).toBe(PLAIN_TEXT);
    // `body` is the declared-full transcript text, verbatim — the store (not
    // this mapper) is now the single place that applies any length cap.
    expect(row?.body).toBe(PLAIN_TEXT);
  });

  it("body carries the full plainText untruncated, even when very long", () => {
    // Previously `clipTranscriptPreview` hard-capped this to 280 chars before
    // it ever reached the store. That clamp is gone: the mapper now passes
    // the complete text through via `body:`.
    const longText = "lorem ipsum dolor sit amet ".repeat(200); // ~5400 chars
    const row = mapZoomTranscriptToItem({
      meeting: MEETING,
      recordingFile: RECORDING_FILE,
      plainText: longText,
      syncedAt: SYNCED_AT,
    });
    expect(row).not.toBeNull();
    expect(row?.body).toBe(longText);
    expect(row?.body.length).toBeGreaterThan(280);
  });

  it("title falls back to `Transcript <fileId>` when topic is missing", () => {
    const row = mapZoomTranscriptToItem({
      meeting: { id: 1, uuid: "u1" },
      recordingFile: { ...RECORDING_FILE, meeting_id: "u1" },
      plainText: "x",
      syncedAt: SYNCED_AT,
    });
    expect(row?.title).toBe("Transcript rec-file-abc");
  });

  it("canonicalUrl is null when play_url is missing", () => {
    const row = mapZoomTranscriptToItem({
      meeting: MEETING,
      recordingFile: { ...RECORDING_FILE, play_url: undefined },
      plainText: PLAIN_TEXT,
      syncedAt: SYNCED_AT,
    });
    expect(row?.url).toBeNull();
    expect(row?.canonicalUrl).toBeNull();
  });

  it("modifiedAt prefers recording_start, else syncedAt", () => {
    const row = mapZoomTranscriptToItem({
      meeting: MEETING,
      recordingFile: RECORDING_FILE,
      plainText: PLAIN_TEXT,
      syncedAt: SYNCED_AT,
    });
    expect(row?.modifiedAt).toBe(Date.parse("2026-06-01T10:05:00Z"));
    const row2 = mapZoomTranscriptToItem({
      meeting: MEETING,
      recordingFile: { ...RECORDING_FILE, recording_start: undefined },
      plainText: PLAIN_TEXT,
      syncedAt: SYNCED_AT,
    });
    expect(row2?.modifiedAt).toBe(SYNCED_AT);
  });

  it("returns null when meeting uuid is missing (cannot form stable external_id)", () => {
    expect(
      mapZoomTranscriptToItem({
        meeting: { id: 1 }, // no uuid
        recordingFile: RECORDING_FILE,
        plainText: PLAIN_TEXT,
        syncedAt: SYNCED_AT,
      }),
    ).toBeNull();
  });

  it("returns null when recording_file id is missing", () => {
    expect(
      mapZoomTranscriptToItem({
        meeting: MEETING,
        recordingFile: { file_type: "TRANSCRIPT" }, // no id
        plainText: PLAIN_TEXT,
        syncedAt: SYNCED_AT,
      }),
    ).toBeNull();
  });

  it("returns null when plainText is empty (no signal to embed)", () => {
    expect(
      mapZoomTranscriptToItem({
        meeting: MEETING,
        recordingFile: RECORDING_FILE,
        plainText: "",
        syncedAt: SYNCED_AT,
      }),
    ).toBeNull();
  });

  it("syncedAt is passed through to the row", () => {
    const row = mapZoomTranscriptToItem({
      meeting: MEETING,
      recordingFile: RECORDING_FILE,
      plainText: PLAIN_TEXT,
      syncedAt: SYNCED_AT,
    });
    expect(row?.syncedAt).toBe(SYNCED_AT);
  });
});
