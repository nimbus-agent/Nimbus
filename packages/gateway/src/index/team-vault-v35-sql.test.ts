import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { V35_TEAM_VAULT_SQL } from "./team-vault-v35-sql.ts";

describe("V35_TEAM_VAULT_SQL", () => {
  it("creates the three team-vault/HITL tables in a fresh db", () => {
    const db = new Database(":memory:");
    for (const sql of V35_TEAM_VAULT_SQL) db.exec(sql);
    const names = (
      db.query(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(names).toContain("team_vault_entries");
    expect(names).toContain("team_vault_grants");
    expect(names).toContain("hitl_delegations");
    db.close();
  });

  it("is idempotent (IF NOT EXISTS) — re-applying does not throw", () => {
    const db = new Database(":memory:");
    for (const sql of V35_TEAM_VAULT_SQL) db.exec(sql);
    expect(() => {
      for (const sql of V35_TEAM_VAULT_SQL) db.exec(sql);
    }).not.toThrow();
    db.close();
  });
});
