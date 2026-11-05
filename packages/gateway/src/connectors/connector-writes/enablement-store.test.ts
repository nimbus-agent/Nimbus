import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { dbRun } from "../../db/write.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import {
  getModelWriteEnablement,
  listModelWriteEnablement,
  modelWriteServices,
  removeModelWriteEnablement,
  setModelWriteEnablement,
  writesEnabledBy,
} from "./enablement-store.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 84);
});
afterEach(() => db.close());

describe("enablement store", () => {
  test("upsert replaces the row (a new wave, a new time, a new approved set)", () => {
    setModelWriteEnablement(db, "github", 3, 10, ["github_issue_create"]);
    setModelWriteEnablement(db, "github", 4, 20, ["b_write", "a_write", "b_write"]);
    expect(getModelWriteEnablement(db, "github")).toEqual({
      service: "github",
      maxWave: 4,
      enabledAt: 20,
      approvedToolIds: new Set(["a_write", "b_write"]),
    });
    // Stored sorted and de-duplicated.
    expect(db.query("SELECT approved_tool_ids FROM connector_write_enablement").get()).toEqual({
      approved_tool_ids: '["a_write","b_write"]',
    });
    expect(listModelWriteEnablement(db)).toHaveLength(1);
  });

  test("a pre-V84 row (default) and a stored value that is not an array of strings approve nothing", () => {
    dbRun(
      db,
      "INSERT INTO connector_write_enablement (service, max_wave, enabled_at) VALUES ('github', 2, 1)",
    );
    expect(getModelWriteEnablement(db, "github")?.approvedToolIds.size).toBe(0);
    for (const bad of ["not json", '{"0":"x"}', '["ok", 7]', "null", '"x"']) {
      dbRun(db, "UPDATE connector_write_enablement SET approved_tool_ids = ? WHERE service = ?", [
        bad,
        "github",
      ]);
      expect(getModelWriteEnablement(db, "github")?.approvedToolIds.size, bad).toBe(0);
      expect(listModelWriteEnablement(db)[0]?.approvedToolIds.size, bad).toBe(0);
    }
  });

  test("remove returns true, then false", () => {
    setModelWriteEnablement(db, "github", 3, 10, []);
    expect(removeModelWriteEnablement(db, "github")).toBe(true);
    expect(removeModelWriteEnablement(db, "github")).toBe(false);
    expect(getModelWriteEnablement(db, "github")).toBeUndefined();
  });

  test("list is sorted by service", () => {
    setModelWriteEnablement(db, "snowflake", 2, 1, []);
    setModelWriteEnablement(db, "github", 3, 2, []);
    setModelWriteEnablement(db, "kubernetes", 4, 3, []);
    expect(listModelWriteEnablement(db).map((e) => e.service)).toEqual([
      "github",
      "kubernetes",
      "snowflake",
    ]);
  });

  test("modelWriteServices is derived from the row table", () => {
    const s = modelWriteServices();
    for (const id of ["github", "kubernetes", "snowflake"]) expect(s).toContain(id);
    expect(s).not.toContain("mcp_x");
    expect([...s]).toEqual([...s].sort((a, b) => a.localeCompare(b)));
  });

  test("writesEnabledBy keeps rows at or below the wave", () => {
    const w2 = writesEnabledBy("github", 2).map((r) => r.toolId);
    expect(w2).toContain("github_issue_create");
    expect(w2).not.toContain("github_pr_merge");
    expect(writesEnabledBy("github", 3).map((r) => r.toolId)).toContain("github_pr_merge");
    expect(writesEnabledBy("mcp_x", 4)).toEqual([]);
  });
});
