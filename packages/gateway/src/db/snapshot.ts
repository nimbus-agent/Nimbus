import { Database as BunDatabase, type Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { dbRun } from "./write.ts";

export type SnapshotEntry = {
  path: string;
  filename: string;
  timestampMs: number;
  compressedSizeBytes: number;
};

export type SnapshotConfig = {
  enabled: boolean;
  schedule: string;
  keepLast: number;
  intervalMs: number;
};

export const DEFAULT_SNAPSHOT_CONFIG: SnapshotConfig = {
  enabled: true,
  schedule: "0 2 * * *",
  keepLast: 7,
  intervalMs: 24 * 60 * 60 * 1000, // 24 hours
};

const SNAPSHOTS_DIR_NAME = "snapshots";

function snapshotsDir(dataDir: string): string {
  return join(dataDir, SNAPSHOTS_DIR_NAME);
}

export function takeSnapshot(db: Database, dataDir: string): string {
  const dir = snapshotsDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const timestamp = Date.now();
  const uniq = randomUUID();
  const tmpPath = join(dir, `nimbus-${String(timestamp)}-${uniq}.db`);
  const gzPath = join(dir, `nimbus-${String(timestamp)}.db.gz`);
  const gzPartial = join(dir, `nimbus-${String(timestamp)}-${uniq}.db.gz.partial`);

  dbRun(db, `VACUUM INTO ?`, [tmpPath]);
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    /* best-effort — snapshot still proceeds */
  }

  const raw = readFileSync(tmpPath);
  const compressed = Bun.gzipSync(raw);
  const fd = openSync(gzPartial, "wx", 0o600);
  try {
    writeSync(fd, compressed);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(gzPartial, gzPath);
  } catch {
    rmSync(gzPath, { force: true });
    renameSync(gzPartial, gzPath);
  }

  try {
    rmSync(tmpPath);
  } catch {
    /* non-fatal */
  }

  return gzPath;
}

export function listSnapshots(dataDir: string): SnapshotEntry[] {
  const dir = snapshotsDir(dataDir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const results: SnapshotEntry[] = [];
  for (const name of entries) {
    if (!name.startsWith("nimbus-") || !name.endsWith(".db.gz")) {
      continue;
    }
    const tsStr = name.slice("nimbus-".length, -".db.gz".length);
    const tsMs = Number.parseInt(tsStr, 10);
    if (!Number.isFinite(tsMs)) {
      continue;
    }
    const fullPath = join(dir, name);
    let size = 0;
    try {
      size = statSync(fullPath).size;
    } catch {
      continue;
    }
    results.push({
      path: fullPath,
      filename: name,
      timestampMs: tsMs,
      compressedSizeBytes: size,
    });
  }

  results.sort((a, b) => b.timestampMs - a.timestampMs);
  return results;
}

export type RestorePreview = {
  snapshotTimestampMs: number;
  currentItemCount: number;
  snapshotItemCount: number;
};

export function previewRestore(db: Database, snapshotPath: string): RestorePreview {
  const compressed = readFileSync(snapshotPath);
  const raw = Bun.gunzipSync(compressed);

  const tmpPath = join(dirname(snapshotPath), `.restore-preview-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpPath, raw, { mode: 0o600, flag: "wx" });
    const snapDb = new BunDatabase(tmpPath, { readonly: true });
    let snapCount = 0;
    try {
      const row = snapDb.query("SELECT COUNT(*) as c FROM item").get() as { c: number } | undefined;
      snapCount = row?.c ?? 0;
    } finally {
      snapDb.close();
    }

    let liveCount = 0;
    try {
      const row = db.query("SELECT COUNT(*) as c FROM item").get() as { c: number } | undefined;
      liveCount = row?.c ?? 0;
    } catch {
      /* item table may not exist yet */
    }

    const snapshotTsMatch = /nimbus-(\d+)\.db\.gz/.exec(snapshotPath);
    const tsStr = snapshotTsMatch?.[1] ?? "0";
    const tsMs = Number.parseInt(tsStr, 10);

    return {
      snapshotTimestampMs: Number.isFinite(tsMs) ? tsMs : 0,
      currentItemCount: liveCount,
      snapshotItemCount: snapCount,
    };
  } finally {
    try {
      rmSync(tmpPath);
    } catch {
      /* non-fatal */
    }
  }
}

export function restoreSnapshot(snapshotPath: string, dbPath: string): void {
  const compressed = readFileSync(snapshotPath);
  const raw = Bun.gunzipSync(compressed);
  writeFileSync(dbPath, raw);
}

export function pruneSnapshots(dataDir: string, keepLast: number): number {
  const all = listSnapshots(dataDir);
  const toDelete = all.slice(keepLast);
  let deleted = 0;
  for (const entry of toDelete) {
    try {
      rmSync(entry.path);
      deleted++;
    } catch {
      /* best-effort */
    }
  }
  return deleted;
}

type SnapshotSchedulerHandle = { stop: () => void };

export function startSnapshotScheduler(
  db: Database,
  dataDir: string,
  config: SnapshotConfig,
  runNow = false,
): SnapshotSchedulerHandle {
  if (!config.enabled) {
    return { stop: () => {} };
  }

  function runSnapshot(): void {
    try {
      takeSnapshot(db, dataDir);
      pruneSnapshots(dataDir, config.keepLast);
    } catch {
      /* snapshot errors must not crash the gateway */
    }
  }

  if (runNow) {
    runSnapshot();
  }

  const handle = setInterval(runSnapshot, config.intervalMs);

  return {
    stop(): void {
      clearInterval(handle);
    },
  };
}

function humanBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatSnapshotList(entries: SnapshotEntry[]): string {
  if (entries.length === 0) {
    return "No snapshots found.";
  }
  const header = "FILENAME                                   TIMESTAMP                SIZE";
  const sep = "─".repeat(header.length);
  const rows = entries.map((e) => {
    const dt = new Date(e.timestampMs).toISOString().replace("T", " ").slice(0, 19);
    const size = humanBytes(e.compressedSizeBytes).padStart(8);
    return `${e.filename.padEnd(42)} ${dt}  ${size}`;
  });
  return [header, sep, ...rows].join("\n");
}
