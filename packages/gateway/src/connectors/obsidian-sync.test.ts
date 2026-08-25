import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
  testConnectorSyncNoop,
} from "./connector-sync-test-helpers.ts";
import { createObsidianSyncable } from "./obsidian-sync.ts";

const FIXTURE_ROOT = join(import.meta.dir, "..", "..", "test", "fixtures", "obsidian");

testConnectorSyncNoop(
  "no-op when no roots configured",
  () => createObsidianSyncable({ roots: [] }),
  EMPTY_NIMBUS_VAULT,
);

test("indexes notes from a fixture vault root", async () => {
  const sync = createObsidianSyncable({
    roots: [
      {
        path: FIXTURE_ROOT,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "obsidian"), null);
  expect(r.itemsUpserted).toBeGreaterThanOrEqual(10);
  const items = db
    .query("SELECT title, type, service FROM item WHERE service = 'obsidian'")
    .all() as Array<{ title: string; type: string; service: string }>;
  expect(items.length).toBeGreaterThanOrEqual(10);
  for (const it of items) {
    expect(it.type).toBe("obsidian_note");
  }
  const shadow = db
    .query("SELECT path, daily_note_date FROM obsidian_notes ORDER BY path")
    .all() as Array<{ path: string; daily_note_date: string | null }>;
  const daily = shadow.find((s) => s.path === "Daily/2026-05-10.md");
  expect(daily?.daily_note_date).toBe("2026-05-10");
});

function buildTempVault(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), "obsidian-sync-tmp-"));
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(join(root, "A.md"), "# A\nlinks to [[B]]");
  writeFileSync(join(root, "B.md"), "# B\nback to [[A]]");
  return { root };
}

test("re-syncing with no file changes upserts zero items", async () => {
  const { root } = buildTempVault();
  const sync = createObsidianSyncable({
    roots: [
      {
        path: root,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r1 = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "obsidian"), null);
  expect(r1.itemsUpserted).toBe(2);
  const r2 = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "obsidian"), r1.cursor);
  expect(r2.itemsUpserted).toBe(0);
});

test("touching a note re-emits only that note", async () => {
  const { root } = buildTempVault();
  const sync = createObsidianSyncable({
    roots: [
      {
        path: root,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r1 = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "obsidian"), null);
  expect(r1.itemsUpserted).toBe(2);
  const future = new Date(Date.now() + 60_000);
  utimesSync(join(root, "A.md"), future, future);
  const r2 = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "obsidian"), r1.cursor);
  expect(r2.itemsUpserted).toBe(1);
});

test("metadata_only depth suppresses note bodies (routed through the depth chokepoint)", async () => {
  const { root } = buildTempVault();
  const sync = createObsidianSyncable({
    roots: [
      {
        path: root,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  // depth goes THROUGH the builder: overriding `.depth` on the result leaves the capability bound
  // to the old value, which is how this test caught a real regression.
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "obsidian", "metadata_only");
  const r = await sync.sync(ctx, null);
  expect(r.itemsUpserted).toBe(2);
  const items = db
    .query("SELECT body, body_preview, body_complete FROM item WHERE service = 'obsidian'")
    .all() as Array<{ body: string | null; body_preview: string | null; body_complete: number }>;
  expect(items).toHaveLength(2);
  for (const it of items) {
    expect(it.body ?? "").toBe("");
    expect(it.body_preview ?? "").toBe("");
    expect(it.body_complete).toBe(0);
  }
});

test("deleting a note removes its row on next sync (sticky delete)", async () => {
  const { root } = buildTempVault();
  const sync = createObsidianSyncable({
    roots: [
      {
        path: root,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r1 = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "obsidian"), null);
  expect(r1.itemsUpserted).toBe(2);
  rmSync(join(root, "B.md"));
  const r2 = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "obsidian"), r1.cursor);
  expect(r2.itemsDeleted).toBe(1);
  const remaining = db.query("SELECT path FROM obsidian_notes ORDER BY path").all() as Array<{
    path: string;
  }>;
  expect(remaining.map((r) => r.path)).toEqual(["A.md"]);
});
