import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "./runner.ts";

describe("V37 gdpr purge ledger migration", () => {
  it("creates gdpr_purge_job and gdpr_purge_request at target version 37", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 37);
    const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(uv).toBe(37);
    const names = (
      db.query(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).toContain("gdpr_purge_job");
    expect(names).toContain("gdpr_purge_request");
    db.close();
  });
});
