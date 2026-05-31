import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { verifyIndex } from "./verify.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed by a test */
  }
});

describe("verifyIndex — skipped-branch coverage", () => {
  test("fts5_consistency reports skipped when item_fts is absent", () => {
    const fresh = new Database(":memory:");
    const result = verifyIndex(fresh, 0);
    const fts = result.findings.find((f) => f.label === "fts5_consistency");
    expect(fts?.status).toBe("ok");
    expect(fts?.detail).toContain("not present, skipped");
    fresh.close();
  });

  test("vec_rowid_mismatch reports skipped when vec tables are absent", () => {
    const fresh = new Database(":memory:");
    const result = verifyIndex(fresh, 0);
    const vec = result.findings.find((f) => f.label === "vec_rowid_mismatch");
    expect(vec?.status).toBe("ok");
    expect(vec?.detail).toContain("not present, skipped");
    fresh.close();
  });

  test("orphaned_sync_tokens reports skipped when sync_state is absent", () => {
    const fresh = new Database(":memory:");
    const result = verifyIndex(fresh, 0);
    const orph = result.findings.find((f) => f.label === "orphaned_sync_tokens");
    expect(orph?.status).toBe("ok");
    expect(orph?.detail).toContain("not present, skipped");
    fresh.close();
  });
});

describe("verifyIndex — schema_version branches", () => {
  test("fresh DB without _schema_migrations + expected=0 reports ok", () => {
    const fresh = new Database(":memory:");
    const result = verifyIndex(fresh, 0);
    const sv = result.findings.find((f) => f.label === "schema_version");
    expect(sv?.status).toBe("ok");
    fresh.close();
  });

  test("missing _schema_migrations + expected>0 reports fail", () => {
    const fresh = new Database(":memory:");
    const result = verifyIndex(fresh, 7);
    const sv = result.findings.find((f) => f.label === "schema_version");
    expect(sv?.status).toBe("fail");
    expect(sv?.detail).toContain("_schema_migrations table missing");
    fresh.close();
  });

  test("applied/user_version mismatch reports detailed gap", () => {
    const result = verifyIndex(db, LocalIndex.SCHEMA_VERSION + 5);
    const sv = result.findings.find((f) => f.label === "schema_version");
    expect(sv?.status).toBe("fail");
    expect(sv?.detail).toContain("expected=");
    expect(sv?.detail).toContain("applied=");
  });
});

describe("verifyIndex — vec_rowid_mismatch true-mismatch path", () => {
  test("more embedding_chunk rows than vec rows produces FAIL with negative diff", () => {
    const hasVec = db
      .query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec_items_384'`)
      .get();
    if (hasVec === null) {
      return;
    }

    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('vec:1', 'vec', 'note', '1', 'x', 1, 1)`,
    );
    db.run(
      `INSERT INTO embedding_chunk
       (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES ('vec:1', 0, 'hello', 9999999, 'test', 384, 1)`,
    );

    const result = verifyIndex(db, LocalIndex.SCHEMA_VERSION);
    const vec = result.findings.find((f) => f.label === "vec_rowid_mismatch");
    expect(vec?.status).toBe("fail");
    expect(vec?.detail).toMatch(/vec rows.*embedding_chunk rows/);
  });
});

describe("verifyIndex — foreign_key_integrity violation path", () => {
  test("orphan child row in a child→parent FK is reported", () => {
    db.run("PRAGMA foreign_keys = OFF");
    db.run(`CREATE TABLE IF NOT EXISTS _fkparent (id TEXT PRIMARY KEY)`);
    db.run(`
      CREATE TABLE IF NOT EXISTS _fkchild (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES _fkparent(id)
      )
    `);
    db.run(`INSERT INTO _fkchild (id, parent_id) VALUES ('c1', 'ghost')`);

    const result = verifyIndex(db, LocalIndex.SCHEMA_VERSION);
    const fk = result.findings.find((f) => f.label === "foreign_key_integrity");
    expect(fk?.status).toBe("fail");
    expect(fk?.detail).toContain("violation");
    expect(fk?.detail).toContain("_fkchild");
  });
});

describe("verifyIndex — catch-block coverage via broken queries", () => {
  test("orphaned_sync_tokens catch block fires when sync_state is altered to omit connector_id", () => {
    const fresh = new Database(":memory:");
    LocalIndex.ensureSchema(fresh);
    fresh.run("DROP TABLE sync_state");
    fresh.run("CREATE TABLE sync_state (other_col TEXT PRIMARY KEY)");
    const result = verifyIndex(fresh, LocalIndex.SCHEMA_VERSION);
    const orph = result.findings.find((f) => f.label === "orphaned_sync_tokens");
    expect(orph?.status).toBe("fail");
    expect(orph?.detail).toBeDefined();
    fresh.close();
  });

  test("fts5_consistency catch block fires when the FTS5 command targets a non-fts5 table", () => {
    const fresh = new Database(":memory:");
    LocalIndex.ensureSchema(fresh);
    fresh.run("DROP TABLE IF EXISTS item_fts");
    fresh.run("CREATE TABLE item_fts (other TEXT)");
    const result = verifyIndex(fresh, LocalIndex.SCHEMA_VERSION);
    const fts = result.findings.find((f) => f.label === "fts5_consistency");
    expect(fts?.status).toBe("fail");
    expect(fts?.detail).toBeDefined();
    fresh.close();
  });
});
