// packages/gateway/src/index/share-inbox-v43-sql.test.ts

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SHARE_INBOX_V43_SQL } from "./share-inbox-v43-sql.ts";

describe("SHARE_INBOX_V43_SQL", () => {
  test("creates share_inbox with the expected columns + indexes; is idempotent", () => {
    const db = new Database(":memory:");
    db.exec(SHARE_INBOX_V43_SQL);
    db.exec(SHARE_INBOX_V43_SQL); // CREATE ... IF NOT EXISTS → idempotent
    const cols = (db.query("PRAGMA table_info(share_inbox)").all() as { name: string }[])
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual(
      [
        "content_hash",
        "direction",
        "hops",
        "id",
        "origin_label",
        "received_at",
        "recipient_pubkey",
        "share_json",
        "status",
      ].sort(),
    );
    db.run(
      `INSERT INTO share_inbox (recipient_pubkey, content_hash, direction, share_json, origin_label, hops, received_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["PUB", "abc", "received", "{}", "alice", 1, 100, "viewable"],
    );
    expect((db.query("SELECT COUNT(*) c FROM share_inbox").get() as { c: number }).c).toBe(1);
  });
});
