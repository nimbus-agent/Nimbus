import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { type LocalDbQueryInput, mapLocalDbQueryToItem } from "./localdb-query-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

// Local-only filesystem connector: indexes saved `.sql` files from a local DB
// tool's scripts/console dir (DBeaver/DataGrip/pgAdmin). No network, no DB conn.
const SERVICE_ID = "localdb";
const CURSOR_PREFIX = "nimbus-localdb1:";

// Walk caps — a bad/oversized/unreadable file is skipped, never fatal.
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WALK_DEPTH = 12;

type LocalDbCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies LocalDbCursorV1);
}

export type LocalDbSyncableOptions = {
  ensureLocaldbMcpRunning: () => Promise<void>;
};

async function loadScriptsDir(ctx: SyncContext): Promise<string | null> {
  const raw = (await ctx.getSecret("scripts_dir"))?.trim() ?? "";
  return raw === "" ? null : resolve(raw);
}

async function collectSqlFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH || found.length >= MAX_FILES) {
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) {
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".sql")) {
        found.push(full);
      }
    }
  }
  await walk(root, 0);
  return found;
}

async function readSqlFile(path: string, root: string): Promise<LocalDbQueryInput | null> {
  try {
    const buf = await readFile(path);
    if (buf.byteLength > MAX_FILE_BYTES) {
      return null;
    }
    const sql = buf.toString("utf8");
    if (sql.trim() === "") {
      return null;
    }
    let modifiedAtMs: number | null = null;
    try {
      const info = await stat(path);
      modifiedAtMs = Number.isFinite(info.mtimeMs) ? info.mtimeMs : null;
    } catch {
      modifiedAtMs = null;
    }
    return {
      relativePath: relative(root, path),
      sizeBytes: buf.byteLength,
      modifiedAtMs,
      sql,
    };
  } catch {
    return null; // missing / oversized / unreadable — skip, never throw
  }
}

export function createLocaldbSyncable(options: LocalDbSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureLocaldbMcpRunning();

      const dir = await loadScriptsDir(ctx);
      if (dir === null) {
        return syncNoopResult(cursor, t0);
      }

      await ctx.rateLimiter.acquire("filesystem");
      const now = Date.now();
      const files = await collectSqlFiles(dir);
      let upserted = 0;
      for (const file of files) {
        const input = await readSqlFile(file, dir);
        if (input === null) {
          continue;
        }
        const mapped = mapLocalDbQueryToItem(input, { syncedAt: now });
        if (mapped !== null) {
          upsertIndexedItemForSync(ctx, mapped);
          upserted += 1;
        }
      }

      return syncPassCursorSuccess(t0, 0, pass1Cursor(), upserted);
    },
  };
}
