import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyWritablePragmas, readJournalMode } from "../../../src/db/writable-pragmas.ts";
import { createLocalEmbedder } from "../../../src/embedding/model.ts";
import { SqliteEmbeddingPipeline } from "../../../src/embedding/pipeline.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";

/**
 * Opt-in: `NIMBUS_RUN_EMBED_HARNESS=1 bun test packages/gateway/test/integration/embedding`.
 *
 * Never runs in CI, for the same two reasons as
 * `query-under-backfill.harness.test.ts`: it needs the real MiniLM model on disk and it
 * asserts wall-clock latency on a machine whose speed CI does not control.
 *
 * Unlike that harness (which measures `embedTexts()` alone), this one measures the layer
 * the reported failure actually traverses: `LocalIndex.searchRankedAsync` end to end --
 * query embed *plus* hybrid BM25 + vector search over the whole index -- while
 * `backfillAll()` is concurrently writing `embedding_chunk` / `vec_items_384` rows to the
 * same database. Item count comes from `NIMBUS_HARNESS_ITEMS` (default 20000) so the same
 * file re-runs at report scale (60000) without editing it.
 *
 * Fidelity note (see the task report for the full discussion): this harness runs the
 * backfill and the search on ONE `Database` connection in ONE JS thread, matching the
 * existing pattern in this repo's own integration tests (`query-under-backfill.harness
 * .test.ts`, `filesystem-v2-semantic-search.integration.test.ts`). Production instead runs
 * the backfill inside a separate Bun `Worker` with its OWN connection to the same file
 * (`embedding-worker.ts`), so genuine cross-thread SQLite lock contention is a real
 * possibility production has that this single-threaded harness structurally cannot
 * reproduce. What this harness DOES measure faithfully is the raw cost of the hybrid query
 * itself against a database of the reported size while writes are genuinely interleaved
 * with it (proven below, not assumed).
 */
const RUN = process.env["NIMBUS_RUN_EMBED_HARNESS"] === "1";
const ITEM_COUNT = (() => {
  const raw = Number.parseInt(process.env["NIMBUS_HARNESS_ITEMS"] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
})();

// Shares real lexical terms with the seeded body text (see seedItems) so BM25 has genuine
// candidates -- every seeded item's body_preview matches this query via FTS5 prefix match.
const QUERY_TEXT = "deploy rollback";

describe.skipIf(!RUN)("end-to-end search latency under a saturating backfill (measurement)", () => {
  it("records how long searchRankedAsync waits, split into embed and SQL, while backfill runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-search-harness-"));
    try {
      const db = new Database(join(dir, "index.db"));
      let idx: LocalIndex | undefined;
      try {
        // Matches production's `openGatewaySqlite` order exactly (platform/assemble.ts):
        // pragmas BEFORE ensureSchema, since journal_mode is a persistent property of the
        // file that migrations then inherit. Without this the harness measures the wrong
        // regime -- the default rollback journal blocks readers behind writers outright,
        // which no real gateway handle ever runs with.
        applyWritablePragmas(db);
        LocalIndex.ensureSchema(db);
        seedItems(db, ITEM_COUNT);

        const embedder = await createLocalEmbedder({ cacheDir: join(dir, "models") });
        const pipeline = new SqliteEmbeddingPipeline({ db, embedder, backfillConcurrency: 8 });
        const model = pipeline.embeddingModel;

        // Captures the duration of the embed call `searchRankedAsync` makes INTERNALLY via
        // this seam, updated on every `embedQueryDual` invocation. Reading it immediately
        // after a `searchRankedAsync` call isolates the embed leg of THAT call, so
        // `sqlMs = totalMs - lastEmbedMs` is an honest split rather than a subtraction of two
        // separately-timed calls that concurrent backfill can skew apart (a prior version of
        // this harness timed a SEPARATE post-hoc `embedTexts` call, which does not measure
        // the embed the search itself performed and can make the derived SQL time go
        // negative).
        let lastEmbedMs = 0;

        // The seam LocalIndex needs to take the hybrid path -- backed by the SAME
        // pipeline instance the backfill drives, so one embedder answers both roles,
        // exactly as the production embedding worker does for its own `embed_texts`
        // request versus its own `backfillAll` loop.
        idx = new LocalIndex(db, {
          semanticSearch: {
            model,
            embedQuery: async (text) => {
              const t0 = performance.now();
              const [v] = await pipeline.embedTexts([text]);
              lastEmbedMs = performance.now() - t0;
              return v ?? null;
            },
            embedQueryDual: async (text) => {
              const t0 = performance.now();
              const [v] = await pipeline.embedTexts([text]);
              lastEmbedMs = performance.now() - t0;
              return {
                vec384: v ?? null,
                vec1536: null,
                model384: v !== undefined ? model : null,
                model1536: null,
              };
            },
          },
        });

        let embedded = 0;
        const backfill = pipeline.backfillAll((done) => {
          embedded = done;
        });
        let backfillSettled = false;
        void backfill.then(() => {
          backfillSettled = true;
        });

        // Capture the "still in progress" state IMMEDIATELY, with no warmup sleep at all --
        // deliberately different from query-under-backfill.harness.test.ts's fixed 2s
        // warmup, and from an earlier draft of this file that polled for 25% progress
        // before measuring. Both fixed-delay and percentage-based warmups turned out to be
        // unreliable here for the same underlying reason (see the task report): once the
        // local embedder is warm, this codebase's measured throughput can finish embedding
        // several thousand items in under a second, so ANY non-trivial warmup risks the
        // backfill having ALREADY drained by the time this code samples it -- the report's
        // `settledBeforeLoad` assert firing is exactly that failure mode, caught rather than
        // papered over.
        //
        // No warmup is needed for correctness: `pipeline.backfillAll(cb)` runs
        // SYNCHRONOUSLY up to its first real await (the native embed() call inside the
        // first batch's workers), so at the instant this line runs, zero items have been
        // embedded and the returned promise cannot have settled -- both true BY
        // CONSTRUCTION, not by timing luck. What this trades away, and what the report
        // states plainly: sampled this early, the vec table itself is still near-empty, so
        // the "under load" number below measures a genuinely small index, not a large one
        // under contention. The idle measurement -- taken after a full drain, over the SAME
        // fully-seeded database -- is the number that carries the corpus-scale story; see
        // the report for why a large, mid-backfill, GENUINELY-contended search is not
        // reproducible by simple polling on this machine.
        const settledBeforeLoad = backfillSettled;
        const embeddedBeforeLoad = embedded;

        const loadT0 = performance.now();
        const underLoadResults = await idx.searchRankedAsync(
          { name: QUERY_TEXT, limit: 20 },
          { semantic: true },
        );
        const underLoadTotalMs = performance.now() - loadT0;
        // Captured from the embed `searchRankedAsync` itself just performed via the seam
        // above -- not a separate post-hoc call -- so it isolates THIS call's embed leg
        // even though concurrent backfill can change embed latency between two calls made
        // at different times.
        const underLoadEmbedMs = lastEmbedMs;

        const embeddedAfterLoad = embedded;

        // ---- IDLE BASELINE ----
        // POSITIVE CONTROL: without this, "slow" is unfalsifiable -- a big number could
        // just be a slow machine, not contention.
        await backfill;

        const idleT0 = performance.now();
        const idleResults = await idx.searchRankedAsync(
          { name: QUERY_TEXT, limit: 20 },
          { semantic: true },
        );
        const idleTotalMs = performance.now() - idleT0;
        const idleEmbedMs = lastEmbedMs;

        const underLoadSqlMs = underLoadTotalMs - underLoadEmbedMs;
        const idleSqlMs = idleTotalMs - idleEmbedMs;
        const journalMode = readJournalMode(db);

        console.log(
          `[harness] items=${String(ITEM_COUNT)} search: under load ${underLoadTotalMs.toFixed(0)}ms ` +
            `(embed ${underLoadEmbedMs.toFixed(0)}ms / sql ${underLoadSqlMs.toFixed(0)}ms), ` +
            `idle ${idleTotalMs.toFixed(0)}ms (embed ${idleEmbedMs.toFixed(0)}ms / sql ${idleSqlMs.toFixed(0)}ms)`,
        );
        console.log(
          `[harness] items=${String(ITEM_COUNT)} journal_mode=${journalMode}, ` +
            `underLoadResults=${String(underLoadResults.length)}, idleResults=${String(idleResults.length)}`,
        );

        // POSITIVE CONTROL -- this must fail if the harness did not actually create
        // contention, rather than let a "no contention observed" result be
        // indistinguishable from a harness that measured an idle system.
        //
        // The backfill must not have finished before the under-load measurement started...
        expect(settledBeforeLoad).toBe(false);
        // ...and the embedded-row count must have advanced strictly DURING the call being
        // timed (searchRankedAsync, embed leg included via the seam above), proving the
        // backfill was actively writing to the database while the search was reading from
        // it, not merely running before or after the measurement window.
        expect(embeddedAfterLoad).toBeGreaterThan(embeddedBeforeLoad);
        // Sanity: the query must have actually produced real hybrid results in both
        // regimes, not an empty fallback that would make the timing meaningless.
        expect(underLoadResults.length).toBeGreaterThan(0);
        expect(idleResults.length).toBeGreaterThan(0);
      } finally {
        // `close()` in a `finally` so a thrown await (searchRankedAsync, the backfill
        // promise, embedTexts inside the seam) or a failed assertion above cannot leave the
        // db file handle open -- an open handle makes the outer `finally`'s `rmSync` fail
        // with EBUSY on Windows and masks the real error
        // (query-under-backfill.harness.test.ts's own lesson). `idx` may not exist yet if
        // schema setup or seeding itself threw, so fall back to closing the raw handle.
        if (idx !== undefined) {
          idx.close();
        } else {
          db.close();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 2_400_000);
});

function seedItems(db: Database, n: number): void {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < n; i += 1) {
      const externalId = `item-${String(i)}`;
      insert.run(
        `github:${externalId}`,
        "github",
        "issue",
        externalId,
        `Issue ${String(i)}`,
        `Body text ${String(i)} about deploys and rollbacks.`,
        now,
        now,
      );
    }
  });
  tx();
  insert.finalize();
}
