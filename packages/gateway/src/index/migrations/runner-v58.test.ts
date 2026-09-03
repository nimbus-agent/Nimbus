import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { readIndexedUserVersion, runIndexedSchemaMigrations } from "./runner.ts";

describe("V58 — media_pass_cursor", () => {
  /**
   * Migrating to the literal 58 rather than `CURRENT_SCHEMA_VERSION` is the point: this proves the
   * 57→58 STEP is registered and applies. Migrating to the constant would keep passing if the step
   * were deleted and the constant lowered back to 57 — the table would simply never be created and
   * the assertion would move with it.
   */
  test("the 57→58 step is registered: user_version advances and the table appears", () => {
    const db = new Database(":memory:");

    runIndexedSchemaMigrations(db, 57);
    expect(readIndexedUserVersion(db)).toBe(57);
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='media_pass_cursor'",
        )
        .get(),
    ).toBeNull();

    runIndexedSchemaMigrations(db, 58);
    expect(readIndexedUserVersion(db)).toBe(58);
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='media_pass_cursor'",
        )
        .get()?.name,
    ).toBe("media_pass_cursor");

    db.close();
  });

  test("creates the cursor table and reaches version 58", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);

    const row = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='media_pass_cursor'",
      )
      .get();
    expect(row?.name).toBe("media_pass_cursor");
    db.close();
  });

  test("cursor round-trips and pass_id is the primary key", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);

    db.run(
      "INSERT INTO media_pass_cursor (pass_id, service, modality, last_item_id, processed_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["p1", "filesystem", "av", "filesystem:a.mp4", 3, 1000],
    );
    db.run(
      `INSERT INTO media_pass_cursor (pass_id, service, modality, last_item_id, processed_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(pass_id) DO UPDATE SET last_item_id = excluded.last_item_id, processed_count = excluded.processed_count`,
      ["p1", "filesystem", "av", "filesystem:b.mp4", 7, 2000],
    );

    const rows = db
      .query<{ last_item_id: string; processed_count: number }, []>(
        "SELECT last_item_id, processed_count FROM media_pass_cursor",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.last_item_id).toBe("filesystem:b.mp4");
    expect(rows[0]?.processed_count).toBe(7);
    db.close();
  });
});
