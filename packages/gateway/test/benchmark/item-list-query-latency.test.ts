import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { buildItemListSql } from "../../src/index/item-list-query.ts";
import { LocalIndex } from "../../src/index/local-index.ts";

const ROWS = process.env.CI === "true" ? 15_000 : 25_000;
const MAX_MS = process.env.CI === "true" ? 120 : 100;

describe("item list query latency", () => {
  test(`buildItemListSql + SELECT stays under ${String(MAX_MS)}ms for ${String(ROWS)} rows`, () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    const svc = "github";
    const ty = "pr";
    db.run("BEGIN IMMEDIATE");
    const stmt = db.prepare(
      `INSERT INTO item (id, service, type, title, body_preview, modified_at, synced_at, external_id)
       VALUES (?, ?, ?, ?, '', ?, ?, ?)`,
    );
    for (let i = 0; i < ROWS; i += 1) {
      const id = `${svc}:${i}`;
      stmt.run(id, svc, ty, `title-${String(i)}`, now, now, String(i));
    }
    db.run("COMMIT");

    const { sql, vals } = buildItemListSql({
      services: [svc],
      types: [ty],
      limit: 100,
      ...(now - 86_400_000 > 0 ? { sinceMs: now - 86_400_000 } : {}),
    });
    const t0 = performance.now();
    const rows = db.query(sql).all(...vals) as { id?: string }[];
    const ms = performance.now() - t0;
    expect(rows.length).toBeLessThanOrEqual(100);
    expect(ms).toBeLessThan(MAX_MS);
  });
});
