/**
 * Zoom transcript mapping paths the main suite does not reach: a NOTE block that spans several
 * lines, a meeting or recording file that is not an object, and a file with no `file_type`.
 */
import { describe, expect, test } from "bun:test";

import { mapZoomTranscriptToItem, vttToPlainText } from "./zoom-transcript-mapping.ts";

const SYNCED_AT = 1_750_000_000_000;
const MEETING = { id: 777, uuid: "uuid-777", topic: "Design review", host_id: "h-1" };
const FILE = {
  id: "tx-1",
  file_type: "TRANSCRIPT",
  play_url: "https://zoom.us/rec/play/tx-1",
  recording_start: "2026-06-01T10:05:00Z",
};

describe("vttToPlainText — multi-line NOTE blocks", () => {
  test("every line of a NOTE block is dropped up to the blank line that ends it", () => {
    const vtt = [
      "WEBVTT",
      "",
      "NOTE reviewer comment",
      "this line is still the note",
      "<v Bob>so is this one",
      "",
      "1",
      "00:00:01.000 --> 00:00:02.000",
      "<v Ana>Hello there.",
    ].join("\n");
    expect(vttToPlainText(vtt)).toBe("Hello there.");
  });

  test("a NOTE block ending the file leaves only the cues before it", () => {
    const vtt = ["WEBVTT", "", "00:00:01.000 --> 00:00:02.000", "First.", "", "NOTE", "tail"].join(
      "\r\n",
    );
    expect(vttToPlainText(vtt)).toBe("First.");
  });
});

describe("mapZoomTranscriptToItem — non-object inputs", () => {
  test("control: the fixtures below map when both inputs are objects", () => {
    const row = mapZoomTranscriptToItem({
      meeting: MEETING,
      recordingFile: FILE,
      plainText: "Hello",
      syncedAt: SYNCED_AT,
    });
    expect(row?.externalId).toBe("uuid-777:tx-1");
    expect(row?.title).toBe("Transcript — Design review");
  });

  test("a meeting that is not an object maps to null", () => {
    for (const meeting of [null, "uuid-777", 777, ["uuid-777"]]) {
      expect(
        mapZoomTranscriptToItem({
          meeting,
          recordingFile: FILE,
          plainText: "Hello",
          syncedAt: SYNCED_AT,
        }),
      ).toBeNull();
    }
  });

  test("a recording file that is not an object maps to null", () => {
    for (const recordingFile of [null, "tx-1", 1, [FILE]]) {
      expect(
        mapZoomTranscriptToItem({
          meeting: MEETING,
          recordingFile,
          plainText: "Hello",
          syncedAt: SYNCED_AT,
        }),
      ).toBeNull();
    }
  });
});

describe("mapZoomTranscriptToItem — sparse recording file", () => {
  test("a file with no file_type records a null file_type and still maps", () => {
    const { file_type: _omitted, ...withoutType } = FILE;
    const row = mapZoomTranscriptToItem({
      meeting: MEETING,
      recordingFile: withoutType,
      plainText: "Hello",
      syncedAt: SYNCED_AT,
    });
    expect(row?.externalId).toBe("uuid-777:tx-1");
    expect(row?.metadata["file_type"]).toBeNull();
    expect(row?.metadata["meeting_id"]).toBe(777);
    expect(row?.modifiedAt).toBe(Date.parse("2026-06-01T10:05:00Z"));
  });
});
