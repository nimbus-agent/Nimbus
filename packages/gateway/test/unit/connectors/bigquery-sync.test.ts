import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createBigquerySyncable } from "../../../src/connectors/bigquery-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const CRED_PATH = "/var/secrets/gcp-stub-credentials.json";
const PROJECT_ID = "my-project";
const CURSOR_PREFIX = "nimbus-bq1:";

function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
const PASS_1_CURSOR = encodeCursor({ pass: 1 });

const STUB_TOKEN = "ya29.stub-access-token";
const tokenOk = async (): Promise<string | null> => STUB_TOKEN;
const tokenFail = async (): Promise<string | null> => null;

function makeOptions(mint = tokenOk) {
  return {
    ensureBigqueryMcpRunning: async (): Promise<void> => {},
    mintAccessToken: mint,
  };
}

const DATASETS_URL = /\/datasets\?/;
function tablesUrl(dataset: string): RegExp {
  return new RegExp(String.raw`/datasets/${dataset}/tables\?`);
}
function tableDetailUrl(dataset: string, table: string): RegExp {
  return new RegExp(`/datasets/${dataset}/tables/${table}$`);
}

describe("bigquery-sync — credential short-circuits", () => {
  let fx: ConnectorSyncFixture;
  beforeEach(() => {
    fx = createConnectorSyncFixture();
    fx.fetchMock.install();
  });
  afterEach(() => fx.cleanup());

  test("no vault keys → noop, no fetch, preserves cursor", async () => {
    const res = await createBigquerySyncable(makeOptions()).sync(
      fx.createSyncContext("bigquery"),
      "prev",
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("prev");
    expect(fx.fetchMock.calls).toHaveLength(0);
  });

  test("cred path only (no project) → noop", async () => {
    await fx.vault.set("gcp.credentials_json_path", CRED_PATH);
    const res = await createBigquerySyncable(makeOptions()).sync(
      fx.createSyncContext("bigquery"),
      null,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(fx.fetchMock.calls).toHaveLength(0);
  });

  test("project only (no cred path) → noop", async () => {
    await fx.vault.set("gcp.project_id", PROJECT_ID);
    const res = await createBigquerySyncable(makeOptions()).sync(
      fx.createSyncContext("bigquery"),
      null,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(fx.fetchMock.calls).toHaveLength(0);
  });
});

describe("bigquery-sync — token mint failure", () => {
  let fx: ConnectorSyncFixture;
  beforeEach(async () => {
    fx = createConnectorSyncFixture();
    fx.fetchMock.install();
    await fx.vault.set("gcp.credentials_json_path", CRED_PATH);
    await fx.vault.set("gcp.project_id", PROJECT_ID);
  });
  afterEach(() => fx.cleanup());

  test("gcloud token mint returns null → graceful empty pass, preserves cursor, no fetch", async () => {
    const res = await createBigquerySyncable(makeOptions(tokenFail)).sync(
      fx.createSyncContext("bigquery"),
      "preserved",
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("preserved");
    expect(fx.fetchMock.calls).toHaveLength(0);
  });

  test("token mint failure + null cursor → pass-1 default", async () => {
    const res = await createBigquerySyncable(makeOptions(tokenFail)).sync(
      fx.createSyncContext("bigquery"),
      null,
    );
    expect(res.cursor).toBe(PASS_1_CURSOR);
  });
});

describe("bigquery-sync — datasets→tables walk", () => {
  let fx: ConnectorSyncFixture;
  beforeEach(async () => {
    fx = createConnectorSyncFixture();
    fx.fetchMock.install();
    await fx.vault.set("gcp.credentials_json_path", CRED_PATH);
    await fx.vault.set("gcp.project_id", PROJECT_ID);
  });
  afterEach(() => fx.cleanup());

  test("walks datasets then tables, fetches detail for schema, upserts items", async () => {
    fx.fetchMock.respond("GET", DATASETS_URL, {
      datasets: [
        { datasetReference: { datasetId: "analytics" } },
        { datasetReference: { datasetId: "raw" } },
      ],
    });
    fx.fetchMock.respond("GET", tablesUrl("analytics"), {
      tables: [{ tableReference: { datasetId: "analytics", tableId: "events" }, type: "TABLE" }],
    });
    fx.fetchMock.respond("GET", tablesUrl("raw"), {
      tables: [{ tableReference: { datasetId: "raw", tableId: "logs" }, type: "VIEW" }],
    });
    fx.fetchMock.respond("GET", tableDetailUrl("analytics", "events"), {
      tableReference: { datasetId: "analytics", tableId: "events" },
      type: "TABLE",
      numRows: "100",
      schema: { fields: [{ name: "id", type: "STRING" }] },
    });
    fx.fetchMock.respond("GET", tableDetailUrl("raw", "logs"), {
      tableReference: { datasetId: "raw", tableId: "logs" },
      type: "VIEW",
      schema: { fields: [{ name: "msg", type: "STRING" }] },
    });

    const res = await createBigquerySyncable(makeOptions()).sync(
      fx.createSyncContext("bigquery"),
      null,
    );
    expect(res.itemsUpserted).toBe(2);
    expect(res.cursor).toBe(PASS_1_CURSOR);
    expect(res.hasMore).toBe(false);

    const rows = fx.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'bigquery' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual([
      "my-project:analytics.events",
      "my-project:raw.logs",
    ]);
    const eventsMeta = JSON.parse(rows[0]!.metadata) as Record<string, unknown>;
    expect(eventsMeta.numRows).toBe(100);
    expect(eventsMeta.schemaFields).toEqual([{ name: "id", type: "STRING" }]);
  });

  test("Authorization Bearer header carries the minted token", async () => {
    fx.fetchMock.respond("GET", DATASETS_URL, { datasets: [] });
    await createBigquerySyncable(makeOptions()).sync(fx.createSyncContext("bigquery"), null);
    const call = fx.fetchMock.firstCall();
    expect(call.headers.authorization).toBe(`Bearer ${STUB_TOKEN}`);
  });

  test("datasets pagination follows nextPageToken", async () => {
    // First stub registered wins on match; the page-2 stub is more specific.
    fx.fetchMock.respond("GET", /\/datasets\?[\s\S]*pageToken=PAGE2/, {
      datasets: [{ datasetReference: { datasetId: "d2" } }],
    });
    fx.fetchMock.respond("GET", DATASETS_URL, {
      datasets: [{ datasetReference: { datasetId: "d1" } }],
      nextPageToken: "PAGE2",
    });
    fx.fetchMock.respond("GET", tablesUrl("d1"), { tables: [] });
    fx.fetchMock.respond("GET", tablesUrl("d2"), { tables: [] });

    await createBigquerySyncable(makeOptions()).sync(fx.createSyncContext("bigquery"), null);
    const datasetCalls = fx.fetchMock.calls.filter((c) => /\/datasets\?/.test(c.url));
    expect(datasetCalls).toHaveLength(2);
  });

  test("HTTP error on first datasets page → http-empty pass cursor (preserves cursor)", async () => {
    fx.fetchMock.respond("GET", DATASETS_URL, { error: "boom" }, { status: 403 });
    const res = await createBigquerySyncable(makeOptions()).sync(
      fx.createSyncContext("bigquery"),
      "prev",
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("prev");
  });

  test("parse error on first datasets page → parse-empty pass cursor (pass-1 default)", async () => {
    fx.fetchMock.respondWithText("GET", DATASETS_URL, "not-json");
    const res = await createBigquerySyncable(makeOptions()).sync(
      fx.createSyncContext("bigquery"),
      null,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
  });

  test("empty datasets → success with zero upserts", async () => {
    fx.fetchMock.respond("GET", DATASETS_URL, { datasets: [] });
    const res = await createBigquerySyncable(makeOptions()).sync(
      fx.createSyncContext("bigquery"),
      null,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
    expect(fx.notifications.emitted).toHaveLength(0);
  });

  test("table detail fetch failure → still upserts from list metadata", async () => {
    fx.fetchMock.respond("GET", DATASETS_URL, {
      datasets: [{ datasetReference: { datasetId: "d" } }],
    });
    fx.fetchMock.respond("GET", tablesUrl("d"), {
      tables: [{ tableReference: { datasetId: "d", tableId: "t" }, type: "TABLE" }],
    });
    fx.fetchMock.respond("GET", tableDetailUrl("d", "t"), { error: "nope" }, { status: 500 });
    const res = await createBigquerySyncable(makeOptions()).sync(
      fx.createSyncContext("bigquery"),
      null,
    );
    expect(res.itemsUpserted).toBe(1);
    const row = fx.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'bigquery'")
      .get();
    expect(row?.external_id).toBe("my-project:d.t");
  });
});
