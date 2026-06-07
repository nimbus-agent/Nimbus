import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "./runner.ts";

describe("V35 team-vault migration", () => {
  it("creates team-vault tables at target version 35", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(uv).toBe(35);
    const names = (
      db.query(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).toContain("team_vault_entries");
    expect(names).toContain("hitl_delegations");
    db.close();
  });
});
