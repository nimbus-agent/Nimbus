import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import type { SqliteEmbeddingPipeline } from "./pipeline.ts";
import { isProseHeavy, PROSE_HEAVY_TYPES } from "./routing.ts";
import type { EmbeddingPipeline, IndexedItem } from "./types.ts";

export class RoutingEmbeddingPipeline implements EmbeddingPipeline {
  constructor(
    private readonly db: Database,
    private readonly local: SqliteEmbeddingPipeline,
    private readonly openai: SqliteEmbeddingPipeline,
  ) {}

  async embedItem(item: IndexedItem): Promise<void> {
    const target = isProseHeavy(item.service, item.type) ? this.openai : this.local;
    await target.embedItem(item);
  }

  async deleteItemEmbeddings(itemId: string): Promise<void> {
    dbRun(this.db, `DELETE FROM embedding_chunk WHERE item_id = ?`, [itemId]);
  }

  /**
   * Two sequential passes, reported as ONE. Each half counts from zero against its own total, so
   * forwarding both callbacks unchanged made `done` jump backwards when the second half started.
   * The second half's figures are offset by the first half's final ones.
   *
   * The consequence a reader should know: while the first half runs, `total` covers only that half
   * and grows when the second begins. The alternative — counting both totals up front — would run
   * the second half's `COUNT(*)` before its rows are the ones being embedded, and that count is
   * what the first half may still change.
   */
  async backfillAll(onProgress?: (done: number, total: number) => void): Promise<void> {
    const proseKeys = Array.from(PROSE_HEAVY_TYPES);
    let base = { done: 0, total: 0 };
    await this.openai.backfillForRoutingKeys({ in: proseKeys }, (done, total) => {
      base = { done, total };
      onProgress?.(done, total);
    });
    const offset = base;
    await this.local.backfillForRoutingKeys({ notIn: proseKeys }, (done, total) => {
      onProgress?.(offset.done + done, offset.total + total);
    });
  }
}
