/**
 * `security-rpc.ts` arms `security-rpc.test.ts` leaves open:
 *  - the MID-scan progress cadence (one event every 200 scanned items — the main suite calls this
 *    "impractical" to seed; the 401 plain rows below, enough for TWO mid-scan events, go in as one
 *    transaction in milliseconds), and
 *  - `security.scan` with no injected clock, which must stamp the result from the real one.
 */
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { openSeededInMemoryDb } from "../../test/helpers/migrated-db-seed.ts";
import { awaitSecurityScanJob, dispatchSecurityRpc, runSecurityScan } from "./security-rpc.ts";

const TARGET_SCHEMA = 32;

/** `count` secret-free items for one service, in a single transaction. */
function seedPlainItems(db: Database, service: string, count: number): void {
  const insert = db.prepare(
    `INSERT INTO item
       (id, service, type, external_id, title, body_preview, url, canonical_url,
        modified_at, author_id, metadata, synced_at, pinned)
     VALUES (?, ?, 'file', ?, 't', 'nothing secret here', NULL, NULL, 1, NULL, '{}', 1, 0)`,
  );
  try {
    db.transaction(() => {
      for (let i = 0; i < count; i++) {
        insert.run(`${service}:${i}`, service, String(i));
      }
    })();
  } finally {
    insert.finalize();
  }
}

describe("runSecurityScan — progress cadence", () => {
  test("emits one progress event at every 200th scanned item, then a final one", async () => {
    const db = openSeededInMemoryDb(TARGET_SCHEMA);
    try {
      seedPlainItems(db, "filesystem", 401);
      const events: Array<Record<string, unknown>> = [];
      const v = await runSecurityScan(db, { nowMs: 1 }, (p) => events.push(p));
      expect(v.items_scanned).toBe(401);
      expect(v.findings_count).toBe(0);
      // 200 and 400 mid-scan (each against the FULL total), then the closing event.
      expect(events).toEqual([
        { scanned: 200, total: 401 },
        { scanned: 400, total: 401 },
        { scanned: 401, total: 401 },
      ]);
    } finally {
      db.close();
    }
  });

  test("below 200 items only the closing event is emitted", async () => {
    const db = openSeededInMemoryDb(TARGET_SCHEMA);
    try {
      seedPlainItems(db, "filesystem", 199);
      const events: Array<Record<string, unknown>> = [];
      await runSecurityScan(db, { nowMs: 1 }, (p) => events.push(p));
      expect(events).toEqual([{ scanned: 199, total: 199 }]);
    } finally {
      db.close();
    }
  });
});

describe("dispatchSecurityRpc — no injected clock", () => {
  test("security.scan stamps scanned_at_ms from the real clock when ctx.nowMs is absent", async () => {
    const db = openSeededInMemoryDb(TARGET_SCHEMA);
    try {
      seedPlainItems(db, "filesystem", 1);
      const notifications: Array<{ m: string; p: Record<string, unknown> }> = [];
      const before = Date.now();
      const r = await dispatchSecurityRpc(
        "security.scan",
        {},
        { db, notify: (m, p) => notifications.push({ m, p }) },
      );
      if (r.kind !== "hit") throw new Error("expected hit");
      await awaitSecurityScanJob((r.value as { jobId: string }).jobId);
      const after = Date.now();

      const done = notifications.find((n) => n.m === "security.scanDone");
      const stamped = done?.p["scanned_at_ms"];
      expect(typeof stamped).toBe("number");
      expect(stamped as number).toBeGreaterThanOrEqual(before);
      expect(stamped as number).toBeLessThanOrEqual(after);
    } finally {
      db.close();
    }
  });
});
