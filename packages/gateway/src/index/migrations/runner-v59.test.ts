import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readIndexedUserVersion, runIndexedSchemaMigrations } from "./runner.ts";

describe("V59 — media_grant", () => {
  /**
   * Migrating to the literal 59 rather than `CURRENT_SCHEMA_VERSION` is the point: this proves the
   * 58→59 STEP is registered. Migrating to the constant would keep passing if the step were
   * deleted and the constant lowered back to 58 — the table would simply never be created and the
   * assertion would move with it. Copied deliberately from `runner-v58.test.ts`.
   */
  test("the 58→59 step is registered: user_version advances and the table appears", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 58);
    expect(readIndexedUserVersion(db)).toBe(58);
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='media_grant'",
        )
        .get(),
    ).toBeNull();

    runIndexedSchemaMigrations(db, 59);
    expect(readIndexedUserVersion(db)).toBe(59);
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='media_grant'",
        )
        .get()?.name,
    ).toBe("media_grant");
    db.close();
  });

  /**
   * The partial index is the whole reason revocation is not terminal (§ 18.3). A plain
   * UNIQUE(item_id, modality, model_vendor) would make a revoked row occupy the slot forever, so
   * the same artifact could never be re-granted without mutating history.
   */
  test("one ACTIVE grant per (item, modality, vendor), but re-granting after revocation works", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 59);
    const ins = (id: string, revokedAt: number | null) =>
      db.run(
        "INSERT INTO media_grant (id, item_id, modality, model_vendor, granted_at, revoked_at) VALUES (?, ?, 'image', 'openai', 1000, ?)",
        [id, "item-1", revokedAt],
      );

    ins("g1", null);
    expect(() => ins("g2", null)).toThrow(); // second ACTIVE grant is refused
    db.run("UPDATE media_grant SET revoked_at = 2000 WHERE id = 'g1'");
    expect(() => ins("g3", null)).not.toThrow(); // re-grant after revocation is allowed
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM media_grant").get()?.n).toBe(2); // the revoked row SURVIVES — append-only audit trail
    db.close();
  });

  test("the modality CHECK constraint rejects an unknown modality", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 59);
    expect(() =>
      db.run(
        "INSERT INTO media_grant (id, item_id, modality, model_vendor, granted_at, revoked_at) VALUES ('g', 'i', 'text', 'openai', 1, NULL)",
      ),
    ).toThrow();
    db.close();
  });
});
