import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyWritablePragmas } from "../../src/db/writable-pragmas.ts";
import { LocalIndex } from "../../src/index/local-index.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../../src/index/sqlite-vec-load.ts";
import { SessionMemoryStore } from "../../src/memory/session-memory-store.ts";
import { vectorSearchChunks } from "../../src/search/vec-store.ts";

/**
 * The number the suite never had: search LATENCY at scale, not quality (`search-quality.test.ts`)
 * and not plain SQL item queries (`item-query-latency.test.ts` / `item-list-query-latency.test.ts`).
 *
 * Both sites here carried the identical defect — the sqlite-vec KNN re-executing once per row on
 * the other side of the join — fixed together in #1500 (`CROSS JOIN`, not `INNER JOIN`, in both
 * `search/vec-store.ts` and `memory/session-memory-store.ts`). Measured on this machine, at the
 * corpus sizes below, with the pre-fix `INNER JOIN` restored by hand: `vectorSearchChunks` took
 * ~29s (the shipped defect measured 26.7s at 4,000 items); `SessionMemoryStore.recall` took
 * ~22s. Both now land in single-digit milliseconds. `EXPLAIN QUERY PLAN` regression tests already
 * pin the join keyword for each query; this file is the number that would have caught the
 * original bug on the PR that introduced it, and would catch a *different* quadratic path that a
 * plan check does not anticipate.
 *
 * Same env var as `item-query-latency.test.ts`: a generous default bound (loose enough that CI
 * runner noise — the project runs 13-18x slower than a dev machine — cannot red it) and a tight
 * one under `NIMBUS_RUN_QUERY_BENCH=1` for local regression hunting.
 */
const TIGHT = process.env["NIMBUS_RUN_QUERY_BENCH"] === "1";
const GENEROUS_BOUND_MS = 2000;

const DIMS = 384;
const MODEL = "bench:minilm";
const RUNS = 20;

function sqliteVecExtensionAvailable(): boolean {
  const probe = new Database(":memory:");
  tryLoadSqliteVec(probe);
  const loaded = isVecLoaded(probe);
  probe.close();
  return loaded;
}
const VEC_AVAILABLE = sqliteVecExtensionAvailable();

/** Deterministic LCG — same corpus, same query, same result on every platform and every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomVector(r: () => number): Float32Array {
  const v = new Float32Array(DIMS);
  for (let d = 0; d < DIMS; d += 1) v[d] = r() * 2 - 1;
  return v;
}

/** FNV-1a-shaped string hash, used only to seed a per-text deterministic vector below. */
function hashSeed(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h || 1;
}

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.95);
  return sorted.at(idx) ?? sorted.at(-1) ?? 0;
}

describe.skipIf(!VEC_AVAILABLE)("vector and session-memory search latency (optional bench)", () => {
  test("vectorSearchChunks p95 stays within a generous bound at 4,000 items", () => {
    const ITEMS = 4000;
    const dir = mkdtempSync(join(tmpdir(), "nimbus-vecbench-"));
    let db: Database | undefined;
    try {
      db = new Database(join(dir, "index.db"));
      applyWritablePragmas(db);
      LocalIndex.ensureSchema(db);
      const now = Date.now();
      const r = rng(42);
      const insItem = db.prepare(
        `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insVec = db.prepare(
        `INSERT INTO vec_items_384 (rowid, embedding) VALUES (?, vec_f32(?))`,
      );
      const insChunk = db.prepare(
        `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
         VALUES (?, 0, ?, ?, ?, ?, ?)`,
      );
      const seedStart = performance.now();
      db.transaction(() => {
        for (let i = 0; i < ITEMS; i += 1) {
          const id = `github:item-${String(i)}`;
          insItem.run(
            id,
            "github",
            "issue",
            `item-${String(i)}`,
            `Issue ${String(i)}`,
            "body",
            now,
            now,
          );
          insVec.run(BigInt(i + 1), randomVector(r));
          insChunk.run(id, `chunk ${String(i)}`, i + 1, MODEL, DIMS, now);
        }
      })();
      const seedMs = performance.now() - seedStart;
      // Unfinalized `prepare()` makes `db.close()` a silent no-op, and temp-dir cleanup then
      // fails with EBUSY on Windows.
      insItem.finalize();
      insVec.finalize();
      insChunk.finalize();
      console.log(
        `[bench] vectorSearchChunks seed: items=${String(ITEMS)} ms=${seedMs.toFixed(1)}`,
      );

      const queryVec = randomVector(rng(999));
      const opts = { queryEmbedding: queryVec, model: MODEL, limit: 20 };
      // Warm the page cache before timing.
      vectorSearchChunks(db, opts);
      const samples: number[] = [];
      let lastHitCount = 0;
      for (let i = 0; i < RUNS; i += 1) {
        const t0 = performance.now();
        const hits = vectorSearchChunks(db, opts);
        samples.push(performance.now() - t0);
        lastHitCount = hits.length;
      }
      const latencyP95 = p95(samples);
      console.log(
        `[bench] vectorSearchChunks p95=${latencyP95.toFixed(2)}ms rows=${String(lastHitCount)}`,
      );

      // Requirement 4, the important one: a fast search that searched nothing is worse than no
      // bench at all. Both the row count AND the corpus size are asserted BEFORE the latency
      // check, and before `db.close()` so a failure here still reports the real reason.
      const chunkCount = db.query(`SELECT COUNT(*) AS n FROM embedding_chunk`).get() as {
        n: number;
      };
      expect(chunkCount.n).toBe(ITEMS);
      expect(lastHitCount).toBe(20);

      db.close();
      db = undefined;

      if (TIGHT) {
        expect(latencyP95).toBeLessThan(150);
      } else {
        expect(latencyP95).toBeLessThan(GENEROUS_BOUND_MS);
      }
    } finally {
      // `close()` before any assertion that can throw (done above); this is the belt-and-braces
      // path for the seed/query code itself throwing before reaching that point.
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("session-memory recall p95 stays within a generous bound with a large background index", async () => {
    const ITEMS = 4000;
    const TURNS = 2000;
    const dir = mkdtempSync(join(tmpdir(), "nimbus-vecbench-session-"));
    let db: Database | undefined;
    try {
      db = new Database(join(dir, "index.db"));
      applyWritablePragmas(db);
      LocalIndex.ensureSchema(db);
      const now = Date.now();
      const r = rng(42);

      // The background index: `session_memory` recall shares `vec_items_384` with
      // `embedding_chunk` (see session-memory-store.ts's own comment on the defect), so the
      // pre-fix cost scaled with the WHOLE index, not the conversation. Seed that background the
      // same way the vectorSearchChunks bench above does.
      const insItem = db.prepare(
        `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insVec = db.prepare(
        `INSERT INTO vec_items_384 (rowid, embedding) VALUES (?, vec_f32(?))`,
      );
      const insChunk = db.prepare(
        `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
         VALUES (?, 0, ?, ?, ?, ?, ?)`,
      );
      const seedStart = performance.now();
      db.transaction(() => {
        for (let i = 0; i < ITEMS; i += 1) {
          const id = `github:item-${String(i)}`;
          insItem.run(
            id,
            "github",
            "issue",
            `item-${String(i)}`,
            `Issue ${String(i)}`,
            "body",
            now,
            now,
          );
          insVec.run(BigInt(i + 1), randomVector(r));
          insChunk.run(id, `chunk ${String(i)}`, i + 1, MODEL, DIMS, now);
        }
      })();
      const seedItemsMs = performance.now() - seedStart;
      insItem.finalize();
      insVec.finalize();
      insChunk.finalize();

      // The session under test, seeded through the real store — same append() path production
      // uses, no embedder required: `embedText` derives a deterministic vector from the text via
      // a seeded LCG rather than calling a model.
      const store = new SessionMemoryStore({
        db,
        dims: DIMS,
        embedText: (text: string) => Promise.resolve(randomVector(rng(hashSeed(text)))),
      });
      const sessionId = "bench-session";
      const seedTurnsStart = performance.now();
      for (let i = 0; i < TURNS; i += 1) {
        // Sequential on purpose: append()'s own transaction must complete (and allocate the
        // next vec rowid) before the next turn is appended.
        await store.append({
          sessionId,
          text: `turn ${String(i)}`,
          role: i % 2 === 0 ? "user" : "assistant",
          createdAt: now + i,
        });
      }
      const seedTurnsMs = performance.now() - seedTurnsStart;
      console.log(
        `[bench] sessionMemory seed: items=${String(ITEMS)} ms=${seedItemsMs.toFixed(1)} ` +
          `turns=${String(TURNS)} ms=${seedTurnsMs.toFixed(1)}`,
      );

      // Query text matches an actual seeded turn's text exactly, so its embedding is bit-identical
      // to that turn's stored vector (distance 0) — the nearest hit is deterministically KNOWN,
      // not just "some row or other", which is what makes the row-count check below non-vacuous.
      const targetText = "turn 3";
      const samples: number[] = [];
      let lastHits: Awaited<ReturnType<typeof store.recall>> = [];
      for (let i = 0; i < RUNS; i += 1) {
        const t0 = performance.now();
        lastHits = await store.recall(sessionId, targetText, 8);
        samples.push(performance.now() - t0);
      }
      const latencyP95 = p95(samples);
      console.log(
        `[bench] sessionMemory.recall p95=${latencyP95.toFixed(2)}ms rows=${String(lastHits.length)}`,
      );

      // Requirement 4: assert the corpus actually seeded to the expected size AND that the
      // search found the turn it should have — not merely "returned something".
      const sessionCount = db.query(`SELECT COUNT(*) AS n FROM session_memory`).get() as {
        n: number;
      };
      expect(sessionCount.n).toBe(TURNS);
      expect(lastHits.length).toBeGreaterThan(0);
      const top = lastHits[0];
      if (top === undefined) throw new Error("expected at least one recall hit");
      expect(top.chunkText).toBe(targetText);
      expect(top.distance).toBeCloseTo(0, 5);

      db.close();
      db = undefined;

      if (TIGHT) {
        expect(latencyP95).toBeLessThan(300);
      } else {
        expect(latencyP95).toBeLessThan(GENEROUS_BOUND_MS);
      }
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
