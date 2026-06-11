import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "./runner.ts";

describe("V38 known-namespaces cache migration", () => {
  it("creates federation_known_namespaces at target version 38", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 38);
    const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(uv).toBe(38);
    const names = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(names).toContain("federation_known_namespaces");
    db.close();
  });
});
