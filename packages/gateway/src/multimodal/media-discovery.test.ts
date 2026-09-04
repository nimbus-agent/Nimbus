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

function freshIndexDb(): Database {
  const fresh = new Database(":memory:");
  runIndexedSchemaMigrations(fresh, CURRENT_SCHEMA_VERSION);
  return fresh;
}

/**
 * Cloud-item fixture: `id` is the full `service:externalId` item id (matching how a real synced
 * row reads), and the external id is derived from it rather than duplicated by the caller.
 */
function insertItem(
  target: Database,
  row: {
    readonly id: string;
    readonly service: string;
    readonly type: string;
    readonly metadata?: Record<string, unknown>;
  },
): void {
  const prefix = `${row.service}:`;
  const externalId = row.id.startsWith(prefix) ? row.id.slice(prefix.length) : row.id;
  upsertIndexedItem(target, {
    service: row.service,
    type: row.type,
    externalId,
    title: row.id,
    bodyPreview: "",
    modifiedAt: 1000,
    syncedAt: 1000,
    metadata: row.metadata ?? {},
  });
}

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

  // fix round 1: pins the v1 -> v2 boundary specifically, not just "some older version". A row
  // written by the PREVIOUS release carries `understandingVersion: 1` (PR 1's own value, never
  // 0) -- the v0 test above proves the mechanism re-offers SOME older version, but a bound
  // hardcoded to the literal `1` in the SQL would still pass that test while silently never
  // re-offering a real v1 row again.
  test("RE-INCLUDES an item understood at version 1 — the value a PR 1 row actually carries", () => {
    addMedia("/m/a.mp4");
    const [c] = findCandidates(db, { limit: 10 });
    if (c === undefined) throw new Error("expected a candidate");
    writeUnderstanding(db, c, { text: "t", model: "m", isLocal: true }, 2000);
    db.run(
      "UPDATE item SET metadata = json_set(metadata, '$.understandingVersion', 1) WHERE type = 'video_understanding'",
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

  // Every shape a `metadata` column can take that is NOT an object carrying a usable `path`. The
  // required outcome is one and the same — the candidate still exists, its `sourcePath` is null —
  // so these are one table rather than five copies of one body. Each row is still its own `test`,
  // so a regression names the shape that broke rather than "metadata edge cases".
  const NO_USABLE_PATH_CASES: ReadonlyArray<{ what: string; sql: string }> = [
    { what: "an empty-string metadata column", sql: "''" },
    { what: "malformed JSON", sql: "'{not json'" },
    { what: "a JSON array", sql: "'[1,2,3]'" },
    { what: "a JSON primitive", sql: "'5'" },
    { what: "an empty-string path", sql: "json_set(metadata, '$.path', '')" },
  ];

  for (const { what, sql } of NO_USABLE_PATH_CASES) {
    test(`reports a null sourcePath for ${what}`, () => {
      addMedia("/m/a.mp4");
      db.run(`UPDATE item SET metadata = ${sql} WHERE type = 'media_av'`);
      const [c] = findCandidates(db, { limit: 10 });
      if (c === undefined) throw new Error("expected a candidate");
      expect(c.sourcePath).toBeNull();
    });
  }

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

describe("findCandidates — mime-keyed cloud services (PR 3)", () => {
  test("pages past non-media files without clearing the cursor (the starvation bug)", () => {
    const cloud = freshIndexDb();
    // 100 Drive files; only #70-#75 are media. A JS-side mime filter would return 0 candidates
    // for page 1, and the pass would treat that as end-of-queue.
    for (let i = 0; i < 100; i += 1) {
      const media = i >= 70 && i < 76;
      insertItem(cloud, {
        id: `google_drive:f${String(i).padStart(3, "0")}`,
        service: "google_drive",
        type: "file",
        metadata: { mimeType: media ? "video/mp4" : "application/pdf", size: "1024" },
      });
    }

    const page1 = findCandidates(cloud, { limit: 50 });
    // The SQL predicate excludes the PDFs, so page 1 is the SIX media items, not zero.
    expect(page1).toHaveLength(6);
    expect(page1.every((c) => c.modality === "av")).toBe(true);
  });

  test("--modality image excludes a video sharing the same item type", () => {
    const cloud = freshIndexDb();
    insertItem(cloud, {
      id: "google_photos:p1",
      service: "google_photos",
      type: "photo",
      metadata: { mimeType: "image/jpeg" },
    });
    insertItem(cloud, {
      id: "google_photos:p2",
      service: "google_photos",
      type: "photo",
      metadata: { mimeType: "video/mp4" },
    });

    expect(findCandidates(cloud, { limit: 10, modality: "image" }).map((c) => c.itemId)).toEqual([
      "google_photos:p1",
    ]);
    expect(findCandidates(cloud, { limit: 10, modality: "av" }).map((c) => c.itemId)).toEqual([
      "google_photos:p2",
    ]);
  });

  test("a mime-keyed row with NO mimeType is excluded by SQL, not fetched and dropped", () => {
    const cloud = freshIndexDb();
    insertItem(cloud, {
      id: "google_drive:f1",
      service: "google_drive",
      type: "file",
      metadata: {},
    });
    expect(findCandidates(cloud, { limit: 10 })).toHaveLength(0);
  });

  test("a NON-mime-keyed service sharing the type name 'file' is never selected", () => {
    // figma-file-mapping.ts:60 also emits type "file". If arm 1 matched it, the JS loop would drop
    // it for having no modality and the page would under-fill — the same starvation bug, via a
    // different service.
    const cloud = freshIndexDb();
    insertItem(cloud, {
      id: "figma:f1",
      service: "figma",
      type: "file",
      metadata: { mimeType: "image/png" },
    });
    expect(findCandidates(cloud, { limit: 10 })).toHaveLength(0);
  });

  test("a Drive FOLDER is excluded — its mime fails every pattern", () => {
    const cloud = freshIndexDb();
    insertItem(cloud, {
      id: "google_drive:d1",
      service: "google_drive",
      type: "folder",
      metadata: { mimeType: "application/vnd.google-apps.folder" },
    });
    expect(findCandidates(cloud, { limit: 10 })).toHaveLength(0);
  });

  test("carries the provider's own externalId from the column, not derived from the item id", () => {
    const cloud = freshIndexDb();
    insertItem(cloud, {
      id: "google_drive:file123",
      service: "google_drive",
      type: "file",
      metadata: { mimeType: "video/mp4" },
    });
    const [c] = findCandidates(cloud, { limit: 10 });
    if (c === undefined) throw new Error("expected a candidate");
    expect(c.externalId).toBe("file123");
  });
});
