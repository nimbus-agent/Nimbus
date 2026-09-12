import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyWritablePragmas, readJournalMode } from "../../../src/db/writable-pragmas.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { buildVectorChunkQuery, vectorSearchChunks } from "../../../src/search/vec-store.ts";

/**
 * Opt-in: `NIMBUS_RUN_EMBED_HARNESS=1 bun test packages/gateway/test/integration/embedding`.
 *
 * The scaling evidence for the quadratic-plan fix (issue #1396, task 1c). Runs the SHIPPED
 * `vectorSearchChunks` and the VERBATIM pre-fix query against the same database, at two or more
 * corpus sizes, and prints both plus their growth ratios.
 *
 * Never runs in CI: it asserts wall-clock latency on a machine whose speed CI does not control,
 * and the pre-fix leg alone takes tens of seconds at 8,000 items — which is the finding.
 *
 * Unlike `search-under-backfill.harness.test.ts` this needs NO local embedding model. The defect
 * is a query PLAN, so synthetic unit-ish vectors reproduce it exactly and deterministically, and
 * task 1b already established that embed time is under 6ms at every scale — a rounding error
 * beside the numbers below. Sizes come from `NIMBUS_HARNESS_SIZES` (comma-separated, default
 * `1000,4000`); `NIMBUS_HARNESS_SKIP_PREFIX=1` drops the slow before-leg when only the after
 * numbers are wanted.
 */
const RUN = process.env["NIMBUS_RUN_EMBED_HARNESS"] === "1";
const SKIP_PREFIX = process.env["NIMBUS_HARNESS_SKIP_PREFIX"] === "1";
const SIZES: readonly number[] = (() => {
  const raw = (process.env["NIMBUS_HARNESS_SIZES"] ?? "1000,4000")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return raw.length >= 2 ? raw : [1000, 4000];
})();

const DIMS = 384;
const MODEL = "harness:minilm";

/** Deterministic LCG — the same corpus every run, on every platform. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** The pre-fix query, verbatim from `git show c2d00d72:packages/gateway/src/search/vec-store.ts`. */
const PRE_FIX_SQL = `
    SELECT ec.item_id AS itemId, ec.chunk_index AS chunkIndex, ec.chunk_text AS chunkText,
           ec.vec_rowid AS vecRowid, knn.distance AS distance
    FROM (
      SELECT rowid, distance FROM "vec_items_384" WHERE embedding MATCH ? AND k = ?
    ) knn
    INNER JOIN embedding_chunk ec ON ec.vec_rowid = knn.rowid AND ec.model = ?
    INNER JOIN item i ON i.id = ec.item_id
    WHERE 1 = 1
    ORDER BY knn.distance
`;

function seed(db: Database, n: number): void {
  const now = Date.now();
  const r = rng(1234);
  const insItem = db.prepare(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insVec = db.prepare(`INSERT INTO vec_items_384 (rowid, embedding) VALUES (?, vec_f32(?))`);
  const insChunk = db.prepare(
    `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
     VALUES (?, 0, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < n; i += 1) {
      const id = `github:item-${String(i)}`;
      insItem.run(id, "github", "issue", `item-${String(i)}`, `Issue ${String(i)}`, "B", now, now);
      const v = new Float32Array(DIMS);
      for (let d = 0; d < DIMS; d += 1) v[d] = r() * 2 - 1;
      insVec.run(BigInt(i + 1), v);
      insChunk.run(id, `chunk ${String(i)}`, i + 1, MODEL, DIMS, now);
    }
  })();
  // Unfinalized `prepare()` makes `db.close()` a silent no-op, and the temp-dir cleanup then
  // fails with EBUSY on Windows.
  insItem.finalize();
  insVec.finalize();
  insChunk.finalize();
}

function queryVector(): Float32Array {
  const v = new Float32Array(DIMS);
  const r = rng(999);
  for (let d = 0; d < DIMS; d += 1) v[d] = r() * 2 - 1;
  return v;
}

type Measurement = { items: number; fixedMs: number; preFixMs: number | null; rows: number };

function measure(items: number): Measurement {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-vecscale-"));
  try {
    const db = new Database(join(dir, "index.db"));
    // Matches production's `openGatewaySqlite` order (platform/assemble.ts): pragmas BEFORE
    // ensureSchema, since journal_mode is a persistent property of the FILE that the migrations
    // then inherit.
    applyWritablePragmas(db);
    LocalIndex.ensureSchema(db);
    seed(db, items);
    expect(readJournalMode(db)).toBe("wal");

    const q = queryVector();
    const opts = { queryEmbedding: q, model: MODEL, limit: 20 };
    // Warm the page cache before timing either leg.
    const hits = vectorSearchChunks(db, opts);

    // MEDIAN of five, not a single sample: the fixed query lands in low single-digit
    // milliseconds, where one scheduler hiccup is a larger number than the whole measurement.
    // The pre-fix leg below takes tens of seconds and is sampled once — at that magnitude
    // jitter is irrelevant, and a second sample would double the harness's runtime.
    const samples: number[] = [];
    for (let s = 0; s < 5; s += 1) {
      const t0 = performance.now();
      vectorSearchChunks(db, opts);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const fixedMs = samples[2] ?? 0;

    let preFixMs: number | null = null;
    if (!SKIP_PREFIX) {
      const { params } = buildVectorChunkQuery(opts);
      const p0 = performance.now();
      const preRows = db.query(PRE_FIX_SQL).all(...params) as unknown[];
      preFixMs = performance.now() - p0;
      // Same answer, four orders of magnitude apart — the whole claim of this fix in one line.
      expect(preRows).toEqual(hits);
    }
    db.close();
    return { items, fixedMs, preFixMs, rows: hits.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!RUN)("vector search scaling after the join-order fix (measurement)", () => {
  it("stops growing quadratically with corpus size", () => {
    const results = SIZES.map(measure);
    for (const m of results) {
      console.log(
        `[harness] items=${String(m.items)} fixed=${m.fixedMs.toFixed(1)}ms ` +
          `preFix=${m.preFixMs === null ? "skipped" : `${m.preFixMs.toFixed(1)}ms`} ` +
          `rows=${String(m.rows)}`,
      );
    }

    const first = results[0];
    const last = results[results.length - 1];
    if (first === undefined || last === undefined) throw new Error("no measurements");

    // POSITIVE CONTROL: a query that returned nothing would be fast for the wrong reason.
    for (const m of results) expect(m.rows).toBeGreaterThan(0);

    const sizeRatio = last.items / first.items;
    const fixedRatio = last.fixedMs / Math.max(first.fixedMs, 0.001);
    console.log(
      `[harness] size x${sizeRatio.toFixed(1)} -> fixed x${fixedRatio.toFixed(2)} ` +
        `(quadratic would be x${(sizeRatio * sizeRatio).toFixed(1)})`,
    );

    // The defect made cost grow with sizeRatio^2. The bound is deliberately loose — the fixed
    // query lands in single-digit milliseconds, where measurement noise is a large fraction of
    // the number, and the KNN's own brute-force scan is genuinely linear on top of a fixed
    // overhead. Measured exponent on the development machine at x4 size: ~1.3. A bound at
    // exponent 1.7 (x10.6 here) still separates that decisively from quadratic (x16).
    expect(fixedRatio).toBeLessThan(sizeRatio ** 1.7);

    // The claim that actually matters, in absolute terms rather than as a ratio: a single search
    // finishes inside the 30,000ms IPC deadline issue #1396 reported blowing. Not vacuous — the
    // pre-fix query exceeded that bound at 4,000 items on this same machine.
    expect(last.fixedMs).toBeLessThan(30_000);

    if (last.preFixMs !== null) {
      // And the before-leg must actually be catastrophic at the larger size, or this harness is
      // measuring a machine on which the defect never reproduced and proves nothing.
      expect(last.preFixMs / Math.max(last.fixedMs, 0.001)).toBeGreaterThan(20);
    }
  }, 2_400_000);
});
