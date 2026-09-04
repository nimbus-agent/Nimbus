import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { MediaCandidate, UnderstandOutcome } from "./media-types.ts";
import {
  buildUnderstandingRow,
  understandingExternalId,
  writeUnderstanding,
} from "./understanding-item.ts";

const CANDIDATE: MediaCandidate = {
  itemId: "filesystem:/m/standup.mp4",
  service: "filesystem",
  externalId: "/m/standup.mp4",
  type: "media_av",
  title: "standup.mp4",
  url: "file:///m/standup.mp4",
  modality: "av",
  sourcePath: "/m/standup.mp4",
  sourceMime: "video/mp4",
  sourceBytes: 4096,
};

const OUTCOME: UnderstandOutcome = {
  text: "we shipped the gate",
  model: "whisper-base",
  isLocal: true,
};

describe("understandingExternalId", () => {
  test("is stable and carries NO version — a version would accumulate rows", () => {
    expect(understandingExternalId("filesystem:/m/a.mp4")).toBe(
      "filesystem:/m/a.mp4:understanding",
    );
    expect(understandingExternalId("filesystem:/m/a.mp4")).not.toContain("v1");
  });
});

describe("buildUnderstandingRow", () => {
  test("maps to a nimbus-service derived item of the right type", () => {
    const row = buildUnderstandingRow(CANDIDATE, OUTCOME, 999);
    expect(row.service).toBe("nimbus");
    expect(row.type).toBe("video_understanding");
  });

  test("titles with the house Transcript prefix and inherits the source url", () => {
    const row = buildUnderstandingRow(CANDIDATE, OUTCOME, 999);
    expect(row.title).toBe("Transcript — standup.mp4");
    expect(row.url).toBe("file:///m/standup.mp4");
  });

  test("an image candidate becomes a Caption", () => {
    const row = buildUnderstandingRow({ ...CANDIDATE, modality: "image" }, OUTCOME, 999);
    expect(row.type).toBe("image_understanding");
    expect(row.title).toBe("Caption — standup.mp4");
  });

  test("declares a FULL body so the prose cap applies, not the 512-char default", () => {
    const row = buildUnderstandingRow(CANDIDATE, OUTCOME, 999);
    // The rendition sentence (asserted on its own below) is appended after the model's own text —
    // this test's job is only the prose-cap-eligible PREFIX.
    expect(row.body.startsWith("we shipped the gate")).toBe(true);
  });

  test("states the rendition it was understood from, in the body AND in metadata", () => {
    const original = buildUnderstandingRow(CANDIDATE, OUTCOME, 999);
    expect(original.body).toContain("Understood from the original file.");
    expect(original.metadata["rendition"]).toBe("original");

    const downsized = buildUnderstandingRow(CANDIDATE, OUTCOME, 999, "w2048-h2048");
    expect(downsized.body).toContain("downsized rendition");
    expect(downsized.metadata["rendition"]).toBe("w2048-h2048");

    const dv = buildUnderstandingRow(CANDIDATE, OUTCOME, 999, "dv");
    expect(dv.body).toContain("provider-transcoded video rendition");
    expect(dv.metadata["rendition"]).toBe("dv");
  });

  test("carries provenance: modelDerived, model, version, isLocal, derivedFrom", () => {
    const row = buildUnderstandingRow(CANDIDATE, OUTCOME, 999);
    expect(row.metadata["modelDerived"]).toBe(true);
    expect(row.metadata["model"]).toBe("whisper-base");
    expect(row.metadata["isLocal"]).toBe(true);
    expect(row.metadata["understandingVersion"]).toBe(2);
    expect(row.metadata["derivedFrom"]).toBe("filesystem:/m/standup.mp4");
    expect(row.metadata["sourceMime"]).toBe("video/mp4");
    expect(row.metadata["sourceBytes"]).toBe(4096);
  });
});

test("buildUnderstandingRow stamps the current understandingVersion", () => {
  const row = buildUnderstandingRow(CANDIDATE, OUTCOME, 1_700_000_000_000);
  expect(row.metadata["understandingVersion"]).toBe(2);
});

test("frame sampling is recorded in metadata when the outcome carries it", () => {
  const row = buildUnderstandingRow(
    CANDIDATE,
    { ...OUTCOME, framesSampled: 8, framesCaptioned: 6 },
    1_700_000_000_000,
  );
  expect(row.metadata["framesSampled"]).toBe(8);
  expect(row.metadata["framesCaptioned"]).toBe(6);
});

test("an outcome with no frame data omits the keys rather than writing zeros", () => {
  const image: MediaCandidate = { ...CANDIDATE, modality: "image", type: "media_image" };
  const row = buildUnderstandingRow(image, OUTCOME, 1_700_000_000_000);
  expect(row.type).toBe("image_understanding");
  // A zero would be indistinguishable from a video whose every frame failed.
  expect("framesSampled" in row.metadata).toBe(false);
});

describe("writeUnderstanding", () => {
  test("re-understanding REPLACES rather than accumulating", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);

    writeUnderstanding(db, CANDIDATE, OUTCOME, 1000);
    writeUnderstanding(db, CANDIDATE, { ...OUTCOME, text: "revised transcript" }, 2000);

    const rows = db
      .query<{ body: string | null }, []>(
        "SELECT body FROM item WHERE service = 'nimbus' AND type = 'video_understanding'",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect((rows[0]?.body ?? "").startsWith("revised transcript")).toBe(true);
    db.close();
  });

  test("schedules the derived item for embedding — upsertIndexedItem does not", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    const scheduled: string[] = [];
    const id = writeUnderstanding(db, CANDIDATE, OUTCOME, 1000, (i) => scheduled.push(i));
    expect(scheduled).toEqual([id]);
    db.close();
  });
});
