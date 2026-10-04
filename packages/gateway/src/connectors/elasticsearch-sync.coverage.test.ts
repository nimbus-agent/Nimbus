/**
 * Elasticsearch paths the main suite does not reach: a `_cat/indices` body that is not an array,
 * listing rows with no usable index name, and a cluster with more than `MAX_INDICES` (500) indices.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { StubFetch } from "../../test/helpers/stub-fetch.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createElasticsearchSyncable } from "./elasticsearch-sync.ts";
import { decodeNimbusJsonCursorObject } from "./nimbus-json-cursor.ts";

const BASE = "https://es.example.test:9200";
const CAT_URL = `${BASE}/_cat/indices?format=json&bytes=b`;
const MAPPING_RE = /^https:\/\/es\.example\.test:9200\/[^?]+\/_mapping$/;
/** Mirrors `MAX_INDICES` / `MAX_INDEX_DETAIL` in elasticsearch-sync.ts. */
const MAX_INDICES = 500;
const MAX_INDEX_DETAIL = 200;

let fetchStub: StubFetch;
let db: Database;

beforeEach(() => {
  fetchStub = new StubFetch();
  fetchStub.install();
  db = createMemoryIndexDb();
});

afterEach(() => {
  fetchStub.restore();
  db.close();
});

function sync() {
  return createElasticsearchSyncable({ ensureElasticsearchMcpRunning: async () => {} }).sync(
    syncTestContext(
      db,
      createStubVault({ "elasticsearch.url": `${BASE}/`, "elasticsearch.api_key": "k" }),
      "elasticsearch",
    ),
    null,
  );
}

function indexedNames(): string[] {
  return (
    db
      .query("SELECT external_id FROM item WHERE service = 'elasticsearch' ORDER BY external_id")
      .all() as { external_id: string }[]
  ).map((r) => r.external_id);
}

function mappingCalls(): string[] {
  return fetchStub.calls.filter((c) => MAPPING_RE.test(c.url)).map((c) => c.url);
}

describe("elasticsearch-sync — listing shapes", () => {
  test("a `_cat/indices` body that is an object, not an array, indexes nothing and fetches no mappings", async () => {
    fetchStub.respond("GET", CAT_URL, { index: "orders", health: "green" });

    const res = await sync();

    expect(res.itemsUpserted).toBe(0);
    expect(decodeNimbusJsonCursorObject(res.cursor, "nimbus-es1:")).toEqual({ pass: 1 });
    expect(mappingCalls()).toEqual([]);
  });

  test("rows that are not objects or have no/empty `index` are skipped before any mapping fetch", async () => {
    fetchStub.respond("GET", CAT_URL, [
      null,
      "orders",
      { index: "" },
      { health: "green", "docs.count": "3" },
      { index: 42 },
      { index: "customers", health: "yellow" },
    ]);
    fetchStub.respond("GET", MAPPING_RE, {});

    const res = await sync();

    expect(res.itemsUpserted).toBe(1);
    expect(indexedNames()).toEqual(["customers"]);
    expect(mappingCalls()).toEqual([`${BASE}/customers/_mapping`]);
  });
});

describe("elasticsearch-sync — index cap", () => {
  test("only the first MAX_INDICES non-system indices are indexed; mappings only for the first 200", async () => {
    const names = Array.from(
      { length: MAX_INDICES + 1 },
      (_, i) => `idx-${String(i).padStart(3, "0")}`,
    );
    fetchStub.respond("GET", CAT_URL, [
      { index: ".kibana_1" },
      ...names.map((index) => ({ index, health: "green", status: "open" })),
    ]);
    fetchStub.respond("GET", MAPPING_RE, {});

    const res = await sync();

    expect(res.itemsUpserted).toBe(MAX_INDICES);
    const indexed = indexedNames();
    expect(indexed).toHaveLength(MAX_INDICES);
    expect(indexed[0]).toBe("idx-000");
    expect(indexed.at(-1)).toBe("idx-499");
    expect(indexed).not.toContain("idx-500");
    expect(indexed).not.toContain(".kibana_1");
    // 200 detailed indices in batches of 50.
    const batches = mappingCalls();
    expect(batches).toHaveLength(MAX_INDEX_DETAIL / 50);
    expect(batches.at(-1)).toContain("idx-199");
    expect(batches.join(",")).not.toContain("idx-200");
  });
});
