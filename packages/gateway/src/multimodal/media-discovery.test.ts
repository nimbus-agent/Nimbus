import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { buildModalityPredicate, findCandidates } from "./media-discovery.ts";
import { createGrant, revokeGrant } from "./media-grant-store.ts";
import {
  MIME_KEYED_SERVICES,
  MIME_PATTERNS_FOR_MODALITY,
  mediaItemTypePairsForModality,
  mimeModality,
} from "./media-source-registry.ts";
import { UNDERSTANDING_VERSION } from "./media-types.ts";
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
    writeUnderstanding(
      db,
      c,
      { text: "t", model: "m", isLocal: true },
      2000,
      undefined,
      "original",
    );
    expect(findCandidates(db, { limit: 10 })).toHaveLength(0);
  });

  test("RE-INCLUDES an item understood at an older version", () => {
    addMedia("/m/a.mp4");
    const [c] = findCandidates(db, { limit: 10 });
    if (c === undefined) throw new Error("expected a candidate");
    writeUnderstanding(
      db,
      c,
      { text: "t", model: "m", isLocal: true },
      2000,
      undefined,
      "original",
    );
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
    writeUnderstanding(
      db,
      c,
      { text: "t", model: "m", isLocal: true },
      2000,
      undefined,
      "original",
    );
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

  // This is a regression guard on the RULING (mediaItemTypePairsForModality/ITEM_TYPE_MODALITY
  // holds ONLY filesystem's media_av/media_image, never a cloud pair) rather than coverage for
  // arm 1's pair-vs-type shape: it goes red the moment someone adds `figma:file` — or any
  // `file`/`photo` pair — to ITEM_TYPE_MODALITY, but arm 1 is already pair-keyed
  // (`src.service = ? AND src.type = ?`), so a same-named-type collision on a DIFFERENT service
  // (e.g. a hypothetical `other_service:file` pair) cannot make this specific figma row match —
  // that shape is covered separately below ("arm 1 matches by the exact pair, not by type alone").
  test("a NON-mime-keyed service sharing the type name 'file' is never selected", () => {
    // figma-file-mapping.ts:60 also emits type "file". If ITEM_TYPE_MODALITY ever grew a
    // `<service>:file` pair for a mime-keyed service, arm 1 would still be scoped to that exact
    // (service, type) pair and would not admit this figma row — but if someone instead adds a
    // bare `file`/`photo` type to the registry expecting "any file-typed item", this guards that.
    const cloud = freshIndexDb();
    insertItem(cloud, {
      id: "figma:f1",
      service: "figma",
      type: "file",
      metadata: { mimeType: "image/png" },
    });
    expect(findCandidates(cloud, { limit: 10 })).toHaveLength(0);
  });

  // Important 2: arm 1 must match by the EXACT (service, type) pair, not by type alone. Uses the
  // one real ITEM_TYPE_MODALITY pair (`filesystem:media_av`) as the collision partner. A
  // single-row DB can't discriminate a type-only arm 1 from a pair-keyed one — the JS loop drops
  // an unregistered pair either way when nothing else competes for the LIMIT — so this mirrors
  // the starvation shape: 5 unregistered `another_service:media_av` rows sort BEFORE the one real
  // `filesystem:media_av` row by id. Under a bare `src.type IN (...)`, SQL admits all 6, LIMIT 5
  // keeps only the 5 impostors, and the JS loop drops every one of them — the real candidate never
  // reaches the page. Pair-keyed, SQL admits only the 1 real row.
  test("arm 1 matches by the exact (service, type) pair, not by type alone — under-fill via LIMIT", () => {
    const cloud = freshIndexDb();
    for (let i = 0; i < 5; i += 1) {
      insertItem(cloud, {
        id: `another_service:a${i}`,
        service: "another_service",
        type: "media_av",
        metadata: {},
      });
    }
    insertItem(cloud, {
      id: "filesystem:real.mp4",
      service: "filesystem",
      type: "media_av",
      metadata: { path: "/m/real.mp4" },
    });
    expect(findCandidates(cloud, { limit: 5 }).map((c) => c.itemId)).toEqual([
      "filesystem:real.mp4",
    ]);
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

  // Discriminates the forbidden `itemId.slice(service.length + 1)` derivation from reading the
  // `external_id` COLUMN. `itemPrimaryKey` is idempotent: when the caller's externalId ALREADY
  // starts with "service:", it is stored UNCHANGED — so here `id` and `external_id` are the SAME
  // string, "google_drive:abc". The forbidden slice would strip the leading "google_drive:" and
  // wrongly produce "abc"; the fixture in the test above (`file123`) cannot catch this, because
  // slice and column agree on a key that never round-trips.
  test("carries externalId unchanged when it already starts with the service prefix (idempotent key round-trip)", () => {
    const cloud = freshIndexDb();
    upsertIndexedItem(cloud, {
      service: "google_drive",
      type: "file",
      externalId: "google_drive:abc",
      title: "abc",
      bodyPreview: "",
      modifiedAt: 1000,
      syncedAt: 1000,
      metadata: { mimeType: "video/mp4" },
    });
    const [c] = findCandidates(cloud, { limit: 10 });
    if (c === undefined) throw new Error("expected a candidate");
    expect(c.externalId).toBe("google_drive:abc");
  });
});

describe("buildModalityPredicate — Important 1: the empty-arm guard", () => {
  test("an empty pairs list does not suppress arm 2 — the clause still admits via mime alone", () => {
    const predicate = buildModalityPredicate([], ["google_drive"], ["image/%"]);
    expect(predicate).not.toBeNull();
    expect(predicate?.clause).not.toContain("src.type =");
    expect(predicate?.clause).toContain("json_extract");
    expect(predicate?.params).toEqual(["google_drive", "image/%"]);
  });

  test("a non-empty pairs list with no mime services omits arm 2 entirely (no empty IN/OR)", () => {
    const predicate = buildModalityPredicate([{ service: "filesystem", type: "media_av" }], [], []);
    expect(predicate).not.toBeNull();
    expect(predicate?.clause).not.toContain("json_extract");
    expect(predicate?.params).toEqual(["filesystem", "media_av"]);
  });

  // Important A (fix round 3): non-empty mimeServices with an EMPTY mimePatterns must also omit
  // arm 2 — the old guard was `mimeServices.length > 0` alone, which would have emitted
  // `... AND ())`, a SQLite syntax error, the exact failure this function's contract promises
  // never happens. Not reachable through findCandidates today (every real MediaModality has a
  // non-empty pattern list), but buildModalityPredicate is exported and independently callable.
  test("non-empty mime services with an EMPTY pattern list omits arm 2 too (no `AND ()`)", () => {
    const predicate = buildModalityPredicate(
      [{ service: "filesystem", type: "media_av" }],
      ["google_drive"],
      [],
    );
    expect(predicate).not.toBeNull();
    expect(predicate?.clause).not.toContain("AND ()");
    expect(predicate?.clause).not.toContain("json_extract");
    expect(predicate?.params).toEqual(["filesystem", "media_av"]);
  });

  test("empty pairs AND an empty pattern list return null even with non-empty mime services", () => {
    expect(buildModalityPredicate([], ["google_drive"], [])).toBeNull();
  });

  test("returns null only when BOTH arms are empty", () => {
    expect(buildModalityPredicate([], [], [])).toBeNull();
  });

  // The literal behavioural claim: with a REAL empty pairs array (standing in for a future
  // registry state — today's ITEM_TYPE_MODALITY always covers both modalities, so this cannot be
  // driven through findCandidates' own registry lookup), the built predicate still returns real
  // cloud candidates from a real database when run as an actual SQL WHERE clause.
  test("with an empty type list for a modality, cloud candidates for that modality are still returned", () => {
    const cloud = freshIndexDb();
    insertItem(cloud, {
      id: "google_drive:img1",
      service: "google_drive",
      type: "file",
      metadata: { mimeType: "image/jpeg" },
    });
    insertItem(cloud, {
      id: "google_drive:doc1",
      service: "google_drive",
      type: "file",
      metadata: { mimeType: "application/pdf" },
    });

    const predicate = buildModalityPredicate(
      [],
      ["google_drive", "google_photos", "onedrive"],
      ["image/%"],
    );
    if (predicate === null) throw new Error("expected a predicate");

    const rows = cloud
      .query<{ id: string }, (string | number)[]>(
        `SELECT src.id AS id FROM item AS src WHERE ${predicate.clause}`,
      )
      .all(...predicate.params);
    expect(rows.map((r) => r.id)).toEqual(["google_drive:img1"]);
  });
});

describe("SQL/JS mime agreement — Important 3", () => {
  // MIME_PATTERNS_FOR_MODALITY (SQL) and mimeModality (JS) encode the same rule twice; nothing
  // pins them together structurally.
  //
  // Round-3 correction: the first version of this test drove `findCandidates`, whose output is
  // SQL admission AND JS admission — so the assertion `findCandidates(...).length === (JS
  // admitted ? 1 : 0)` reduces to `(SQL ∧ JS) == JS`, which only pins `JS ⟹ SQL`. It could not
  // catch SQL being WIDER than JS (e.g. a pattern like `application/%` added to
  // MIME_PATTERNS_FOR_MODALITY without a matching `mimeModality` branch): SQL would admit the row,
  // the JS loop in `findCandidates` would then drop it, `length` would still be 0, and the test
  // would pass — silently missing the exact page-under-fill direction this task exists to
  // prevent. Rewritten to observe SQL admission ALONE, the same technique the Important-1 tests
  // use: run `buildModalityPredicate`'s clause as a raw SELECT against a real in-memory DB row,
  // never through `findCandidates` and never by re-implementing the LIKE logic in JS.
  const MIME_FIXTURES: readonly string[] = [
    "image/jpeg",
    "IMAGE/PNG",
    "video/mp4",
    "audio/mpeg",
    "application/pdf",
    "application/vnd.google-apps.folder",
    "",
    "image/",
  ];

  for (const mime of MIME_FIXTURES) {
    test(`raw SQL admission for mime ${JSON.stringify(mime)} agrees with mimeModality`, () => {
      const cloud = freshIndexDb();
      insertItem(cloud, {
        id: "google_drive:x1",
        service: "google_drive",
        type: "file",
        metadata: { mimeType: mime },
      });

      // Mirrors exactly how findCandidates builds the predicate for an unset `modality` — every
      // pattern from every modality is in play, matching what a real unfiltered discovery page
      // would admit.
      const predicate = buildModalityPredicate(
        mediaItemTypePairsForModality(undefined),
        [...MIME_KEYED_SERVICES],
        [...MIME_PATTERNS_FOR_MODALITY.image, ...MIME_PATTERNS_FOR_MODALITY.av],
      );
      if (predicate === null) throw new Error("expected a predicate");

      const rows = cloud
        .query<{ id: string }, (string | number)[]>(
          `SELECT src.id AS id FROM item AS src WHERE ${predicate.clause}`,
        )
        .all(...predicate.params);

      const expectAdmitted = mimeModality(mime) !== undefined;
      expect(rows).toHaveLength(expectAdmitted ? 1 : 0);
    });
  }
});

/** Seeds a Drive image plus its derived understanding row at the CURRENT version. */
function seedUnderstoodImage(db: Database, opts: { readonly isLocal: boolean }): string {
  upsertIndexedItem(db, {
    service: "google_drive",
    type: "file",
    externalId: "img-1",
    title: "img-1",
    bodyPreview: "",
    modifiedAt: 1000,
    syncedAt: 1000,
    metadata: { mimeType: "image/png" },
  });
  const itemId = db
    .query<{ id: string }, []>("SELECT id FROM item WHERE external_id = 'img-1'")
    .get()?.id as string;
  upsertIndexedItem(db, {
    service: "nimbus",
    type: "image_understanding",
    externalId: `${itemId}:understanding`,
    title: "Caption — img-1",
    bodyPreview: "a caption",
    modifiedAt: 1000,
    syncedAt: 1000,
    metadata: {
      derivedFrom: itemId,
      understandingVersion: UNDERSTANDING_VERSION,
      isLocal: opts.isLocal,
      model: opts.isLocal ? "qwen2.5vl:7b" : "gpt-5",
    },
  });
  return itemId;
}

describe("grant-driven re-offer (§ 19.1)", () => {
  /** The defect this whole task exists to close. */
  test("re-offers a LOCALLY-understood item once an active grant names the configured vendor", () => {
    const itemId = seedUnderstoodImage(db, { isLocal: true });
    expect(findCandidates(db, { limit: 10 })).toHaveLength(0);

    createGrant(db, { itemId, modality: "image", modelVendor: "openai", nowMs: 1000 });
    expect(findCandidates(db, { limit: 10, remoteVendor: "openai" }).map((c) => c.itemId)).toEqual([
      itemId,
    ]);
  });

  /**
   * The bound vendor is the CONFIGURED one. With `remote_vlm` unset the clause is omitted
   * entirely, so an unconfigured install re-offers ZERO items and the query costs what it costs
   * today. A grant for a vendor the user no longer runs is inert, not a standing re-offer.
   */
  test("re-offers NOTHING when no remote vendor is configured", () => {
    const itemId = seedUnderstoodImage(db, { isLocal: true });
    createGrant(db, { itemId, modality: "image", modelVendor: "openai", nowMs: 1000 });
    expect(findCandidates(db, { limit: 10 })).toHaveLength(0);
  });

  test("a grant for a DIFFERENT vendor than the configured one does not re-offer", () => {
    const itemId = seedUnderstoodImage(db, { isLocal: true });
    createGrant(db, { itemId, modality: "image", modelVendor: "anthropic", nowMs: 1000 });
    expect(findCandidates(db, { limit: 10, remoteVendor: "openai" })).toHaveLength(0);
  });

  /**
   * Without the isLocal clause an item understood REMOTELY is re-offered on every subsequent pass
   * and re-sent to the vendor each time — a consent surface that bills the user forever off one
   * approval. This clause is what makes the upgrade one-directional.
   */
  test("does NOT re-offer an item already understood REMOTELY", () => {
    const itemId = seedUnderstoodImage(db, { isLocal: false });
    createGrant(db, { itemId, modality: "image", modelVendor: "openai", nowMs: 1000 });
    expect(findCandidates(db, { limit: 10, remoteVendor: "openai" })).toHaveLength(0);
  });

  test("a REVOKED grant does not re-offer", () => {
    const itemId = seedUnderstoodImage(db, { isLocal: true });
    createGrant(db, { itemId, modality: "image", modelVendor: "openai", nowMs: 1000 });
    revokeGrant(db, { itemId, nowMs: 2000 });
    expect(findCandidates(db, { limit: 10, remoteVendor: "openai" })).toHaveLength(0);
  });

  /**
   * `json_extract` RAISES on malformed JSON in SQLite, and the existing version predicate already
   * guards with COALESCE. A derived row whose metadata does not round-trip must not blow up the
   * whole discovery query.
   */
  test("survives a derived row with unparseable metadata", () => {
    const itemId = seedUnderstoodImage(db, { isLocal: true });
    db.run("UPDATE item SET metadata = '{not json' WHERE service='nimbus'");
    createGrant(db, { itemId, modality: "image", modelVendor: "openai", nowMs: 1000 });
    expect(() => findCandidates(db, { limit: 10, remoteVendor: "openai" })).not.toThrow();
  });
});
