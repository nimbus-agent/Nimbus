import { expect, test } from "bun:test";
import { join } from "node:path";
import type { ConnectorServiceId } from "../../../src/connectors/connector-catalog.ts";

import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "../../../src/connectors/connector-sync-test-helpers.ts";
import { createObsidianSyncable } from "../../../src/connectors/obsidian-sync.ts";

const FIX_ROOT = join(import.meta.dir, "..", "..", "fixtures", "obsidian");

test("e2e: fixture vault produces queryable obsidian_note rows + daily-note flagged", async () => {
  const sync = createObsidianSyncable({
    roots: [
      {
        path: FIX_ROOT,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: false,
        mediaIndex: false,
        exclude: [],
      },
    ],
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(
    syncTestContext(
      db,
      EMPTY_NIMBUS_VAULT,
      sync.serviceId as ConnectorServiceId,
      sync.serviceId as ConnectorServiceId,
    ),
    null,
  );
  expect(r.itemsUpserted).toBeGreaterThanOrEqual(10);

  const byType = db.query("SELECT COUNT(*) AS n FROM item WHERE type = 'obsidian_note'").get() as {
    n: number;
  };
  expect(byType.n).toBeGreaterThanOrEqual(10);

  const daily = db
    .query("SELECT path FROM obsidian_notes WHERE daily_note_date = '2026-05-10'")
    .all() as Array<{ path: string }>;
  expect(daily).toHaveLength(1);
  expect(daily[0]?.path).toBe("Daily/2026-05-10.md");

  const ftsHits = db
    .query(
      "SELECT COUNT(*) AS n FROM item WHERE rowid IN (SELECT rowid FROM item_fts WHERE item_fts MATCH ?)",
    )
    .get("Welcome") as { n: number };
  expect(ftsHits.n).toBeGreaterThanOrEqual(1);
});
