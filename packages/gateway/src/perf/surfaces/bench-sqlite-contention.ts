import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BenchRunOptions } from "../types.ts";
import { runWorkerBench } from "../worker-bench.ts";

export interface SqliteContentionRunOptions {
  durationMs?: number;
  WorkerCtor?: typeof Worker;
}

const DEFAULT_DURATION_MS = 5_000;

export const S10_BUSY_RETRIES: { value: number } = { value: 0 };

function workerUrl(name: string): URL {
  return pathToFileURL(resolve(import.meta.dir, `${name}.ts`)) as unknown as URL;
}

export async function runSqliteContentionOnce(
  _opts: BenchRunOptions,
  runOpts: SqliteContentionRunOptions = {},
): Promise<number[]> {
  const durationMs = runOpts.durationMs ?? DEFAULT_DURATION_MS;
  const home = mkdtempSync(join(tmpdir(), "nimbus-bench-s10-"));
  const dbPath = join(home, "nimbus.db");
  try {
    const result = await runWorkerBench({
      workers: [
        { name: "sync", url: workerUrl("sqlite-worker-sync"), config: { batchSize: 100 } },
        { name: "watcher", url: workerUrl("sqlite-worker-watcher"), config: {} },
        { name: "audit", url: workerUrl("sqlite-worker-audit"), config: {} },
      ],
      durationMs,
      sharedDbPath: dbPath,
      ...(runOpts.WorkerCtor !== undefined && { WorkerCtor: runOpts.WorkerCtor }),
    });
    S10_BUSY_RETRIES.value += result.totalBusyRetries;
    return [result.totalThroughputPerSec];
  } finally {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // Windows holds the SQLite file lock briefly after Worker.terminate().
      // Leaving the temp dir is not worth retrying — TMPDIR cleanup catches it.
    }
  }
}
