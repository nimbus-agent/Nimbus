import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { buildItemListSql } from "../../src/index/item-list-query.ts";
import { LocalIndex } from "../../src/index/local-index.ts";

const ROWS = 8000;

describe("item list query latency (optional bench)", () => {
  test("filtered item query stays within a generous bound on a multi-kilobyte index", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    const ins = db.prepare(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, modified_at, synced_at, pinned)
       VALUES (?, 'github', 'pr', ?, 't', '', '', ?, ?, 0)`,
    );
    db.run("BEGIN");
    for (let i = 0; i < ROWS; i++) {
      ins.run(`gh:${String(i)}`, String(i), now, now);
    }
    db.run("COMMIT");

    const { sql, vals } = buildItemListSql({
      services: ["github"],
      types: ["pr"],
      sinceMs: now - 86400000,
      limit: 50,
    });

    const runs = 25;
    const samples: number[] = [];
    for (let r = 0; r < runs; r++) {
      const t0 = performance.now();
      db.query(sql).all(...vals);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const idx = Math.floor(samples.length * 0.95);
    const p95 = samples.at(idx) ?? samples.at(-1) ?? 0;

    if (process.env["NIMBUS_RUN_QUERY_BENCH"] === "1") {
      expect(p95).toBeLessThan(100);
    } else {
      expect(p95).toBeLessThan(500);
    }
  });
});
