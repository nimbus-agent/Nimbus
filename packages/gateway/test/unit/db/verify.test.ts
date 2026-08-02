import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { formatVerifyResult, verifyIndex } from "../../../src/db/verify.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

describe("verifyIndex", () => {
  test("clean database returns all ok findings", () => {
    const db = makeDb();
    const result = verifyIndex(db, LocalIndex.SCHEMA_VERSION);
    expect(result.clean).toBe(true);
    for (const f of result.findings) {
      expect(f.status).toBe("ok");
    }
    db.close();
  });

  test("returns 6 findings", () => {
    const db = makeDb();
    const result = verifyIndex(db, LocalIndex.SCHEMA_VERSION);
    expect(result.findings).toHaveLength(6);
    db.close();
  });

  test("finding labels are in expected order", () => {
    const db = makeDb();
    const { findings } = verifyIndex(db, LocalIndex.SCHEMA_VERSION);
    const labels = findings.map((f) => f.label);
    expect(labels).toEqual([
      "integrity_check",
      "fts5_consistency",
      "vec_rowid_mismatch",
      "orphaned_sync_tokens",
      "schema_version",
      "foreign_key_integrity",
    ]);
    db.close();
  });

  test("detects wrong expected schema version", () => {
    const db = makeDb();
    const result = verifyIndex(db, LocalIndex.SCHEMA_VERSION + 1);
    const sv = result.findings.find((f) => f.label === "schema_version");
    expect(sv?.status).toBe("fail");
    expect(result.clean).toBe(false);
    db.close();
  });

  test("detects FTS5 inconsistency after manual shadow-table corruption", () => {
    const db = makeDb();

    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('test:1', 'test', 'file', '1', 'Hello World', 1000, 1000)`,
    );

    db.run(`DELETE FROM item WHERE id = 'test:1'`);

    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('test:2', 'test', 'file', '2', 'Orphan Item', 2000, 2000)`,
    );
    db.run(
      `INSERT INTO item_fts(item_fts, rowid, title, body)
       VALUES('delete', (SELECT rowid FROM item WHERE id = 'test:2'), 'Orphan Item', NULL)`,
    );

    const result = verifyIndex(db, LocalIndex.SCHEMA_VERSION);
    const fts = result.findings.find((f) => f.label === "fts5_consistency");
    expect(fts).toBeDefined();
    db.close();
  });

  test("detects orphaned sync tokens", () => {
    const db = makeDb();

    db.run(
      `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token)
       VALUES ('ghost_connector', ${String(Date.now())}, 'tok')`,
    );

    const result = verifyIndex(db, LocalIndex.SCHEMA_VERSION);
    const finding = result.findings.find((f) => f.label === "orphaned_sync_tokens");
    expect(finding?.status).toBe("fail");
    expect(finding?.detail).toContain("ghost_connector");
    expect(result.clean).toBe(false);
    db.close();
  });
});

describe("formatVerifyResult", () => {
  test("clean result produces [ok] lines and exitCode 0", () => {
    const db = makeDb();
    const result = verifyIndex(db, LocalIndex.SCHEMA_VERSION);
    const { output, exitCode } = formatVerifyResult(result);
    expect(exitCode).toBe(0);
    expect(output).toContain("[ok]");
    expect(output).not.toContain("[FAIL]");
    db.close();
  });

  test("failing result produces [FAIL] lines and exitCode 1", () => {
    const db = makeDb();
    const result = verifyIndex(db, LocalIndex.SCHEMA_VERSION + 99);
    const { output, exitCode } = formatVerifyResult(result);
    expect(exitCode).toBe(1);
    expect(output).toContain("[FAIL]");
    db.close();
  });
});
