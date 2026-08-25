import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocaldbSyncable } from "../../../src/connectors/localdb-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const CURSOR_PREFIX = "nimbus-localdb1:";
function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
const PASS_1_CURSOR = encodeCursor({ pass: 1 });

describe("localdb-sync", () => {
  let fx: ConnectorSyncFixture;
  let dir: string;
  const ensureCalls: number[] = [];

  beforeEach(async () => {
    fx = createConnectorSyncFixture();
    dir = await mkdtemp(join(tmpdir(), "nimbus-localdb-test-"));
    ensureCalls.length = 0;
  });
  afterEach(async () => {
    fx.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  function makeSyncable() {
    return createLocaldbSyncable({
      ensureLocaldbMcpRunning: async (): Promise<void> => {
        ensureCalls.push(1);
      },
    });
  }

  test("no scripts_dir → noop, preserves cursor, still ensures the mesh", async () => {
    const res = await makeSyncable().sync(fx.createSyncContext("localdb"), "prev");
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("prev");
    expect(ensureCalls).toHaveLength(1);
  });

  test("walks .sql files recursively and upserts one localdb:saved_query each", async () => {
    await writeFile(join(dir, "a.sql"), "SELECT * FROM orders;", "utf8");
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(join(dir, "nested", "b.sql"), "SELECT id FROM customers;", "utf8");
    await writeFile(join(dir, "notes.txt"), "ignore me", "utf8");
    await writeFile(join(dir, "empty.sql"), "   \n", "utf8");
    await fx.vault.set("localdb.scripts_dir", dir);

    const res = await makeSyncable().sync(fx.createSyncContext("localdb"), null);
    expect(res.itemsUpserted).toBe(2);
    expect(res.cursor).toBe(PASS_1_CURSOR);

    const rows = fx.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'localdb' ORDER BY external_id",
      )
      .all();
    expect(rows).toHaveLength(2);
    const tables = rows
      .flatMap((r) => (JSON.parse(r.metadata) as { tables: string[] }).tables)
      .sort((a, b) => a.localeCompare(b));
    expect(tables).toEqual(["customers", "orders"]);
  });

  test("indexes the SQL text as the body preview for semantic recall", async () => {
    await writeFile(
      join(dir, "join.sql"),
      "SELECT * FROM orders o JOIN customers c ON o.c=c.id;",
      "utf8",
    );
    await fx.vault.set("localdb.scripts_dir", dir);
    await makeSyncable().sync(fx.createSyncContext("localdb"), null);
    const row = fx.db
      .query<{ body_preview: string }, []>(
        "SELECT body_preview FROM item WHERE service = 'localdb'",
      )
      .get();
    expect(row?.body_preview).toContain("JOIN customers");
  });

  test("a missing dir → success with zero upserts (unreadable dir skipped)", async () => {
    await fx.vault.set("localdb.scripts_dir", join(dir, "does-not-exist"));
    const res = await makeSyncable().sync(fx.createSyncContext("localdb"), null);
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
  });
});
