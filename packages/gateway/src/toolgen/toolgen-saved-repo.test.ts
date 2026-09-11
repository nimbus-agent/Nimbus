import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { readIndexedUserVersion, runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  deleteSavedTool,
  getSavedTool,
  insertSavedTool,
  listSavedTools,
  repairDisabledSavedTool,
  repairSavedToolCache,
  type SavedToolRow,
  setSavedToolDisabled,
  touchSavedToolLoaded,
} from "./toolgen-saved-repo.ts";

/**
 * A real migrated database, via the project's actual migration runner — never a hand-executed
 * `CREATE TABLE`. Hand-executing the DDL here would let every other test in this file pass even
 * if the V61 step were never registered with the runner; only the last test below (which asserts
 * the resulting `user_version`) actually proves the step ran.
 */
function migratedTestDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

function sampleRow(overrides: Partial<SavedToolRow> = {}): SavedToolRow {
  return {
    toolId: "t1",
    toolName: "gitea_issues",
    description: "d",
    artifactJson: '{"a":1}',
    artifactDigest: "deadbeef",
    signature: "sig",
    pubkey: "pk",
    approvedAt: 1000,
    savedAt: 2000,
    lastLoadedAt: null,
    disabledReason: null,
    ...overrides,
  };
}

test("insert then get round-trips every column", () => {
  const db = migratedTestDb();
  insertSavedTool(db, sampleRow());
  expect(getSavedTool(db, "t1")).toEqual(sampleRow());
});

test("setSavedToolDisabled writes and clears the reason", () => {
  const db = migratedTestDb();
  insertSavedTool(db, sampleRow());
  setSavedToolDisabled(db, "t1", "signature_mismatch");
  expect(getSavedTool(db, "t1")?.disabledReason).toBe("signature_mismatch");
  setSavedToolDisabled(db, "t1", null);
  expect(getSavedTool(db, "t1")?.disabledReason).toBeNull();
});

test("deleteSavedTool removes the row and is idempotent", () => {
  const db = migratedTestDb();
  insertSavedTool(db, sampleRow());
  deleteSavedTool(db, "t1");
  expect(getSavedTool(db, "t1")).toBeNull();
  expect(() => deleteSavedTool(db, "t1")).not.toThrow();
});

test("getSavedTool returns null for an unknown tool id", () => {
  const db = migratedTestDb();
  expect(getSavedTool(db, "nope")).toBeNull();
});

test("listSavedTools returns every row", () => {
  const db = migratedTestDb();
  insertSavedTool(db, sampleRow({ toolId: "t1" }));
  insertSavedTool(db, sampleRow({ toolId: "t2", toolName: "jira_tickets" }));
  const rows = listSavedTools(db);
  expect(rows.map((r) => r.toolId).sort()).toEqual(["t1", "t2"]);
});

test("touchSavedToolLoaded updates last_loaded_at", () => {
  const db = migratedTestDb();
  insertSavedTool(db, sampleRow());
  touchSavedToolLoaded(db, "t1", 3000);
  expect(getSavedTool(db, "t1")?.lastLoadedAt).toBe(3000);
});

test("repairSavedToolCache overwrites artifactJson and artifactDigest only", () => {
  const db = migratedTestDb();
  insertSavedTool(db, sampleRow());
  repairSavedToolCache(db, "t1", { artifactJson: '{"a":2}', artifactDigest: "newdigest" });
  const row = getSavedTool(db, "t1");
  expect(row?.artifactJson).toBe('{"a":2}');
  expect(row?.artifactDigest).toBe("newdigest");
  expect(row?.signature).toBe("sig");
  expect(row?.pubkey).toBe("pk");
});

test("insertSavedTool UPSERTS — a second call for the same tool_id replaces every column, approved_at included", () => {
  const db = migratedTestDb();
  insertSavedTool(db, sampleRow());
  insertSavedTool(
    db,
    sampleRow({
      toolName: "gitea_issues_v2",
      description: "d2",
      artifactJson: '{"a":2}',
      artifactDigest: "newdigest",
      signature: "sig2",
      pubkey: "pk2",
      approvedAt: 5000,
      savedAt: 6000,
      disabledReason: "signature_mismatch",
    }),
  );
  expect(getSavedTool(db, "t1")).toEqual(
    sampleRow({
      toolName: "gitea_issues_v2",
      description: "d2",
      artifactJson: '{"a":2}',
      artifactDigest: "newdigest",
      signature: "sig2",
      pubkey: "pk2",
      approvedAt: 5000,
      savedAt: 6000,
      disabledReason: "signature_mismatch",
    }),
  );
});

test("repairDisabledSavedTool clears disabled_reason and updates signature/pubkey/saved_at only", () => {
  const db = migratedTestDb();
  insertSavedTool(db, sampleRow({ disabledReason: "pubkey_rotated" }));
  repairDisabledSavedTool(db, "t1", { signature: "newsig", pubkey: "newpk", savedAt: 9000 });
  const row = getSavedTool(db, "t1");
  expect(row?.disabledReason).toBeNull();
  expect(row?.signature).toBe("newsig");
  expect(row?.pubkey).toBe("newpk");
  expect(row?.savedAt).toBe(9000);
  // Untouched: no new approval happened, so nothing about the approval record may look newer.
  expect(row?.approvedAt).toBe(1000);
  expect(row?.artifactJson).toBe('{"a":1}');
  expect(row?.artifactDigest).toBe("deadbeef");
  expect(row?.toolName).toBe("gitea_issues");
  expect(row?.description).toBe("d");
});

test("the migration actually ran — schema version is 61", () => {
  expect(readIndexedUserVersion(migratedTestDb())).toBe(61);
});
