import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../../../src/index/sqlite-vec-load.ts";
import {
  dispatchIndexReembedRpc,
  type IndexReembedRpcContext,
} from "../../../src/ipc/index-reembed-rpc.ts";
import { MockVault } from "../../../src/vault/mock.ts";

function vecAvailable(): boolean {
  const d = new Database(":memory:");
  tryLoadSqliteVec(d);
  const ok = isVecLoaded(d);
  d.close();
  return ok;
}
const VEC_AVAILABLE = vecAvailable();

function freshCtx(): {
  db: Database;
  ctx: IndexReembedRpcContext;
  events: Array<{ method: string; params: unknown }>;
  cleanup: () => void;
} {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-reembed-"));
  const db = new Database(join(tmp, "nimbus.db"));
  tryLoadSqliteVec(db);
  runIndexedSchemaMigrations(db, 30);
  const events: Array<{ method: string; params: unknown }> = [];
  const ctx: IndexReembedRpcContext = {
    db,
    vault: new MockVault(),
    paths: { dataDir: tmp },
    logger: pino({ level: "silent" }),
    notify: (method, params) => {
      events.push({ method, params });
    },
  };
  return {
    db,
    ctx,
    events,
    cleanup: () => {
      db.close();
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

function seed(db: Database): void {
  const now = Date.now();
  for (const [id, service, type] of [
    ["s1", "slack", "message"],
    ["s2", "slack", "message"],
    ["g1", "github", "git_commit"],
    ["g2", "github", "git_commit"],
  ] as const) {
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview,
          modified_at, synced_at)
       VALUES (?, ?, ?, ?, 'T', 'B', ?, ?)`,
      [`${service}:${id}`, service, type, id, now, now],
    );
  }
}

describe.skipIf(!VEC_AVAILABLE)("nimbus index reembed — end-to-end", () => {
  test("dry-run on a populated index emits done with planned count", async () => {
    const { db, ctx, events, cleanup } = freshCtx();
    try {
      seed(db);
      const first = await dispatchIndexReembedRpc(
        "index.reembed",
        {
          model: "Xenova/all-MiniLM-L6-v2",
          itemType: "git_commit",
          batchSize: 100,
          dryRun: true,
        },
        ctx,
      );
      expect(first.kind).toBe("hit");
      await new Promise((r) => setTimeout(r, 200));
      const done = events.find((e) => e.method === "index.reembedDone") as
        | { params: { dryRun?: boolean; planned?: number } }
        | undefined;
      expect(done).toBeDefined();
      expect(done?.params.dryRun).toBe(true);
      expect(done?.params.planned).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("openai model without vault key emits reembedError", async () => {
    const { db, ctx, events, cleanup } = freshCtx();
    try {
      seed(db);
      await dispatchIndexReembedRpc(
        "index.reembed",
        { model: "openai:text-embedding-3-small", batchSize: 100 },
        ctx,
      );
      await new Promise((r) => setTimeout(r, 50));
      const err = events.find((e) => e.method === "index.reembedError");
      expect(err).toBeDefined();
      expect((err?.params as { message: string } | undefined)?.message).toMatch(/openai\.api_key/);
    } finally {
      cleanup();
    }
  });
});
