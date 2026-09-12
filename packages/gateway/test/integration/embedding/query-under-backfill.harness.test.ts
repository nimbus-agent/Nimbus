import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalEmbedder } from "../../../src/embedding/model.ts";
import { SqliteEmbeddingPipeline } from "../../../src/embedding/pipeline.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";

/**
 * Opt-in: `NIMBUS_RUN_EMBED_HARNESS=1 bun test packages/gateway/test/integration/embedding`.
 *
 * Never runs in CI, for two independent reasons: it downloads/loads the real MiniLM model,
 * and it asserts wall-clock latency on a machine whose speed CI does not control.
 *
 * **This measures backfill contention, which is real but is NOT the cause of issue #1396.**
 * `docs/CHANGELOG.md`'s 2026-09-12 entry is explicit: the `index.searchRanked` timeout had been
 * read as embedding-backfill contention, and it was not — the actual defect was a quadratic SQL
 * join plan (fixed by schema V62 + `CROSS JOIN` in `search/vec-store.ts`), which dwarfed
 * contention by four to five orders of magnitude (tens of SECONDS vs single-digit milliseconds).
 * Contention on a query embed alone was measured separately at 2.9x-4.8x over four clean runs
 * (7-9 ms under load vs 2-3 ms idle), but the full observed range across six trials on this
 * hardware was 1.0x-4.8x — machine-dependent. A priority gate for it was deliberately DEFERRED
 * as immaterial beside the SQL defect, not shipped.
 *
 * So this harness asserts no fixed ratio threshold at all — that 1.0x-4.8x range makes any
 * fixed bound (including the `> 2x` this file used to assert) flaky by construction, failing
 * on a legitimately sub-2x machine. It instead records the ratio (logged, not asserted) and
 * proves — the same way `search-under-backfill.harness.test.ts` does — that the backfill was
 * GENUINELY active during the "under load" measurement: still unsettled, and the
 * embedded-row count strictly advanced while the timed call was in flight. Those two checks
 * are what stop this harness passing vacuously for a harness that measured an idle system by
 * mistake; they must not be weakened or removed.
 *
 * There is deliberately NO warmup sleep before the "under load" sample (an earlier draft used
 * a fixed 2-second sleep, which on a fast dev machine let a 5,000-item backfill finish draining
 * before it — the exact `settledBeforeLoad` control above firing as a false negative, not a
 * flaw in the control). `pipeline.backfillAll(cb)` runs SYNCHRONOUSLY up to its first real
 * await, so at the instant this code samples it, zero items have been embedded and the returned
 * promise cannot have settled — both true BY CONSTRUCTION, not by timing luck. See
 * `search-under-backfill.harness.test.ts` for the fuller discussion of this exact tradeoff.
 */
const RUN = process.env["NIMBUS_RUN_EMBED_HARNESS"] === "1";

describe.skipIf(!RUN)("query latency under a saturating backfill (measurement)", () => {
  it("records how long a query embed waits while backfill runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-embed-harness-"));
    try {
      const db = new Database(join(dir, "index.db"));
      try {
        LocalIndex.ensureSchema(db);
        seedItems(db, 5_000);

        const embedder = await createLocalEmbedder({ cacheDir: join(dir, "models") });
        const pipeline = new SqliteEmbeddingPipeline({ db, embedder, backfillConcurrency: 8 });

        let embedded = 0;
        const backfill = pipeline.backfillAll((done) => {
          embedded = done;
        });
        let backfillSettled = false;
        void backfill.then(() => {
          backfillSettled = true;
        });

        // Capture the "still in progress" state IMMEDIATELY, with no warmup sleep — see the
        // docblock above for why a fixed sleep is unreliable on fast hardware and why sampling
        // here is safe by construction regardless.
        const settledBeforeLoad = backfillSettled;
        const embeddedBeforeLoad = embedded;

        const t0 = performance.now();
        await pipeline.embedTexts(["how does the deploy pipeline work"]);
        const underLoadMs = performance.now() - t0;

        const embeddedAfterLoad = embedded;

        // POSITIVE CONTROL. Without an idle baseline from the SAME machine and model,
        // "slow" is unfalsifiable — a big number could just be a slow laptop.
        await backfill;
        const t1 = performance.now();
        await pipeline.embedTexts(["how does the deploy pipeline work"]);
        const idleMs = performance.now() - t1;

        console.log(
          `[harness] query embed: under load ${underLoadMs.toFixed(0)}ms, idle ${idleMs.toFixed(0)}ms, ratio ${(underLoadMs / idleMs).toFixed(1)}x`,
        );

        // POSITIVE CONTROL — this must fail if the harness did not actually create contention,
        // rather than let "no contention observed" be indistinguishable from a harness that
        // measured an idle system. No fixed ratio threshold: the ratio above is recorded for a
        // human to read, not enforced, since the valid range spans 1.0x-4.8x on this hardware
        // alone.
        expect(settledBeforeLoad).toBe(false);
        expect(embeddedAfterLoad).toBeGreaterThan(embeddedBeforeLoad);
      } finally {
        // `close()` in a `finally` so a thrown await (embedTexts, the backfill promise) or a
        // failed assertion above cannot leave the db file handle open — an open handle makes
        // the outer `finally`'s `rmSync` fail with EBUSY on Windows and masks the real error.
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
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
