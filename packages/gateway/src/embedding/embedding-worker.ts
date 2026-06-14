import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { LocalIndex } from "../index/local-index.ts";
import { readIndexedUserVersion, runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { ensureSqliteVecForConnection } from "../index/sqlite-vec-load.ts";
import { isAcceptableWorkerOrigin } from "../platform/worker-security.ts";
import { EmbeddingWorkerCore, type InitMsg, type InMsg } from "./embedding-worker-core.ts";
import { createLocalEmbedder } from "./model.ts";
import { SqliteEmbeddingPipeline } from "./pipeline.ts";

function sendToMain(data: unknown): void {
  const w = globalThis as unknown as { postMessage?: (d: unknown) => void };
  w.postMessage?.(data);
}

function setupDb(dbPath: string): Database {
  const d = new Database(dbPath);
  d.run("PRAGMA busy_timeout = 8000");
  const dir = dirname(dbPath);
  runIndexedSchemaMigrations(d, LocalIndex.SCHEMA_VERSION, {
    backupDir: join(dir, "backups"),
    dbPath,
  });
  ensureSqliteVecForConnection(d, readIndexedUserVersion(d));
  d.run("PRAGMA foreign_keys = ON");
  return d;
}

const core = new EmbeddingWorkerCore({
  sendToMain,
  setup: async (msg: InitMsg) => {
    const db = setupDb(msg.dbPath);
    const embedder = await createLocalEmbedder({ cacheDir: msg.cacheDir });
    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder,
      backfillBatchSize: msg.toml.backfillBatchSize,
      chunkOptions: {
        maxChunkTokens: msg.toml.chunkTokens,
        overlapTokens: msg.toml.chunkOverlapTokens,
      },
    });
    return { db, pipeline };
  },
});

(globalThis as unknown as { onmessage: ((ev: MessageEvent<InMsg>) => void) | null }).onmessage = (
  ev: MessageEvent<InMsg>,
) => {
  // Origin check is the Worker realm boundary — it stays here, not in the core.
  if (!isAcceptableWorkerOrigin(ev)) {
    return;
  }
  core.handleMessage(ev.data);
};
