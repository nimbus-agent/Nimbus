import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { findCandidates } from "./media-discovery.ts";
import { writeUnderstanding } from "./understanding-item.ts";

let db: Database;

function addMedia(path: string, type = "media_av", modifiedAt = 1000): void {
  upsertIndexedItem(db, {
    service: "filesystem",
    type,
    externalId: path,
    title: path.split("/").pop() ?? path,
    bodyPreview: "",
    modifiedAt,
    syncedAt: modifiedAt,
    metadata: { path, sizeBytes: 10, mediaKind: type === "media_av" ? "av" : "image" },
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});

describe("findCandidates", () => {
  test("returns media items that have no understanding yet", () => {
    addMedia("/m/a.mp4");
    addMedia("/m/b.mp4");
    expect(findCandidates(db, { limit: 10 })).toHaveLength(2);
  });

  test("excludes an item already understood at the CURRENT version", () => {
    addMedia("/m/a.mp4");
    const [c] = findCandidates(db, { limit: 10 });
    if (c === undefined) throw new Error("expected a candidate");
    writeUnderstanding(db, c, { text: "t", model: "m", isLocal: true }, 2000);
    expect(findCandidates(db, { limit: 10 })).toHaveLength(0);
  });

  test("RE-INCLUDES an item understood at an older version", () => {
    addMedia("/m/a.mp4");
    const [c] = findCandidates(db, { limit: 10 });
    if (c === undefined) throw new Error("expected a candidate");
    writeUnderstanding(db, c, { text: "t", model: "m", isLocal: true }, 2000);
    db.run(
      "UPDATE item SET metadata = json_set(metadata, '$.understandingVersion', 0) WHERE type = 'video_understanding'",
    );
    expect(findCandidates(db, { limit: 10 })).toHaveLength(1);
  });

  test("ignores non-media item types", () => {
    upsertIndexedItem(db, {
      service: "slack",
      type: "message",
      externalId: "m1",
      title: "hi",
      bodyPreview: "hi",
      modifiedAt: 1,
      syncedAt: 1,
    });
    expect(findCandidates(db, { limit: 10 })).toHaveLength(0);
  });

  test("resolves modality and carries the path from metadata", () => {
    addMedia("/m/a.mp4");
    addMedia("/m/b.png", "media_image");
    const byTitle = new Map(findCandidates(db, { limit: 10 }).map((c) => [c.title, c]));
    expect(byTitle.get("a.mp4")?.modality).toBe("av");
    expect(byTitle.get("b.png")?.modality).toBe("image");
    expect(byTitle.get("a.mp4")?.sourcePath).toBe("/m/a.mp4");
    expect(byTitle.get("a.mp4")?.sourceBytes).toBe(10);
  });

  test("honours the limit", () => {
    addMedia("/m/a.mp4");
    addMedia("/m/b.mp4");
    addMedia("/m/c.mp4");
    expect(findCandidates(db, { limit: 2 })).toHaveLength(2);
  });

  test("filters by modality", () => {
    addMedia("/m/a.mp4");
    addMedia("/m/b.png", "media_image");
    expect(findCandidates(db, { limit: 10, modality: "image" })).toHaveLength(1);
  });

  test("filters by sinceMs on modified_at", () => {
    addMedia("/m/old.mp4", "media_av", 1000);
    addMedia("/m/new.mp4", "media_av", 5000);
    const found = findCandidates(db, { limit: 10, sinceMs: 3000 });
    expect(found.map((c) => c.title)).toEqual(["new.mp4"]);
  });

  test("resumes after a cursor item id", () => {
    addMedia("/m/a.mp4");
    addMedia("/m/b.mp4");
    const all = findCandidates(db, { limit: 10 });
    const first = all[0];
    if (first === undefined) throw new Error("expected candidates");
    const rest = findCandidates(db, { limit: 10, afterItemId: first.itemId });
    expect(rest.some((c) => c.itemId === first.itemId)).toBe(false);
  });

  test("modality filter does not under-fill the page when other-modality items sort first", () => {
    // Images sort before the video by id, so a SQL LIMIT applied before a JS modality filter
    // would consume the whole page on images and return nothing.
    addMedia("/m/a.png", "media_image");
    addMedia("/m/b.png", "media_image");
    addMedia("/m/c.mp4", "media_av");
    const found = findCandidates(db, { limit: 2, modality: "av" });
    expect(found.map((c) => c.title)).toEqual(["c.mp4"]);
  });
});
