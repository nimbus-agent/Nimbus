import { describe, expect, test } from "bun:test";
import { cardUrl, mapMetabaseCardToItem } from "../../../src/connectors/metabase-card-mapping.ts";
import { extractArray } from "../../../src/connectors/metabase-sync.ts";
import { BODY_MAX_PROSE } from "../../../src/index/body-caps.ts";

const NOW = 1_700_009_999_999;
const BASE_URL = "https://acme.metabaseapp.com";
const COLLECTION_NAMES: Record<string, string> = { "7": "Finance" };
const SQL = "SELECT month, SUM(total) FROM orders GROUP BY month";

/** Native question shaped like a real `GET /api/card` row from Metabase v0.65.2. */
function makeCard(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    name: "Revenue by month",
    description: "Which months brought in the most revenue?",
    type: "question",
    collection_id: 7,
    dashboard_id: null,
    creator_id: 3,
    archived: false,
    query_type: "native",
    database_id: 1,
    table_id: null,
    created_at: "2021-02-10T20:03:11Z",
    updated_at: "2022-06-01T08:00:00Z",
    dataset_query: {
      "lib/type": "mbql/query",
      database: 1,
      stages: [{ "lib/type": "mbql.stage/native", native: SQL, "template-tags": [] }],
    },
    ...over,
  };
}

function ctx() {
  return { baseUrl: BASE_URL, collectionNames: COLLECTION_NAMES, syncedAt: NOW };
}

function mapped(over: Record<string, unknown> = {}) {
  const row = mapMetabaseCardToItem(makeCard(over), ctx());
  if (row === null) {
    throw new Error("expected a mapped row");
  }
  return row;
}

describe("mapMetabaseCardToItem", () => {
  test("happy path: maps a native question to a metabase:card row", () => {
    const row = mapped();
    expect(row.service).toBe("metabase");
    expect(row.type).toBe("card");
    expect(row.externalId).toBe("card/42");
    expect(row.title).toBe("Revenue by month");
    expect(row.bodyPreview).toBe("Which months brought in the most revenue?");
    expect(row.url).toBe(`${BASE_URL}/question/42`);
    expect(row.canonicalUrl).toBe(`${BASE_URL}/question/42`);
    expect(row.modifiedAt).toBe(Date.parse("2022-06-01T08:00:00Z"));
    expect(row.syncedAt).toBe(NOW);
    expect(row.metadata).toEqual({
      card_id: 42,
      name: "Revenue by month",
      description: "Which months brought in the most revenue?",
      collection_id: "7",
      collection_name: "Finance",
      dashboard_id: null,
      creator_id: 3,
      archived: false,
      query_type: "native",
      database_id: 1,
      table_id: null,
      native_query: SQL,
      native_query_truncated: false,
      created_at: Date.parse("2021-02-10T20:03:11Z"),
      updated_at: Date.parse("2022-06-01T08:00:00Z"),
      canonical_url: `${BASE_URL}/question/42`,
    });
  });

  test("{ data: [...] } wrapper: rows read through extractArray map the same as a bare array", () => {
    const rows = extractArray({ data: [makeCard()] });
    expect(rows).toHaveLength(1);
    expect(mapMetabaseCardToItem(rows[0], ctx())?.externalId).toBe("card/42");
    expect(extractArray([makeCard()])).toHaveLength(1);
  });

  test("returns null when the row is not a plain object", () => {
    expect(mapMetabaseCardToItem(null, ctx())).toBeNull();
    expect(mapMetabaseCardToItem("nope", ctx())).toBeNull();
  });

  test("returns null for models and metrics", () => {
    expect(mapMetabaseCardToItem(makeCard({ type: "model" }), ctx())).toBeNull();
    expect(mapMetabaseCardToItem(makeCard({ type: "metric" }), ctx())).toBeNull();
  });

  test("older responses with no type: a question maps, a dataset: true model does not", () => {
    const untyped = makeCard();
    delete untyped["type"];
    expect(mapMetabaseCardToItem(untyped, ctx())?.externalId).toBe("card/42");
    expect(mapMetabaseCardToItem({ ...untyped, dataset: true }, ctx())).toBeNull();
  });

  test("returns null when id is missing, empty or non-numeric", () => {
    const noId = makeCard();
    delete noId["id"];
    expect(mapMetabaseCardToItem(noId, ctx())).toBeNull();
    expect(mapMetabaseCardToItem(makeCard({ id: "" }), ctx())).toBeNull();
    expect(mapMetabaseCardToItem(makeCard({ id: null }), ctx())).toBeNull();
    expect(mapMetabaseCardToItem(makeCard({ id: "42" }), ctx())).toBeNull();
  });

  test("returns null when name is missing or empty", () => {
    const noName = makeCard();
    delete noName["name"];
    expect(mapMetabaseCardToItem(noName, ctx())).toBeNull();
    expect(mapMetabaseCardToItem(makeCard({ name: "" }), ctx())).toBeNull();
  });

  test("reads SQL from the legacy native.query shape", () => {
    const row = mapped({
      dataset_query: { type: "native", database: 1, native: { query: SQL } },
    });
    expect(row.metadata["native_query"]).toBe(SQL);
  });

  test("GUI-built question: keeps source ids, not the query tree", () => {
    const row = mapped({
      query_type: "query",
      table_id: 2,
      dataset_query: {
        "lib/type": "mbql/query",
        database: 1,
        stages: [{ "lib/type": "mbql.stage/mbql", "source-table": 2, filters: ["TREE-SENTINEL"] }],
      },
    });
    expect(row.metadata["query_type"]).toBe("query");
    expect(row.metadata["database_id"]).toBe(1);
    expect(row.metadata["table_id"]).toBe(2);
    expect(row.metadata["native_query"]).toBeNull();
    expect(JSON.stringify(row)).not.toContain("TREE-SENTINEL");
  });

  test("native_query is null when dataset_query is missing or its SQL is empty", () => {
    expect(mapped({ dataset_query: undefined }).metadata["native_query"]).toBeNull();
    expect(mapped({ dataset_query: { stages: [] } }).metadata["native_query"]).toBeNull();
    expect(
      mapped({ dataset_query: { stages: [{ native: "" }] } }).metadata["native_query"],
    ).toBeNull();
  });

  test("caps native_query and marks it truncated", () => {
    const long = "x".repeat(BODY_MAX_PROSE + 1);
    const row = mapped({ dataset_query: { stages: [{ native: long }] } });
    expect(row.metadata["native_query"]).toBe("x".repeat(BODY_MAX_PROSE));
    expect(row.metadata["native_query_truncated"]).toBe(true);
  });

  test("no cell values: result and parameter fields never reach the item", () => {
    const row = mapped({
      result_metadata: [{ name: "TOTAL", fingerprint: { type: { avg: "RESULT-SENTINEL" } } }],
      visualization_settings: { "table.columns": ["VIZ-SENTINEL"] },
      parameters: [{ default: "PARAM-SENTINEL" }],
      rows: [["ROW-SENTINEL"]],
      data: { rows: [["CELL-SENTINEL"]] },
      creator: { email: "CREATOR-SENTINEL" },
      dataset_query: {
        stages: [
          {
            native: SQL,
            "template-tags": [{ name: "min", default: "TAG-SENTINEL" }],
          },
        ],
      },
    });
    const stored = JSON.stringify(row);
    expect(stored).toContain(SQL);
    for (const sentinel of [
      "RESULT-SENTINEL",
      "VIZ-SENTINEL",
      "PARAM-SENTINEL",
      "ROW-SENTINEL",
      "CELL-SENTINEL",
      "CREATOR-SENTINEL",
      "TAG-SENTINEL",
    ]) {
      expect(stored).not.toContain(sentinel);
    }
    expect(row.metadata).not.toHaveProperty("result_metadata");
  });

  test("bodyPreview falls back to the name when description is null or empty", () => {
    expect(mapped({ description: null }).bodyPreview).toBe("Revenue by month");
    expect(mapped({ description: "" }).bodyPreview).toBe("Revenue by month");
  });

  test("a card outside any known collection has a null collection_name", () => {
    expect(mapped({ collection_id: null }).metadata["collection_name"]).toBeNull();
    expect(mapped({ collection_id: 99 }).metadata["collection_name"]).toBeNull();
  });

  test("keeps a dashboard_id the response provides", () => {
    expect(mapped({ dashboard_id: 5 }).metadata["dashboard_id"]).toBe(5);
  });

  test("modifiedAt falls back to created_at, then syncedAt", () => {
    expect(mapped({ updated_at: null }).modifiedAt).toBe(Date.parse("2021-02-10T20:03:11Z"));
    expect(mapped({ updated_at: null, created_at: null }).modifiedAt).toBe(NOW);
  });

  test("cardUrl tolerates a trailing slash on the base URL", () => {
    expect(cardUrl(`${BASE_URL}/`, 7)).toBe(`${BASE_URL}/question/7`);
  });
});
