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

  async backfillAll(onProgress?: (done: number, total: number) => void): Promise<void> {
    const proseKeys = Array.from(PROSE_HEAVY_TYPES);
    await this.openai.backfillForRoutingKeys({ in: proseKeys }, onProgress);
    await this.local.backfillForRoutingKeys({ notIn: proseKeys }, onProgress);
  }
}
