// Signed workflow import (I59): the provenance and replay floor store (plan task 3).
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  floorFor,
  listSources,
  type RecordImportInput,
  readImportSource,
  recordImport,
  signerHistory,
  signersForName,
} from "./workflow-import-store.ts";

const A = "a".repeat(32);
const B = "b".repeat(32);

function dbAt(version: number): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, version);
  return db;
}

function rec(over: Partial<RecordImportInput> = {}): RecordImportInput {
  return {
    signerFingerprint: A,
    bundleName: "weekly",
    issuedAt: 100,
    bundleSha256: "1".repeat(64),
    stepsSha256: "2".repeat(64),
    signerPubkey: "pk",
    authorLabel: "lead",
    workflowId: "w1",
    importedAt: 1000,
    approvalAuditId: 7,
    ...over,
  };
}

describe("workflow-import-store", () => {
  test("recordImport creates the floor, then raises it and bumps the count", () => {
    const db = dbAt(CURRENT_SCHEMA_VERSION);
    expect(recordImport(db, rec())).toBe(true);
    expect(floorFor(db, A, "weekly")).toMatchObject({ issuedAt: 100, importCount: 1 });
    expect(recordImport(db, rec({ issuedAt: 200, importedAt: 2000 }))).toBe(true);
    expect(floorFor(db, A, "weekly")).toMatchObject({
      issuedAt: 200,
      importCount: 2,
      importedAt: 2000,
    });
  });

  test("an OLDER bundle can never lower or replace the floor", () => {
    const db = dbAt(CURRENT_SCHEMA_VERSION);
    recordImport(db, rec({ issuedAt: 200, bundleSha256: "9".repeat(64) }));
    expect(recordImport(db, rec({ issuedAt: 150, bundleSha256: "8".repeat(64) }))).toBe(false);
    expect(floorFor(db, A, "weekly")).toMatchObject({
      issuedAt: 200,
      bundleSha256: "9".repeat(64),
      importCount: 1,
    });
  });

  test("the floor is per (signer, name) and has no foreign key: it survives the workflow", () => {
    const db = dbAt(CURRENT_SCHEMA_VERSION);
    recordImport(db, rec());
    recordImport(db, rec({ signerFingerprint: B, workflowId: "w2" }));
    expect(floorFor(db, A, "other")).toBeNull();
    expect(floorFor(db, B, "weekly")?.workflowId).toBe("w2");
    db.run("DELETE FROM workflow");
    expect(floorFor(db, A, "weekly")).not.toBeNull();
  });

  test("readImportSource and listSources: the newest row wins when a signer change left several for one workflow", () => {
    const db = dbAt(CURRENT_SCHEMA_VERSION);
    recordImport(db, rec({ signerFingerprint: A, workflowId: "w1", importedAt: 1000 }));
    recordImport(
      db,
      rec({
        signerFingerprint: B,
        workflowId: "w1",
        importedAt: 2000,
        stepsSha256: "3".repeat(64),
      }),
    );
    expect(readImportSource(db, "w1")?.signerFingerprint).toBe(B);
    expect(listSources(db).get("w1")?.signerFingerprint).toBe(B);
    // Equal imported_at: the later rowid decides.
    recordImport(
      db,
      rec({ signerFingerprint: A, bundleName: "x", workflowId: "w3", importedAt: 5 }),
    );
    recordImport(
      db,
      rec({ signerFingerprint: B, bundleName: "y", workflowId: "w3", importedAt: 5 }),
    );
    expect(readImportSource(db, "w3")?.signerFingerprint).toBe(B);
    expect(listSources(db).size).toBe(2);
    expect(readImportSource(db, "nope")).toBeNull();
  });

  test("A -> B -> A: the LAST import supplies the source, with a decreasing or an equal clock", () => {
    for (const thirdAt of [1500, 2000]) {
      const db = dbAt(CURRENT_SCHEMA_VERSION);
      recordImport(db, rec({ signerFingerprint: A, workflowId: "w1", importedAt: 1000 }));
      recordImport(db, rec({ signerFingerprint: B, workflowId: "w1", importedAt: 2000 }));
      // A again (an upsert of A's row: same rowid) after a clock correction, or at an equal time.
      expect(
        recordImport(
          db,
          rec({ signerFingerprint: A, workflowId: "w1", issuedAt: 300, importedAt: thirdAt }),
        ),
      ).toBe(true);
      expect(readImportSource(db, "w1")?.signerFingerprint).toBe(A);
      expect(listSources(db).get("w1")?.signerFingerprint).toBe(A);
      expect(signersForName(db, "weekly")[0]?.signerFingerprint).toBe(A);
    }
  });

  test("signersForName lists every signer that imported the name, and uses the name index", () => {
    const db = dbAt(CURRENT_SCHEMA_VERSION);
    recordImport(db, rec());
    recordImport(db, rec({ signerFingerprint: B, workflowId: "w2", importedAt: 2000 }));
    expect(signersForName(db, "weekly").map((r) => r.signerFingerprint)).toEqual([B, A]);
    expect(signersForName(db, "none")).toEqual([]);
    const plan = (
      db
        .query("EXPLAIN QUERY PLAN SELECT * FROM workflow_import WHERE bundle_name = ?")
        .all("weekly") as { detail: string }[]
    )
      .map((r) => r.detail)
      .join("\n");
    expect(plan).toContain("workflow_import_name");
  });

  test("signerHistory counts imports across names", () => {
    const db = dbAt(CURRENT_SCHEMA_VERSION);
    expect(signerHistory(db, A)).toBeNull();
    recordImport(db, rec());
    recordImport(db, rec({ importedAt: 3000, issuedAt: 101 }));
    recordImport(db, rec({ bundleName: "second", importedAt: 2500 }));
    expect(signerHistory(db, A)).toEqual({ count: 3, lastAt: 3000 });
  });

  test("below V101 the reads return nothing and recordImport throws (the version gate)", () => {
    const db = dbAt(100);
    expect(floorFor(db, A, "weekly")).toBeNull();
    expect(readImportSource(db, "w1")).toBeNull();
    expect(listSources(db).size).toBe(0);
    expect(signersForName(db, "weekly")).toEqual([]);
    expect(signerHistory(db, A)).toBeNull();
    expect(() => recordImport(db, rec())).toThrow(/V101/);
  });
});
