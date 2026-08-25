import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDataProfileSyncable } from "../../../src/connectors/data-profile-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const CURSOR_PREFIX = "nimbus-dataprofile1:";
function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
const PASS_1_CURSOR = encodeCursor({ pass: 1 });

describe("data-profile-sync", () => {
  let fx: ConnectorSyncFixture;
  let dir: string;
  const ensureCalls: number[] = [];

  beforeEach(async () => {
    fx = createConnectorSyncFixture();
    dir = await mkdtemp(join(tmpdir(), "nimbus-dataprofile-test-"));
    ensureCalls.length = 0;
  });
  afterEach(async () => {
    fx.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  function makeSyncable() {
    return createDataProfileSyncable({
      ensureDataprofileMcpRunning: async (): Promise<void> => {
        ensureCalls.push(1);
      },
      // Fake parquet footer reader — no real .parquet file needed.
      readParquetMetadata: async (path) =>
        path.endsWith("orders.parquet")
          ? { schema: [{ name: "root" }, { name: "id", type: "INT64" }], num_rows: 42n }
          : null,
    });
  }

  test("no dir → noop, preserves cursor, still ensures the mesh", async () => {
    const res = await makeSyncable().sync(fx.createSyncContext("dataprofile"), "prev");
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("prev");
    expect(ensureCalls).toHaveLength(1);
  });

  test("profiles csv/jsonl/json/parquet into dataprofile:data_model items (schema only)", async () => {
    await writeFile(join(dir, "people.csv"), "id,name,email\n1,Ada,ada@x\n2,Bob,bob@x\n", "utf8");
    await writeFile(
      join(dir, "events.jsonl"),
      '{"ts":1,"kind":"click"}\n{"ts":2,"kind":"view"}\n',
      "utf8",
    );
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }]),
      "utf8",
    );
    await writeFile(join(dir, "orders.parquet"), "PAR1-not-real-bytes", "utf8");
    await fx.vault.set("dataprofile.dir", dir);

    const res = await makeSyncable().sync(fx.createSyncContext("dataprofile"), null);
    expect(res.itemsUpserted).toBe(4);
    expect(res.cursor).toBe(PASS_1_CURSOR);

    const rows = fx.db
      .query<{ external_id: string; metadata: string; body_preview: string }, []>(
        "SELECT external_id, metadata, body_preview FROM item WHERE service = 'dataprofile' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id).sort((a, b) => a.localeCompare(b))).toEqual([
      "config.json",
      "events.jsonl",
      "orders.parquet",
      "people.csv",
    ]);

    // CSV: column names from header, row estimate = lines - 1 (excludes header).
    const csv = JSON.parse(rows.find((r) => r.external_id === "people.csv")!.metadata) as {
      columns: Array<{ name: string }>;
      rowCountEstimate: number;
    };
    expect(csv.columns.map((c) => c.name)).toEqual(["id", "name", "email"]);
    expect(csv.rowCountEstimate).toBe(2);

    // Parquet: schema from the injected footer metadata.
    const pq = JSON.parse(rows.find((r) => r.external_id === "orders.parquet")!.metadata) as {
      columns: Array<{ name: string; type: string }>;
      rowCountEstimate: number;
    };
    expect(pq.columns).toEqual([{ name: "id", type: "INT64" }]);
    expect(pq.rowCountEstimate).toBe(42);
  });

  test("NEVER indexes cell values — only schema + counts", async () => {
    await writeFile(join(dir, "secret.csv"), "ssn,name\n123-45-6789,Ada\n", "utf8");
    await writeFile(join(dir, "secret.jsonl"), '{"email":"victim@x.com","amount":999}\n', "utf8");
    await fx.vault.set("dataprofile.dir", dir);
    await makeSyncable().sync(fx.createSyncContext("dataprofile"), null);

    const serialized = JSON.stringify(
      fx.db
        .query<{ metadata: string; title: string; body_preview: string }, []>(
          "SELECT metadata, title, body_preview FROM item WHERE service = 'dataprofile'",
        )
        .all(),
    );
    // Column NAMES are present; cell VALUES are not.
    expect(serialized).toContain("ssn");
    expect(serialized).toContain("email");
    expect(serialized).not.toContain("123-45-6789");
    expect(serialized).not.toContain("victim@x.com");
    expect(serialized).not.toContain("Ada");
    expect(serialized).not.toContain("999");
  });

  test("skips non-data files and a parquet the reader can't parse", async () => {
    await writeFile(join(dir, "notes.txt"), "ignore", "utf8");
    await writeFile(join(dir, "bad.parquet"), "x", "utf8"); // reader returns null for non-orders
    await fx.vault.set("dataprofile.dir", dir);
    const res = await makeSyncable().sync(fx.createSyncContext("dataprofile"), null);
    expect(res.itemsUpserted).toBe(0);
  });
});
