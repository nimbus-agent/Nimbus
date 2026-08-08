import { describe, expect, test } from "bun:test";

import {
  flattenMappingFields,
  mapElasticsearchIndexToItem,
} from "../../../src/connectors/elasticsearch-index-mapping.ts";

const SYNCED_AT = 1_700_000_000_000;

function ctx(fields: Array<{ name: string; type: string }> = []) {
  return { fields, syncedAt: SYNCED_AT };
}

describe("mapElasticsearchIndexToItem", () => {
  test("maps a full _cat/indices row + fields (metadata only, NO row data)", () => {
    const row = mapElasticsearchIndexToItem(
      {
        index: "orders-2026.05",
        health: "green",
        status: "open",
        "docs.count": "12345",
        "store.size": "987654",
        pri: "3",
        rep: "1",
        uuid: "abc-uuid",
      },
      ctx([
        { name: "id", type: "keyword" },
        { name: "total", type: "double" },
      ]),
    );
    expect(row).not.toBeNull();
    expect(row?.service).toBe("elasticsearch");
    expect(row?.type).toBe("index");
    expect(row?.externalId).toBe("orders-2026.05");
    expect(row?.title).toBe("orders-2026.05");
    expect(row?.url).toBeNull();
    expect(row?.canonicalUrl).toBeNull();
    expect(row?.modifiedAt).toBe(SYNCED_AT);

    const meta = row?.metadata as Record<string, unknown>;
    expect(meta.index).toBe("orders-2026.05");
    expect(meta.health).toBe("green");
    expect(meta.status).toBe("open");
    expect(meta.docsCount).toBe(12345);
    expect(meta.storeSizeBytes).toBe(987654);
    expect(meta.primaryShards).toBe(3);
    expect(meta.replicas).toBe(1);
    expect(meta.uuid).toBe("abc-uuid");
    expect(meta.fields).toEqual([
      { name: "id", type: "keyword" },
      { name: "total", type: "double" },
    ]);
  });

  test("numeric columns parse from strings; missing columns become null", () => {
    const row = mapElasticsearchIndexToItem({ index: "sparse-index" }, ctx());
    const meta = row?.metadata as Record<string, unknown>;
    expect(meta.health).toBeNull();
    expect(meta.status).toBeNull();
    expect(meta.docsCount).toBeNull();
    expect(meta.storeSizeBytes).toBeNull();
    expect(meta.primaryShards).toBeNull();
    expect(meta.replicas).toBeNull();
    expect(meta.uuid).toBeNull();
    expect(meta.fields).toEqual([]);
  });

  test("tolerates already-numeric columns (number input)", () => {
    const row = mapElasticsearchIndexToItem(
      { index: "n", "docs.count": 42, "store.size": 100 },
      ctx(),
    );
    const meta = row?.metadata as Record<string, unknown>;
    expect(meta.docsCount).toBe(42);
    expect(meta.storeSizeBytes).toBe(100);
  });

  test("bodyPreview includes health/status/count and field summary", () => {
    const row = mapElasticsearchIndexToItem(
      { index: "logs", health: "yellow", status: "open", "docs.count": "7" },
      ctx([{ name: "msg", type: "text" }]),
    );
    expect(row?.bodyPreview).toContain("logs");
    expect(row?.bodyPreview).toContain("yellow/open");
    expect(row?.bodyPreview).toContain("7 docs");
    expect(row?.bodyPreview).toContain("msg:text");
  });

  test("returns null when index name is missing", () => {
    expect(mapElasticsearchIndexToItem({ health: "green" }, ctx())).toBeNull();
    expect(mapElasticsearchIndexToItem({ index: "" }, ctx())).toBeNull();
  });

  test("returns null for non-record input", () => {
    expect(mapElasticsearchIndexToItem(null, ctx())).toBeNull();
    expect(mapElasticsearchIndexToItem([1, 2], ctx())).toBeNull();
    expect(mapElasticsearchIndexToItem("nope", ctx())).toBeNull();
  });
});

describe("flattenMappingFields", () => {
  test("flattens a single-index _mapping response (field names + types only)", () => {
    const fields = flattenMappingFields(
      {
        "orders-2026.05": {
          mappings: {
            properties: {
              id: { type: "keyword" },
              total: { type: "double" },
            },
          },
        },
      },
      "orders-2026.05",
    );
    expect(fields).toEqual([
      { name: "id", type: "keyword" },
      { name: "total", type: "double" },
    ]);
  });

  test("flattens nested object properties with dotted paths", () => {
    const fields = flattenMappingFields(
      {
        idx: {
          mappings: {
            properties: {
              id: { type: "keyword" },
              user: {
                properties: {
                  name: { type: "text" },
                  age: { type: "integer" },
                },
              },
            },
          },
        },
      },
      "idx",
    );
    expect(fields).toEqual([
      { name: "id", type: "keyword" },
      { name: "user", type: "object" },
      { name: "user.name", type: "text" },
      { name: "user.age", type: "integer" },
    ]);
  });

  test("returns [] for non-record / missing mappings", () => {
    expect(flattenMappingFields(null, "x")).toEqual([]);
    expect(flattenMappingFields({}, "x")).toEqual([]);
    expect(flattenMappingFields({ x: {} }, "x")).toEqual([]);
    expect(flattenMappingFields({ x: { mappings: {} } }, "x")).toEqual([]);
  });

  test("a field with an explicit type AND properties keeps its declared type", () => {
    const fields = flattenMappingFields(
      {
        x: {
          mappings: {
            properties: {
              meta: { type: "nested", properties: { k: { type: "keyword" } } },
            },
          },
        },
      },
      "x",
    );
    expect(fields).toEqual([
      { name: "meta", type: "nested" },
      { name: "meta.k", type: "keyword" },
    ]);
  });
});
