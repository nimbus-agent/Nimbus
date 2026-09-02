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

describe("findCandidates — service filter", () => {
  test("restricts to the requested service", () => {
    addMedia("/m/a.mp4");
    upsertIndexedItem(db, {
      service: "onedrive",
      type: "media_av",
      externalId: "cloud-1",
      title: "cloud.mp4",
      bodyPreview: "",
      modifiedAt: 1000,
      syncedAt: 1000,
      metadata: { path: "/cloud/cloud.mp4", sizeBytes: 10 },
    });
    // "onedrive:media_av" is not in the registry, so it never resolves a modality and would be
    // filtered out downstream anyway — the point here is the SQL-level service predicate itself,
    // exercised against the registered "filesystem" service.
    const found = findCandidates(db, { limit: 10, service: "filesystem" });
    expect(found.map((c) => c.title)).toEqual(["a.mp4"]);
    expect(found.every((c) => c.service === "filesystem")).toBe(true);
  });

  test("with no service filter, candidates from every service are eligible", () => {
    addMedia("/m/a.mp4");
    const found = findCandidates(db, { limit: 10 });
    expect(found).toHaveLength(1);
  });
});

describe("findCandidates — metadata edge cases", () => {
  test("treats a NULL metadata column as an empty object, not a crash", () => {
    addMedia("/m/a.mp4");
    db.run("UPDATE item SET metadata = NULL WHERE type = 'media_av'");
    const [c] = findCandidates(db, { limit: 10 });
    if (c === undefined) throw new Error("expected a candidate");
    expect(c.sourcePath).toBeNull();
    expect(c.sourceBytes).toBeNull();
  });

  test("treats an empty-string metadata column as an empty object", () => {
    addMedia("/m/a.mp4");
    db.run("UPDATE item SET metadata = '' WHERE type = 'media_av'");
    const [c] = findCandidates(db, { limit: 10 });
    if (c === undefined) throw new Error("expected a candidate");
    expect(c.sourcePath).toBeNull();
  });

  test("falls back to an empty object when metadata is malformed JSON", () => {
    addMedia("/m/a.mp4");
    db.run("UPDATE item SET metadata = '{not json' WHERE type = 'media_av'");
    const [c] = findCandidates(db, { limit: 10 });
    if (c === undefined) throw new Error("expected a candidate");
    expect(c.sourcePath).toBeNull();
  });

  test("falls back to an empty object when metadata parses to a JSON array", () => {
    addMedia("/m/a.mp4");
    db.run("UPDATE item SET metadata = '[1,2,3]' WHERE type = 'media_av'");
    const [c] = findCandidates(db, { limit: 10 });
    if (c === undefined) throw new Error("expected a candidate");
    expect(c.sourcePath).toBeNull();
  });

  test("falls back to an empty object when metadata parses to a JSON primitive", () => {
    addMedia("/m/a.mp4");
    db.run("UPDATE item SET metadata = '5' WHERE type = 'media_av'");
    const [c] = findCandidates(db, { limit: 10 });
    if (c === undefined) throw new Error("expected a candidate");
    expect(c.sourcePath).toBeNull();
  });

  test("treats an empty-string path as absent, not as a value", () => {
    addMedia("/m/a.mp4");
    db.run("UPDATE item SET metadata = json_set(metadata, '$.path', '') WHERE type = 'media_av'");
    const [c] = findCandidates(db, { limit: 10 });
    if (c === undefined) throw new Error("expected a candidate");
    expect(c.sourcePath).toBeNull();
  });

  test("treats a missing sizeBytes key as null, not zero", () => {
    upsertIndexedItem(db, {
      service: "filesystem",
      type: "media_av",
      externalId: "/m/no-size.mp4",
      title: "no-size.mp4",
      bodyPreview: "",
      modifiedAt: 1000,
      syncedAt: 1000,
      metadata: { path: "/m/no-size.mp4" },
    });
    const [c] = findCandidates(db, { limit: 10 });
    if (c === undefined) throw new Error("expected a candidate");
    expect(c.sourceBytes).toBeNull();
  });

  test("treats a non-numeric sizeBytes as null", () => {
    addMedia("/m/a.mp4");
    db.run(
      "UPDATE item SET metadata = json_set(metadata, '$.sizeBytes', 'huge') WHERE type = 'media_av'",
    );
    const [c] = findCandidates(db, { limit: 10 });
    if (c === undefined) throw new Error("expected a candidate");
    expect(c.sourceBytes).toBeNull();
  });
});
