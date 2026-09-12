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
 */
const RUN = process.env["NIMBUS_RUN_EMBED_HARNESS"] === "1";

describe.skipIf(!RUN)("query latency under a saturating backfill (measurement)", () => {
  it("records how long a query embed waits while backfill runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-embed-harness-"));
    try {
      const db = new Database(join(dir, "index.db"));
      LocalIndex.ensureSchema(db);
      seedItems(db, 5_000);

      const embedder = await createLocalEmbedder({ cacheDir: join(dir, "models") });
      const pipeline = new SqliteEmbeddingPipeline({ db, embedder, backfillConcurrency: 8 });

      // Start the backfill and let it reach steady state before measuring.
      const backfill = pipeline.backfillAll();
      await Bun.sleep(2_000);

      const t0 = performance.now();
      await pipeline.embedTexts(["how does the deploy pipeline work"]);
      const underLoadMs = performance.now() - t0;

      // POSITIVE CONTROL. Without an idle baseline from the SAME machine and model,
      // "slow" is unfalsifiable — a big number could just be a slow laptop.
      await backfill;
      const t1 = performance.now();
      await pipeline.embedTexts(["how does the deploy pipeline work"]);
      const idleMs = performance.now() - t1;

      console.log(
        `[harness] query embed: under load ${underLoadMs.toFixed(0)}ms, idle ${idleMs.toFixed(0)}ms, ratio ${(underLoadMs / idleMs).toFixed(1)}x`,
      );

      // Close before asserting: an assertion failure must not leave the db file handle open,
      // or the `finally` block's rmSync fails with EBUSY on Windows and masks the real result.
      db.close();

      // The DEFECT assertion: today the loaded case is dramatically worse. This harness
      // exists to make that number real, so it asserts only that the gap is observable.
      expect(underLoadMs).toBeGreaterThan(idleMs * 2);
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
