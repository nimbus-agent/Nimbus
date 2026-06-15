import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../local-index.ts";

describe("V41 share_records", () => {
  test("CURRENT_SCHEMA_VERSION is 41", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(41);
  });
  test("ensureSchema creates share_records with expected columns", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const cols = (db.query("PRAGMA table_info(share_records)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "content_hash",
        "kind",
        "session_id",
        "created_at",
        "expires_at",
        "redaction_set_json",
        "provenance_json",
        "body_json",
        "sig_json",
        "sink",
      ]),
    );
    db.close();
  });
});
