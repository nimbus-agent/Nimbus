import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createAthenaSyncable, type RunAwsCli } from "../../../src/connectors/athena-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const CURSOR_PREFIX = "nimbus-athena1:";

function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
const PASS_1_CURSOR = encodeCursor({ pass: 1 });

const ENSURE = { ensureAthenaMcpRunning: async (): Promise<void> => {} };

/** Build a runAwsCli stub that returns canned JSON keyed by the first CLI subcommand. */
function makeRunner(responses: Record<string, { ok?: boolean; body?: unknown }[]>): {
  run: RunAwsCli;
  calls: string[][];
} {
  const calls: string[][] = [];
  const cursors: Record<string, number> = {};
  const run: RunAwsCli = async (_ctx, args) => {
    calls.push(args);
    // args are passed to `aws <args> --output json`, so the Athena subcommand is
    // args[1] (args[0] is the literal "athena").
    const cmd = args[1] ?? "";
    const seq = responses[cmd] ?? [];
    const i = cursors[cmd] ?? 0;
    cursors[cmd] = i + 1;
    const r = seq[Math.min(i, seq.length - 1)] ?? { ok: true, body: {} };
    const ok = r.ok ?? true;
    return { ok, text: ok ? JSON.stringify(r.body ?? {}) : "" };
  };
  return { run, calls };
}

async function seedAwsCreds(fx: ConnectorSyncFixture): Promise<void> {
  await fx.vault.set("aws.access_key_id", "AKIA-stub");
  await fx.vault.set("aws.secret_access_key", "secret-stub");
  await fx.vault.set("aws.default_region", "us-east-1");
}

describe("athena-sync — credential short-circuit", () => {
  let fx: ConnectorSyncFixture;
  beforeEach(() => {
    fx = createConnectorSyncFixture();
  });
  afterEach(() => fx.cleanup());

  test("no aws vault keys → noop, runner never called, cursor preserved", async () => {
    const { run, calls } = makeRunner({});
    const res = await createAthenaSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("athena"),
      "prev",
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("prev");
    expect(calls).toHaveLength(0);
  });

  test("ak + sk but no region/profile → noop", async () => {
    await fx.vault.set("aws.access_key_id", "AKIA");
    await fx.vault.set("aws.secret_access_key", "S");
    const { run, calls } = makeRunner({});
    await createAthenaSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("athena"),
      null,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("athena-sync — metadata walk", () => {
  let fx: ConnectorSyncFixture;
  beforeEach(async () => {
    fx = createConnectorSyncFixture();
    await seedAwsCreds(fx);
  });
  afterEach(() => fx.cleanup());

  test("walks catalogs → databases → tables and upserts table metadata", async () => {
    const { run, calls } = makeRunner({
      "list-data-catalogs": [
        { body: { DataCatalogsSummary: [{ CatalogName: "AwsDataCatalog", Type: "GLUE" }] } },
      ],
      "list-databases": [{ body: { DatabaseList: [{ Name: "analytics" }] } }],
      "list-table-metadata": [
        {
          body: {
            TableMetadataList: [
              {
                Name: "events",
                TableType: "EXTERNAL_TABLE",
                Columns: [{ Name: "id", Type: "string" }],
              },
              { Name: "users", Columns: [{ Name: "uid", Type: "bigint" }] },
            ],
          },
        },
      ],
    });
    const res = await createAthenaSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("athena"),
      null,
    );
    expect(res.itemsUpserted).toBe(2);
    expect(res.cursor).toBe(PASS_1_CURSOR);
    expect(res.hasMore).toBe(false);

    // list-data-catalogs is the first call.
    expect(calls[0]?.[1]).toBe("list-data-catalogs");
    // list-table-metadata carries the catalog + database names.
    const tableCall = calls.find((c) => c[1] === "list-table-metadata");
    expect(tableCall).toContain("AwsDataCatalog");
    expect(tableCall).toContain("analytics");

    const rows = fx.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'athena' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual([
      "AwsDataCatalog/analytics.events",
      "AwsDataCatalog/analytics.users",
    ]);
  });

  test("first-page list-data-catalogs failure → parse-empty pass cursor, 0 upserts", async () => {
    const { run } = makeRunner({ "list-data-catalogs": [{ ok: false }] });
    const res = await createAthenaSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("athena"),
      null,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
  });

  test("paginates catalogs via NextToken", async () => {
    const { run, calls } = makeRunner({
      "list-data-catalogs": [
        { body: { DataCatalogsSummary: [{ CatalogName: "c1" }], NextToken: "tok-2" } },
        { body: { DataCatalogsSummary: [{ CatalogName: "c2" }] } },
      ],
      "list-databases": [{ body: { DatabaseList: [] } }],
    });
    await createAthenaSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("athena"),
      null,
    );
    const catalogCalls = calls.filter((c) => c[1] === "list-data-catalogs");
    expect(catalogCalls).toHaveLength(2);
    expect(catalogCalls[1]).toContain("--next-token");
    expect(catalogCalls[1]).toContain("tok-2");
  });

  test("paginates table metadata within a database via NextToken", async () => {
    const { run, calls } = makeRunner({
      "list-data-catalogs": [{ body: { DataCatalogsSummary: [{ CatalogName: "cat" }] } }],
      "list-databases": [{ body: { DatabaseList: [{ Name: "db" }] } }],
      "list-table-metadata": [
        { body: { TableMetadataList: [{ Name: "t1" }], NextToken: "next" } },
        { body: { TableMetadataList: [{ Name: "t2" }] } },
      ],
    });
    const res = await createAthenaSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("athena"),
      null,
    );
    expect(res.itemsUpserted).toBe(2);
    const tableCalls = calls.filter((c) => c[1] === "list-table-metadata");
    expect(tableCalls).toHaveLength(2);
    expect(tableCalls[1]).toContain("--next-token");
    expect(tableCalls[1]).toContain("next");
  });

  test("a database list failure mid-walk does not abort the catalog walk", async () => {
    const { run } = makeRunner({
      "list-data-catalogs": [{ body: { DataCatalogsSummary: [{ CatalogName: "cat" }] } }],
      // database list fails on the first (and only) page → no databases, 0 tables.
      "list-databases": [{ ok: false }],
    });
    const res = await createAthenaSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("athena"),
      null,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
    expect(res.hasMore).toBe(false);
  });

  test("emits no notifications and reports bytesTransferred", async () => {
    const { run } = makeRunner({
      "list-data-catalogs": [{ body: { DataCatalogsSummary: [{ CatalogName: "cat" }] } }],
      "list-databases": [{ body: { DatabaseList: [{ Name: "db" }] } }],
      "list-table-metadata": [{ body: { TableMetadataList: [{ Name: "t" }] } }],
    });
    const res = await createAthenaSyncable({ ...ENSURE, runAwsCli: run }).sync(
      fx.createSyncContext("athena"),
      null,
    );
    expect(fx.notifications.emitted).toHaveLength(0);
    expect(res.bytesTransferred).toBeGreaterThan(0);
  });
});
