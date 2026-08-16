import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { applyWritablePragmas } from "../db/writable-pragmas.ts";
import { dbRun } from "../db/write.ts";
import { LocalIndex } from "../index/local-index.ts";
import { readIndexedUserVersion, runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { ensureSqliteVecForConnection } from "../index/sqlite-vec-load.ts";
import { isAcceptableWorkerOrigin } from "../platform/worker-security.ts";
import { EmbeddingWorkerCore, type InitMsg } from "./embedding-worker-core.ts";
import { createLocalEmbedder } from "./model.ts";
import { SqliteEmbeddingPipeline } from "./pipeline.ts";

function sendToMain(data: unknown): void {
  const w = globalThis as unknown as { postMessage?: (d: unknown) => void };
  w.postMessage?.(data);
}

function setupDb(dbPath: string): Database {
  // Named `db`, not `d`: D12's receiver pattern keys on the `db` suffix this repo uses for a
  // `Database` handle, so a one-letter binding is a handle the rule cannot see. Same shape as
  // `index/local-index.ts:279`, which routes the identical PRAGMA through `dbRun`.
  const db = new Database(dbPath);
  applyWritablePragmas(db);
  const dir = dirname(dbPath);
  runIndexedSchemaMigrations(db, LocalIndex.SCHEMA_VERSION, {
    backupDir: join(dir, "backups"),
    dbPath,
  });
  ensureSqliteVecForConnection(db, readIndexedUserVersion(db));
  dbRun(db, "PRAGMA foreign_keys = ON");
  return db;
}

const core = new EmbeddingWorkerCore({
  sendToMain,
  setup: async (msg: InitMsg) => {
    const db = setupDb(msg.dbPath);
    try {
      const embedder = await createLocalEmbedder({
        cacheDir: msg.cacheDir,
        // Forwarded to the bridge so `gateway.ping` can report REAL download progress
        // instead of a generic spinner while the gateway serves everything else (#928).
        onProgress: (p) => {
          sendToMain({
            type: "model_progress",
            file: p.file,
            loadedBytes: p.loadedBytes,
            totalBytes: p.totalBytes,
            percent: p.percent,
          });
        },
      });
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
    } catch (err) {
      // The pipeline was never constructed, so it can't own the handle. Close it
      // here to avoid leaking the SQLite connection on a setup failure.
      db.close();
      throw err;
    }
  },
});

(globalThis as unknown as { onmessage: ((ev: MessageEvent<unknown>) => void) | null }).onmessage = (
  ev: MessageEvent<unknown>,
) => {
  // Origin check is the Worker realm boundary — it stays here, not in the core.
  if (!isAcceptableWorkerOrigin(ev)) {
    return;
  }
  // `ev.data` is untrusted cross-realm input; the core narrows it via `isInMsg`.
  core.handleMessage(ev.data);
};
