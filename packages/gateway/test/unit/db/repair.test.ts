import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { formatRepairReport, repairIndex } from "../../../src/db/repair.ts";
import { verifyIndex } from "../../../src/db/verify.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../../../src/index/sqlite-vec-load.ts";

function vecAvailable(): boolean {
  const probe = new Database(":memory:");
  tryLoadSqliteVec(probe);
  const ok = isVecLoaded(probe);
  probe.close();
  return ok;
}
const VEC_AVAILABLE = vecAvailable();

function makeDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function insertVecRow(db: Database, rowid: number): void {
  const embedding = new Float32Array(384).fill(0.01);
  const bytes = new Uint8Array(embedding.buffer);
  db.run("INSERT INTO vec_items_384(rowid, embedding) VALUES (?, vec_f32(?))", [rowid, bytes]);
}

function insertChunkNoFk(db: Database, itemId: string, vecRowid: number, chunkIndex = 0): void {
  db.run("PRAGMA foreign_keys = OFF");
  db.run(
    `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
     VALUES (?, ?, 'x', ?, 'test-model', 384, 0)`,
    [itemId, chunkIndex, vecRowid],
  );
  db.run("PRAGMA foreign_keys = ON");
}

describe("repairIndex — clean database", () => {
  test("returns empty outcomes when nothing is broken", () => {
    const db = makeDb();
    const report = repairIndex(db, LocalIndex.SCHEMA_VERSION);
    expect(report.outcomes).toHaveLength(0);
    db.close();
  });
});

describe("repairIndex — orphaned sync tokens", () => {
  test("removes orphaned sync_state rows and subsequent verify is clean", () => {
    const db = makeDb();

    db.run(
      `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token)
       VALUES ('ghost', ${String(Date.now())}, 'tok')`,
    );

    const before = verifyIndex(db, LocalIndex.SCHEMA_VERSION);
    const orphanBefore = before.findings.find((f) => f.label === "orphaned_sync_tokens");
    expect(orphanBefore?.status).toBe("fail");

    const report = repairIndex(db, LocalIndex.SCHEMA_VERSION);
    const outcome = report.outcomes.find((o) => o.action === "orphaned_sync_tokens_delete");
    expect(outcome?.status).toBe("applied");

    const after = verifyIndex(db, LocalIndex.SCHEMA_VERSION);
    const orphanAfter = after.findings.find((f) => f.label === "orphaned_sync_tokens");
    expect(orphanAfter?.status).toBe("ok");

    db.close();
  });

  test("skips action when no orphaned tokens exist", () => {
    const db = makeDb();
    const report = repairIndex(db, LocalIndex.SCHEMA_VERSION);
    const outcome = report.outcomes.find((o) => o.action === "orphaned_sync_tokens_delete");
    expect(outcome).toBeUndefined();
    db.close();
  });
});

// KNOWN GAP — repairIndex's FTS5 rebuild is unreachable from this suite: repairFts5 only runs
// when verifyIndex flags fts5_consistency = "fail", which requires actual FTS5 shadow-table
// corruption. Bun's :memory: SQLite cannot induce that state without lower-level manipulation
// outside the public API, so no stub test is carried here.

describe("repairIndex — audit log entry", () => {
  test("writes audit_log entry when repairs are applied", () => {
    const db = makeDb();

    db.run(
      `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token)
       VALUES ('ghost', ${String(Date.now())}, 'tok')`,
    );

    repairIndex(db, LocalIndex.SCHEMA_VERSION);

    const rows = db
      .query(`SELECT action_type, hitl_status, action_json FROM audit_log ORDER BY id DESC LIMIT 1`)
      .all() as Array<{ action_type: string; hitl_status: string; action_json: string }>;

    expect(rows[0]?.action_type).toBe("db.repair");
    expect(rows[0]?.hitl_status).toBe("not_required");
    const parsed = JSON.parse(rows[0]?.action_json ?? "{}") as { outcomes: unknown[] };
    expect(parsed.outcomes).toBeDefined();
    expect(Array.isArray(parsed.outcomes)).toBe(true);
    db.close();
  });
});

describe("formatRepairReport", () => {
  test("empty report produces 'Nothing to repair' message", () => {
    const db = makeDb();
    const report = repairIndex(db, LocalIndex.SCHEMA_VERSION);
    const output = formatRepairReport(report);
    expect(output).toContain("Nothing to repair");
    db.close();
  });

  test("non-empty report lists applied actions", () => {
    const db = makeDb();
    db.run(
      `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token)
       VALUES ('ghost', ${String(Date.now())}, 'tok')`,
    );
    const report = repairIndex(db, LocalIndex.SCHEMA_VERSION);
    const output = formatRepairReport(report);
    expect(output).toContain("[applied]");
    expect(output).toContain("Repaired at:");
    db.close();
  });

  test("skipped outcome renders [skipped] tag", () => {
    const report = {
      outcomes: [
        {
          action: "vec_orphan_delete" as const,
          status: "skipped" as const,
          detail: "no orphaned vec rows",
        },
      ],
      repairedAt: new Date().toISOString(),
    };
    const output = formatRepairReport(report);
    expect(output).toContain("[skipped]");
    expect(output).toContain("vec_orphan_delete");
    expect(output).toContain("no orphaned vec rows");
  });

  test("error outcome renders [ error ] tag", () => {
    const report = {
      outcomes: [
        { action: "fts5_rebuild" as const, status: "error" as const, detail: "disk full" },
      ],
      repairedAt: new Date().toISOString(),
    };
    const output = formatRepairReport(report);
    expect(output).toContain("[ error ]");
    expect(output).toContain("fts5_rebuild");
    expect(output).toContain("disk full");
  });

  test("outcome with no detail renders action name without a trailing colon+detail", () => {
    const report = {
      outcomes: [{ action: "orphaned_sync_tokens_delete" as const, status: "applied" as const }],
      repairedAt: new Date().toISOString(),
    };
    const output = formatRepairReport(report);
    expect(output).toContain("[applied]");
    const actionLine = output.split("\n").find((l) => l.includes("orphaned_sync_tokens_delete"));
    expect(actionLine).toBeDefined();
    expect(actionLine?.trim()).toBe("[applied] orphaned_sync_tokens_delete");
  });
});

describe("repairIndex — vec orphan repair", () => {
  test.skipIf(!VEC_AVAILABLE)(
    "deletes orphaned vec_items_384 rows and reports affected count",
    () => {
      const db = makeDb();

      insertVecRow(db, 7777);

      const before = verifyIndex(db, LocalIndex.SCHEMA_VERSION);
      const mismatch = before.findings.find((f) => f.label === "vec_rowid_mismatch");
      expect(mismatch?.status).toBe("fail");

      const report = repairIndex(db, LocalIndex.SCHEMA_VERSION);

      const outcome = report.outcomes.find((o) => o.action === "vec_orphan_delete");
      expect(outcome?.status).toBe("applied");
      expect(outcome?.detail).toContain("deleted 1 orphaned vec row(s)");

      const vecCount = db.query("SELECT COUNT(*) AS c FROM vec_items_384").get() as { c: number };
      expect(vecCount.c).toBe(0);

      db.close();
    },
  );

  test("skips vec orphan repair when no orphans exist (vec count matches chunk count)", () => {
    const db = makeDb();

    const report = repairIndex(db, LocalIndex.SCHEMA_VERSION);
    const outcome = report.outcomes.find((o) => o.action === "vec_orphan_delete");
    expect(outcome).toBeUndefined();

    db.close();
  });
});

describe("repairIndex — foreign-key cascade repair", () => {
  test("deletes embedding_chunk rows with missing parent item and reports count", () => {
    const db = makeDb();

    insertChunkNoFk(db, "ghost-item:1", 42);

    const before = verifyIndex(db, LocalIndex.SCHEMA_VERSION);
    const fkFinding = before.findings.find((f) => f.label === "foreign_key_integrity");
    expect(fkFinding?.status).toBe("fail");

    const report = repairIndex(db, LocalIndex.SCHEMA_VERSION);

    const fkOutcome = report.outcomes.find((o) => o.action === "foreign_key_cascade_delete");
    expect(fkOutcome?.status).toBe("applied");
    expect(fkOutcome?.detail).toContain("deleted 1 row(s)");

    const remaining = db.query("SELECT COUNT(*) AS n FROM embedding_chunk").get() as {
      n: number;
    };
    expect(remaining.n).toBe(0);

    db.close();
  });

  test("skips FK repair when no violations exist", () => {
    const db = makeDb();
    const report = repairIndex(db, LocalIndex.SCHEMA_VERSION);
    const fkOutcome = report.outcomes.find((o) => o.action === "foreign_key_cascade_delete");
    expect(fkOutcome).toBeUndefined();
    db.close();
  });

  test("batches deletions when there are many FK-violating rows", () => {
    const db = makeDb();

    db.run("PRAGMA foreign_keys = OFF");
    const stmt = db.prepare(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES (?, ?, 'x', ?, 'test-model', 384, 0)`,
    );
    for (let i = 0; i < 1001; i++) {
      stmt.run([`ghost:${String(i)}`, 0, i + 1]);
    }
    db.run("PRAGMA foreign_keys = ON");

    const report = repairIndex(db, LocalIndex.SCHEMA_VERSION);
    const fkOutcome = report.outcomes.find((o) => o.action === "foreign_key_cascade_delete");
    expect(fkOutcome?.status).toBe("applied");
    const remaining = db.query("SELECT COUNT(*) AS n FROM embedding_chunk").get() as {
      n: number;
    };
    expect(remaining.n).toBe(0);

    db.close();
  });
});

describe("repairIndex — multi-action report shape", () => {
  test.skipIf(!VEC_AVAILABLE)(
    "returns an outcome entry for every triggered repair action with valid status",
    () => {
      const db = makeDb();

      db.run(
        `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token)
       VALUES ('ghost-connector', ${String(Date.now())}, 'tok')`,
      );
      insertChunkNoFk(db, "ghost-item:99", 55);
      insertVecRow(db, 8888);
      insertVecRow(db, 8889);

      const before = verifyIndex(db, LocalIndex.SCHEMA_VERSION);
      const mismatch = before.findings.find((f) => f.label === "vec_rowid_mismatch");
      expect(mismatch?.status).toBe("fail");

      const report = repairIndex(db, LocalIndex.SCHEMA_VERSION);

      const seenActions = new Set(report.outcomes.map((o) => o.action));
      expect(seenActions.has("orphaned_sync_tokens_delete")).toBe(true);
      expect(seenActions.has("foreign_key_cascade_delete")).toBe(true);
      expect(seenActions.has("vec_orphan_delete")).toBe(true);

      for (const o of report.outcomes) {
        expect(["applied", "skipped", "error"]).toContain(o.status);
      }

      expect(report.repairedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      db.close();
    },
  );

  test("writes audit_log entry with all outcomes in action_json", () => {
    const db = makeDb();

    insertChunkNoFk(db, "ghost-fk:1", 10);

    repairIndex(db, LocalIndex.SCHEMA_VERSION);

    const rows = db
      .query(
        `SELECT action_type, hitl_status, action_json FROM audit_log
         WHERE action_type = 'db.repair' ORDER BY id DESC LIMIT 1`,
      )
      .all() as Array<{ action_type: string; hitl_status: string; action_json: string }>;

    expect(rows[0]?.action_type).toBe("db.repair");
    expect(rows[0]?.hitl_status).toBe("not_required");
    const parsed = JSON.parse(rows[0]?.action_json ?? "{}") as { outcomes: unknown[] };
    expect(Array.isArray(parsed.outcomes)).toBe(true);
    expect(parsed.outcomes.length).toBeGreaterThan(0);

    db.close();
  });
});

describe("repairIndex — repair outcome detail strings", () => {
  test("repair outcome detail strings contain no raw SQL metacharacters", () => {
    const db = makeDb();
    insertChunkNoFk(db, "ghost:safety", 20);

    const report = repairIndex(db, LocalIndex.SCHEMA_VERSION);

    for (const o of report.outcomes) {
      if (o.detail !== undefined) {
        expect(o.detail).not.toContain(";");
        expect(o.detail).not.toContain("DROP");
        expect(o.detail).not.toContain("--");
      }
    }

    db.close();
  });
});
