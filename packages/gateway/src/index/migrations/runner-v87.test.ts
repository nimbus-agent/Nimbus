import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rmDirWithRetry } from "../../../test/helpers/rm-dir-with-retry.ts";
import { appendAuditEntry } from "../../db/audit-chain.ts";
import { verifyAuditChain } from "../../db/audit-verify.ts";
import { appendEgressEntry } from "../../egress/egress-ledger.ts";
import { verifyEgressChain } from "../../egress/egress-verify.ts";
import { v87TableSql } from "../hitl-status-v87-sql.ts";
import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

type Master = { type: string; name: string; sql: string | null };

function masterOf(db: Database, table: string): Master[] {
  return db
    .query("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? ORDER BY type, name")
    .all(table) as Master[];
}

/** A V86 database with chained audit rows (some carrying federation_json) and egress rows. */
function seededV86(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 86);
  const statuses = ["approved", "rejected", "not_required"] as const;
  for (let i = 0; i < 6; i++) {
    appendAuditEntry(db, {
      actionType: `test.action${String(i)}`,
      hitlStatus: statuses[i % 3] ?? "approved",
      actionJson: `{"n":${String(i)}}`,
      timestamp: 1_000 + i,
      sessionId: i % 2 === 0 ? `s${String(i)}` : "",
      ...(i % 2 === 1 ? { federationJson: `{"peer":"p${String(i)}"}` } : {}),
    });
  }
  for (let i = 0; i < 5; i++) {
    appendEgressEntry(db, {
      timestamp: 2_000 + i,
      sourceType: "task",
      sourceId: `s${String(i)}`,
      destination: "slack",
      method: "slack.message.post",
      payloadSummary: "{}",
      hitlStatus: statuses[i % 3] ?? "approved",
      resultStatus: i % 2 === 0 ? "authorized" : "blocked",
    });
  }
  return db;
}

/** The message of the error the V87 step threw (the runner wraps it in a rollback error). */
function causeOfMigrationFailure(db: Database): string {
  try {
    runIndexedSchemaMigrations(db, 87);
  } catch (e) {
    return (e as { cause?: Error }).cause?.message ?? String(e);
  }
  return "no failure";
}

const lastHash = (db: Database, table: string): string =>
  (db.query(`SELECT row_hash FROM ${table} ORDER BY id DESC LIMIT 1`).get() as { row_hash: string })
    .row_hash;

const count = (db: Database, table: string): number =>
  (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("V87 migration: hitl_status gains standing_approved", () => {
  test("the registered maximum and the current schema are 87 and agree", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(87);
    expect(maxRegisteredIndexedSchemaVersion()).toBe(87);
  });

  test("rows and chain survive, and both chains still verify", () => {
    const db = seededV86();
    try {
      const auditBefore = { n: count(db, "audit_log"), last: lastHash(db, "audit_log") };
      const egressBefore = { n: count(db, "egress_ledger"), last: lastHash(db, "egress_ledger") };
      const ids = db.query("SELECT id FROM audit_log ORDER BY id").all();
      runIndexedSchemaMigrations(db, 87);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 87 });
      expect({ n: count(db, "audit_log"), last: lastHash(db, "audit_log") }).toEqual(auditBefore);
      expect({ n: count(db, "egress_ledger"), last: lastHash(db, "egress_ledger") }).toEqual(
        egressBefore,
      );
      expect(db.query("SELECT id FROM audit_log ORDER BY id").all()).toEqual(ids);
      const fed = db.query("SELECT COUNT(*) AS n FROM audit_log WHERE federation_json IS NOT NULL");
      expect(fed.get()).toEqual({ n: 3 });
      const full = verifyAuditChain(new LocalIndex(db), { fromId: 0 });
      expect(full).toMatchObject({ ok: true, verifiedRows: auditBefore.n });
      expect(verifyEgressChain(db, 0).ok).toBe(true);
    } finally {
      db.close();
    }
  });

  test("standing_approved is accepted, anything else still is not", () => {
    const db = seededV86();
    try {
      runIndexedSchemaMigrations(db, 87);
      const audit = (status: string): unknown =>
        db.run(
          "INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp) VALUES ('x', ?, '{}', 1)",
          [status],
        );
      const egress = (status: string): unknown =>
        db.run(
          `INSERT INTO egress_ledger (timestamp, source_type, source_id, destination, method,
             payload_summary, hitl_status, result_status, row_hash, prev_hash)
           VALUES (1, 'task', NULL, 'd', 'm', '{}', ?, 'authorized', 'h', 'p')`,
          [status],
        );
      expect(() => audit("standing_approved")).not.toThrow();
      expect(() => egress("standing_approved")).not.toThrow();
      expect(() => audit("bogus")).toThrow();
      expect(() => egress("bogus")).toThrow();
      for (const old of ["approved", "rejected", "not_required"]) {
        expect(() => audit(old)).not.toThrow();
        expect(() => egress(old)).not.toThrow();
      }
    } finally {
      db.close();
    }
  });

  test("every index and trigger is recreated verbatim, including ones added by hand", () => {
    const db = seededV86();
    try {
      // The append-only guard an operator (or a later version) may add must survive the rebuild.
      db.run(
        `CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
         BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`,
      );
      db.run(
        `CREATE TRIGGER egress_no_delete BEFORE DELETE ON egress_ledger
         BEGIN SELECT RAISE(ABORT, 'egress_ledger is append-only'); END`,
      );
      db.run("CREATE INDEX idx_audit_extra ON audit_log(action_type, timestamp)");
      const before = {
        audit: masterOf(db, "audit_log").filter((o) => o.type !== "table"),
        egress: masterOf(db, "egress_ledger").filter((o) => o.type !== "table"),
      };
      expect(before.audit.map((o) => o.name)).toContain("idx_audit_log_session_id");
      expect(before.egress.map((o) => o.name)).toContain("idx_egress_ledger_ts");
      runIndexedSchemaMigrations(db, 87);
      expect(masterOf(db, "audit_log").filter((o) => o.type !== "table")).toEqual(before.audit);
      expect(masterOf(db, "egress_ledger").filter((o) => o.type !== "table")).toEqual(
        before.egress,
      );
      expect(() => db.run("UPDATE audit_log SET action_json = '{}' WHERE id = 1")).toThrow(
        /append-only/,
      );
      expect(() => db.run("DELETE FROM egress_ledger WHERE id = 1")).toThrow(/append-only/);
    } finally {
      db.close();
    }
  });

  test("a fresh 0 to 87 database has the same tables as a migrated 86 to 87 one", () => {
    const fresh = new Database(":memory:");
    const migrated = seededV86();
    try {
      runIndexedSchemaMigrations(fresh, 87);
      runIndexedSchemaMigrations(migrated, 87);
      for (const table of ["audit_log", "egress_ledger"]) {
        expect(masterOf(migrated, table)).toEqual(masterOf(fresh, table));
      }
    } finally {
      fresh.close();
      migrated.close();
    }
  });

  test("the autoincrement counter is not lowered by the rebuild", () => {
    const db = seededV86();
    try {
      // A pruned tail leaves the counter ahead of MAX(id); an id must never be reused.
      db.run("DELETE FROM egress_ledger WHERE id = 5");
      const seq = (): unknown =>
        db.query("SELECT seq FROM sqlite_sequence WHERE name = 'egress_ledger'").get();
      expect(seq()).toEqual({ seq: 5 });
      runIndexedSchemaMigrations(db, 87);
      expect(seq()).toEqual({ seq: 5 });
    } finally {
      db.close();
    }
  });

  test("a view that names the table refuses the rebuild", () => {
    const db = seededV86();
    try {
      db.run("CREATE VIEW audit_recent AS SELECT id FROM audit_log");
      expect(causeOfMigrationFailure(db)).toMatch(/references audit_log/);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 86 });
    } finally {
      db.close();
    }
  });

  test("a trigger on another table that names the table refuses the rebuild", () => {
    const db = seededV86();
    try {
      db.run("CREATE TABLE other_t (x INTEGER)");
      db.run(
        "CREATE TRIGGER other_t_ai AFTER INSERT ON other_t BEGIN DELETE FROM egress_ledger WHERE id = 0; END",
      );
      expect(causeOfMigrationFailure(db)).toMatch(/references egress_ledger/);
    } finally {
      db.close();
    }
  });
});

describe("V87 on a database file reopened by a new connection (the production sequence)", () => {
  test("migrates with no sqlite-vec loaded on the connection, leaks no handle and keeps the chains", () => {
    // `LocalIndex.ensureSchema` migrates BEFORE it loads the vec extension, and an existing V86
    // database has triggers that name the vec virtual tables: a rename that re-parses them fails.
    const dir = mkdtempSync(join(tmpdir(), "nimbus-v87-"));
    try {
      const path = join(dir, "nimbus.db");
      const first = new Database(path);
      runIndexedSchemaMigrations(first, 86);
      appendAuditEntry(first, {
        actionType: "a",
        hitlStatus: "approved",
        actionJson: "{}",
        timestamp: 1,
      });
      first.close(true);
      const second = new Database(path);
      runIndexedSchemaMigrations(second, 87);
      expect(second.query("PRAGMA user_version").get()).toEqual({ user_version: 87 });
      expect(second.query("PRAGMA legacy_alter_table").get()).toEqual({ legacy_alter_table: 0 });
      expect(count(second, "audit_log")).toBe(1);
      expect(verifyAuditChain(new LocalIndex(second), { fromId: 0 }).ok).toBe(true);
      // `close(true)` throws while any statement is still live; the delete then cannot fail EBUSY.
      second.close(true);
    } finally {
      rmDirWithRetry(dir);
    }
  });
});

describe("v87TableSql", () => {
  const ok =
    "CREATE TABLE t (id INTEGER, hitl_status TEXT NOT NULL CHECK(hitl_status IN ('a','b')), x TEXT)";

  test("renames the table and adds the value once", () => {
    expect(v87TableSql(ok, "t")).toBe(
      "CREATE TABLE t_v87 (id INTEGER, hitl_status TEXT NOT NULL CHECK(hitl_status IN ('a','b','standing_approved')), x TEXT)",
    );
    expect(v87TableSql(ok.replace("CREATE TABLE t", 'CREATE TABLE "t"'), "t")).toContain("t_v87 (");
  });

  test("throws when the DDL is not the expected shape", () => {
    expect(() => v87TableSql("CREATE TABLE other (hitl_status TEXT)", "t")).toThrow(
      /does not start/,
    );
    expect(() => v87TableSql("CREATE TABLE t (hitl_status TEXT)", "t")).toThrow(/found 0/);
    expect(() => v87TableSql(`${ok.slice(0, -1)}, CHECK(hitl_status IN ('c')))`, "t")).toThrow(
      /found 2/,
    );
    expect(() =>
      v87TableSql("CREATE TABLE t (s TEXT CHECK(hitl_status IN ('a','standing_approved')))", "t"),
    ).toThrow(/already allows/);
  });

  test("a missing table is reported", () => {
    const db = seededV86();
    try {
      db.run("DROP TABLE egress_ledger");
      expect(causeOfMigrationFailure(db)).toMatch(/egress_ledger is missing/);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 86 });
    } finally {
      db.close();
    }
  });
});
