import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { driftHintsFromIndex } from "./drift-hints.ts";
import { LocalIndex } from "./local-index.ts";

/**
 * Build a minimal in-memory DB that satisfies driftHintsFromIndex without the
 * full migration chain.  The item table is intentionally created with a nullable
 * modified_at so we can exercise the null/non-finite fallback branch.
 */
function makeMinimalDb(): Database {
  const db = new Database(":memory:");
  // Set user_version = 1 so the schema-check passes
  db.run("PRAGMA user_version = 1");
  db.run(`
    CREATE TABLE item (
      id           TEXT PRIMARY KEY,
      service      TEXT NOT NULL,
      type         TEXT NOT NULL,
      external_id  TEXT NOT NULL,
      title        TEXT NOT NULL,
      body_preview TEXT,
      url          TEXT,
      canonical_url TEXT,
      modified_at  INTEGER,
      author_id    TEXT,
      metadata     TEXT,
      synced_at    INTEGER NOT NULL,
      pinned       INTEGER NOT NULL DEFAULT 0
    )
  `);
  return db;
}

/** Insert the IaC heartbeat row with the given metadata JSON and modified_at. */
function insertHeartbeat(db: Database, metadataJson: string, modifiedAt: number | null): void {
  const t = Date.now();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "iac:drift_baseline",
      "iac",
      "sync_heartbeat",
      "drift_baseline",
      "h",
      "x",
      null,
      null,
      modifiedAt,
      null,
      metadataJson,
      t,
      0,
    ],
  );
}

/** Insert an AWS Lambda function item. */
function insertLambda(db: Database, id: string): void {
  const t = Date.now();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, "aws", "lambda_function", id, "f", "", null, null, t, null, "{}", t, 0],
  );
}

describe("driftHintsFromIndex", () => {
  test("mentions lambda count and IaC hint when no heartbeat", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const lines = driftHintsFromIndex(db);
    expect(lines.some((l) => l.includes("Lambda"))).toBe(true);
    expect(lines.some((l) => l.includes("heartbeat"))).toBe(true);
  });

  test("compares snapshot when heartbeat present", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const t = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["aws:fn1", "aws", "lambda_function", "fn1", "f", "", null, null, t, null, "{}", t, 0],
    );
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "iac:drift_baseline",
        "iac",
        "sync_heartbeat",
        "drift_baseline",
        "h",
        "x",
        null,
        null,
        t,
        null,
        JSON.stringify({ awsLambdaIndexedCount: 0, tick: 1 }),
        t,
        0,
      ],
    );
    const lines = driftHintsFromIndex(db);
    expect(lines.some((l) => l.includes("differs"))).toBe(true);
  });

  // Branch: readIndexedUserVersion < 1 (uninitialized DB — no schema at all)
  test("returns schema-not-initialized message when schema is absent", () => {
    const db = new Database(":memory:");
    // Do NOT call ensureSchema — user_version stays 0
    const lines = driftHintsFromIndex(db);
    expect(lines).toEqual(["Index schema not initialized."]);
  });

  // Branch: hb.modified_at is null → fallback to Date.now()
  test("uses current time when heartbeat modified_at is null", () => {
    // Use a minimal DB whose item table allows NULL in modified_at so we can
    // exercise the null-fallback branch in appendIacHeartbeatLines.
    const db = makeMinimalDb();
    const before = Date.now();
    insertHeartbeat(db, JSON.stringify({ awsLambdaIndexedCount: 0 }), null);
    const after = Date.now();
    const lines = driftHintsFromIndex(db);
    const hbLine = lines.find((l) => l.startsWith("IaC heartbeat last updated:"));
    expect(hbLine).toBeDefined();
    // The ISO string must parse to a timestamp within the test window (plus generous
    // skew for slow CI)
    const rawDate = (hbLine as string).replace("IaC heartbeat last updated: ", "");
    const parsed = new Date(rawDate).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after + 5000);
  });

  // Branch: snap matches lambda count — no "differs" note
  test("no 'differs' note when snapshot matches current lambda count", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    insertLambda(db, "aws:fn1");
    const t = Date.now();
    // awsLambdaIndexedCount = 1 matches the 1 lambda we inserted
    insertHeartbeat(db, JSON.stringify({ awsLambdaIndexedCount: 1 }), t);
    const lines = driftHintsFromIndex(db);
    expect(lines.some((l) => l.includes("indexed Lambda count was: 1"))).toBe(true);
    expect(lines.some((l) => l.includes("differs"))).toBe(false);
  });

  // One row per guard on the way to the lambda-snapshot block. In every case the heartbeat
  // timestamp line still renders — only the snapshot line is suppressed.
  test.each([
    ["metadata is JSON null (skips the inner snap block)", "null"],
    ["metadata is a JSON array (!Array.isArray guard fires)", "[1, 2, 3]"],
    ["awsLambdaIndexedCount is a string (typeof-false arm)", '{"awsLambdaIndexedCount":"many"}'],
    // JSON.parse("1e309") yields Infinity — a value that passes `typeof === "number"` but fails
    // `Number.isFinite`, so this row is what covers the isFinite-false arm specifically.
    ["awsLambdaIndexedCount is non-finite (isFinite-false arm)", '{"awsLambdaIndexedCount":1e309}'],
  ])("skips the lambda snapshot lines when %s", (_label, metadata) => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    insertHeartbeat(db, metadata, Date.now());
    const lines = driftHintsFromIndex(db);
    expect(lines.some((l) => l.startsWith("IaC heartbeat last updated:"))).toBe(true);
    expect(lines.some((l) => l.includes("indexed Lambda count was"))).toBe(false);
  });

  // Branch: catch block — invalid JSON in metadata
  test("emits parse-error line when heartbeat metadata is invalid JSON", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const t = Date.now();
    insertHeartbeat(db, "{ not valid json }", t);
    const lines = driftHintsFromIndex(db);
    expect(lines.some((l) => l.includes("could not be parsed"))).toBe(true);
  });

  // Branch: heartbeat with a finite modified_at — uses the stored timestamp
  test("uses heartbeat modified_at when it is a valid finite number", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const knownMs = new Date("2025-01-15T12:00:00.000Z").getTime();
    insertHeartbeat(db, JSON.stringify({}), knownMs);
    const lines = driftHintsFromIndex(db);
    const hbLine = lines.find((l) => l.startsWith("IaC heartbeat last updated:"));
    expect(hbLine).toBeDefined();
    expect(hbLine).toContain("2025-01-15T12:00:00.000Z");
  });

  // Ensure the trailing full-drift advisory line always appears
  test("always includes the full-drift advisory line", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const lines = driftHintsFromIndex(db);
    expect(lines.some((l) => l.includes("Full drift"))).toBe(true);
  });
});
