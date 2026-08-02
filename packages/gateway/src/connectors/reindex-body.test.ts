import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { reindexConnector } from "./reindex.ts";

test("metadata_only depth strips body, body_preview and body_complete together", async () => {
  const raw = new Database(":memory:");
  runIndexedSchemaMigrations(raw, CURRENT_SCHEMA_VERSION);
  upsertIndexedItem(raw, {
    service: "slack",
    type: "message",
    externalId: "1",
    title: "t",
    body: "secret".repeat(500),
    modifiedAt: 1,
    syncedAt: 1,
  });

  const before = raw.query("SELECT body, body_complete FROM item WHERE id='slack:1'").get() as {
    body: string | null;
    body_complete: number;
  };
  expect(before.body).not.toBeNull();
  expect(before.body_complete).toBe(1);

  await reindexConnector({
    index: { rawDb: raw, recordAudit: () => undefined } as never,
    service: "slack",
    depth: "metadata_only",
  });

  const after = raw
    .query("SELECT body, body_preview, body_complete FROM item WHERE id='slack:1'")
    .get() as { body: string | null; body_preview: string | null; body_complete: number };

  expect(after.body).toBeNull();
  expect(after.body_preview).toBeNull();
  expect(after.body_complete).toBe(0);
  raw.close();
});
