import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "./runner.ts";

describe("V36 policy migration", () => {
  it("creates org_policy_state and policy_anchor_pin at target version 36", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 36);
    const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(uv).toBe(36);
    const names = (
      db.query(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).toContain("org_policy_state");
    expect(names).toContain("policy_anchor_pin");
    db.close();
  });
});
