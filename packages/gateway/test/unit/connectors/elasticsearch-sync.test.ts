import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createElasticsearchSyncable } from "../../../src/connectors/elasticsearch-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const URL_VALUE = "https://my-cluster.es.us-east-1.aws.found.io:9243";
const API_KEY = "es-api-key-test";
const CURSOR_PREFIX = "nimbus-es1:";

function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
const PASS_1_CURSOR = encodeCursor({ pass: 1 });

function makeOptions() {
  return { ensureElasticsearchMcpRunning: async (): Promise<void> => {} };
}

const CAT_URL = /\/_cat\/indices\?/;
/** Escape ALL regex metacharacters (incl. backslash) before embedding in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
function mappingUrl(index: string): RegExp {
  return new RegExp(`/${escapeRegExp(index)}/_mapping$`);
}

describe("elasticsearch-sync — credential short-circuits", () => {
  let fx: ConnectorSyncFixture;
  beforeEach(() => {
    fx = createConnectorSyncFixture();
    fx.fetchMock.install();
  });
  afterEach(() => fx.cleanup());

  test("no vault keys → noop, no fetch, preserves cursor", async () => {
    const res = await createElasticsearchSyncable(makeOptions()).sync(
      fx.createSyncContext("elasticsearch"),
      "prev",
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("prev");
    expect(fx.fetchMock.calls).toHaveLength(0);
  });

  test("url only (no api_key) → noop", async () => {
    await fx.vault.set("elasticsearch.url", URL_VALUE);
    const res = await createElasticsearchSyncable(makeOptions()).sync(
      fx.createSyncContext("elasticsearch"),
      null,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(fx.fetchMock.calls).toHaveLength(0);
  });

  test("api_key only (no url) → noop", async () => {
    await fx.vault.set("elasticsearch.api_key", API_KEY);
    const res = await createElasticsearchSyncable(makeOptions()).sync(
      fx.createSyncContext("elasticsearch"),
      null,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(fx.fetchMock.calls).toHaveLength(0);
  });
});

describe("elasticsearch-sync — _cat/indices → _mapping walk", () => {
  let fx: ConnectorSyncFixture;
  beforeEach(async () => {
    fx = createConnectorSyncFixture();
    fx.fetchMock.install();
    await fx.vault.set("elasticsearch.url", URL_VALUE);
    await fx.vault.set("elasticsearch.api_key", API_KEY);
  });
  afterEach(() => fx.cleanup());

  test("lists indices, fetches mappings, upserts items with field schema", async () => {
    fx.fetchMock.respond("GET", CAT_URL, [
      {
        index: "orders",
        health: "green",
        status: "open",
        "docs.count": "10",
        "store.size": "2048",
        pri: "1",
        rep: "1",
        uuid: "u-orders",
      },
      { index: "products", health: "yellow", status: "open", "docs.count": "5" },
    ]);
    fx.fetchMock.respond("GET", mappingUrl("orders,products"), {
      orders: { mappings: { properties: { id: { type: "keyword" } } } },
      products: { mappings: { properties: { sku: { type: "keyword" } } } },
    });

    const res = await createElasticsearchSyncable(makeOptions()).sync(
      fx.createSyncContext("elasticsearch"),
      null,
    );
    expect(res.itemsUpserted).toBe(2);
    expect(res.cursor).toBe(PASS_1_CURSOR);
    expect(res.hasMore).toBe(false);

    const rows = fx.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'elasticsearch' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["orders", "products"]);
    const ordersMeta = JSON.parse(rows[0]!.metadata) as Record<string, unknown>;
    expect(ordersMeta.docsCount).toBe(10);
    expect(ordersMeta.storeSizeBytes).toBe(2048);
    expect(ordersMeta.fields).toEqual([{ name: "id", type: "keyword" }]);
  });

  test("Authorization ApiKey header carries the configured key", async () => {
    fx.fetchMock.respond("GET", CAT_URL, []);
    await createElasticsearchSyncable(makeOptions()).sync(
      fx.createSyncContext("elasticsearch"),
      null,
    );
    const call = fx.fetchMock.firstCall();
    expect(call.headers.authorization).toBe(`ApiKey ${API_KEY}`);
  });

  test("skips ES system indices (names starting with '.')", async () => {
    fx.fetchMock.respond("GET", CAT_URL, [
      { index: ".kibana_1", health: "green", status: "open" },
      { index: "visible", health: "green", status: "open" },
    ]);
    fx.fetchMock.respond("GET", mappingUrl("visible"), {
      visible: { mappings: { properties: { f: { type: "text" } } } },
    });

    const res = await createElasticsearchSyncable(makeOptions()).sync(
      fx.createSyncContext("elasticsearch"),
      null,
    );
    expect(res.itemsUpserted).toBe(1);
    // Only the visible index's mapping was fetched — no .kibana_1 request.
    const mappingCalls = fx.fetchMock.calls.filter((c) => c.url.endsWith("_mapping"));
    expect(mappingCalls).toHaveLength(1);
    expect(mappingCalls[0]!.url).toContain("/visible/_mapping");
  });

  test("a per-index _mapping failure still upserts the index from _cat metadata", async () => {
    fx.fetchMock.respond("GET", CAT_URL, [
      { index: "logs", health: "red", status: "open", "docs.count": "99" },
    ]);
    fx.fetchMock.respond("GET", mappingUrl("logs"), { error: "boom" }, { status: 500 });

    const res = await createElasticsearchSyncable(makeOptions()).sync(
      fx.createSyncContext("elasticsearch"),
      null,
    );
    expect(res.itemsUpserted).toBe(1);
    const row = fx.db
      .query<{ metadata: string }, []>(
        "SELECT metadata FROM item WHERE service = 'elasticsearch' AND external_id = 'logs'",
      )
      .get();
    const meta = JSON.parse(row!.metadata) as Record<string, unknown>;
    expect(meta.health).toBe("red");
    expect(meta.fields).toEqual([]);
  });

  test("HTTP error on the _cat/indices listing → http-empty pass (preserves cursor)", async () => {
    fx.fetchMock.respond("GET", CAT_URL, { error: "unauthorized" }, { status: 401 });
    const res = await createElasticsearchSyncable(makeOptions()).sync(
      fx.createSyncContext("elasticsearch"),
      "prev",
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("prev");
  });

  test("parse error on the _cat/indices listing → parse-empty pass (pass-1 default)", async () => {
    fx.fetchMock.respondWithText("GET", CAT_URL, "not-json");
    const res = await createElasticsearchSyncable(makeOptions()).sync(
      fx.createSyncContext("elasticsearch"),
      null,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
  });

  test("empty index list → success with zero upserts", async () => {
    fx.fetchMock.respond("GET", CAT_URL, []);
    const res = await createElasticsearchSyncable(makeOptions()).sync(
      fx.createSyncContext("elasticsearch"),
      null,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
  });

  test("mapping response key mismatch leaves fields empty", async () => {
    fx.fetchMock.respond("GET", CAT_URL, [
      { index: "products", health: "yellow", status: "open", "docs.count": "5" },
    ]);
    fx.fetchMock.respond("GET", mappingUrl("products"), {
      orders: { mappings: { properties: { id: { type: "keyword" } } } },
    });

    const res = await createElasticsearchSyncable(makeOptions()).sync(
      fx.createSyncContext("elasticsearch"),
      null,
    );
    expect(res.itemsUpserted).toBe(1);

    const row = fx.db
      .query<{ metadata: string }, []>(
        "SELECT metadata FROM item WHERE service = 'elasticsearch' AND external_id = 'products'",
      )
      .get();
    const meta = JSON.parse(row!.metadata) as Record<string, unknown>;
    expect(meta["fields"]).toEqual([]);
  });
});
