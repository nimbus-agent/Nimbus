import { describe, expect, test } from "bun:test";

import {
  flattenMappingFields,
  mapElasticsearchIndexToItem,
} from "./elasticsearch-index-mapping.ts";

describe("flattenMappingFields", () => {
  test("flattens nested properties into dotted paths and names typeless parents object", () => {
    const fields = flattenMappingFields(
      {
        logs: {
          mappings: {
            properties: {
              message: { type: "text" },
              user: {
                properties: {
                  name: { type: "keyword" },
                  geo: { type: "nested", properties: { lat: { type: "float" } } },
                },
              },
              "": { type: "ignored" },
              odd: "not a record",
            },
          },
        },
      },
      "logs",
    );
    expect(fields).toEqual([
      { name: "message", type: "text" },
      { name: "user", type: "object" },
      { name: "user.name", type: "keyword" },
      { name: "user.geo", type: "nested" },
      { name: "user.geo.lat", type: "float" },
      { name: "odd", type: "" },
    ]);
  });

  test("an absent index, mappings or properties yields no fields", () => {
    expect(flattenMappingFields(null, "logs")).toEqual([]);
    expect(flattenMappingFields({ other: {} }, "logs")).toEqual([]);
    expect(flattenMappingFields({ logs: {} }, "logs")).toEqual([]);
    expect(flattenMappingFields({ logs: { mappings: {} } }, "logs")).toEqual([]);
  });
});

describe("mapElasticsearchIndexToItem", () => {
  const ctx = { fields: [{ name: "message", type: "text" }], syncedAt: 42 };

  test("maps a _cat row with string-valued numbers and lists the fields in the preview", () => {
    const row = mapElasticsearchIndexToItem(
      {
        index: "logs",
        health: "green",
        status: "open",
        "docs.count": "1234",
        "store.size": " 987654 ",
        pri: 3,
        rep: "1",
        uuid: "abc",
      },
      ctx,
    );
    expect(row?.externalId).toBe("logs");
    expect(row?.bodyPreview).toBe("logs [green/open, 1234 docs] — message:text");
    expect(row?.metadata).toMatchObject({
      docsCount: 1234,
      storeSizeBytes: 987654,
      primaryShards: 3,
      replicas: 1,
      uuid: "abc",
    });
    expect(row?.modifiedAt).toBe(42);
  });

  test("unparseable numbers are null and missing health reads unknown", () => {
    const row = mapElasticsearchIndexToItem(
      { index: "idx", "docs.count": "many", "store.size": "  ", pri: Number.NaN, rep: {} },
      { fields: [], syncedAt: 1 },
    );
    expect(row?.bodyPreview).toBe("idx [unknown/unknown, ? docs]");
    expect(row?.metadata).toMatchObject({
      docsCount: null,
      storeSizeBytes: null,
      primaryShards: null,
      replicas: null,
      health: null,
    });
  });

  test("a long preview is clamped and a row without an index is rejected", () => {
    const wide = Array.from({ length: 80 }, (_v, i) => ({
      name: `field_${String(i)}`,
      type: "text",
    }));
    const row = mapElasticsearchIndexToItem({ index: "wide" }, { fields: wide, syncedAt: 1 });
    expect(row?.bodyPreview.length).toBe(513);
    expect(row?.bodyPreview.endsWith("…")).toBe(true);
    expect(mapElasticsearchIndexToItem({ index: "" }, ctx)).toBeNull();
    expect(mapElasticsearchIndexToItem("x", ctx)).toBeNull();
  });
});
