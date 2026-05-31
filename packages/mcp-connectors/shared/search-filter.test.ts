import { describe, expect, test } from "bun:test";

import { asObjectish, asRecord, filterByQuery, stringField, tagText } from "./search-filter.ts";

describe("filterByQuery", () => {
  const rows = [
    { name: "Revenue", tag: "finance" },
    { name: "Latency", tag: "ops" },
    { name: "Revenue Detail", tag: "finance" },
  ];
  const fields = (r: { name: string; tag: string }) => [r.name, r.tag];

  test("matches case-insensitively", () => {
    expect(filterByQuery(rows, { query: "REVENUE", fields })).toHaveLength(2);
  });

  test("non-match returns empty", () => {
    expect(filterByQuery(rows, { query: "nonsense", fields })).toHaveLength(0);
  });

  test("empty query matches every non-skipped item", () => {
    expect(filterByQuery(rows, { query: "", fields })).toHaveLength(3);
  });

  test("honors a custom limit cap in encounter order", () => {
    const out = filterByQuery(rows, { query: "revenue", limit: 1, fields });
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("Revenue");
  });

  test("defaults the cap to 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `n-${i}`, tag: "x" }));
    expect(filterByQuery(many, { query: "n-", fields })).toHaveLength(50);
  });

  test("fields returning null skips the item entirely", () => {
    const mixed = [{ name: "keep" }, { name: "skip" }, { name: "keep-too" }];
    const out = filterByQuery(mixed, {
      query: "",
      fields: (r) => (r.name === "skip" ? null : [r.name]),
    });
    expect(out.map((r) => r.name)).toEqual(["keep", "keep-too"]);
  });

  test("tolerates null and undefined field parts", () => {
    const out = filterByQuery([{ a: "hit" }], {
      query: "hit",
      fields: (r) => [r.a, null, undefined],
    });
    expect(out).toHaveLength(1);
  });
});

describe("asRecord", () => {
  test("accepts a plain object", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
  });

  test("rejects null, primitives, and arrays", () => {
    expect(asRecord(null)).toBeUndefined();
    expect(asRecord(42)).toBeUndefined();
    expect(asRecord("x")).toBeUndefined();
    expect(asRecord([1, 2])).toBeUndefined();
  });
});

describe("asObjectish", () => {
  test("accepts a plain object and an array", () => {
    expect(asObjectish({ a: 1 })).toEqual({ a: 1 });
    expect(asObjectish([1, 2])).toEqual([1, 2] as unknown as Record<string, unknown>);
  });

  test("rejects null and primitives", () => {
    expect(asObjectish(null)).toBeUndefined();
    expect(asObjectish(42)).toBeUndefined();
    expect(asObjectish("x")).toBeUndefined();
  });
});

describe("stringField", () => {
  test("returns the string value for a string field", () => {
    expect(stringField({ name: "Revenue" }, "name")).toBe("Revenue");
  });

  test("returns empty string for a missing key", () => {
    expect(stringField({ name: "Revenue" }, "absent")).toBe("");
  });

  test("returns empty string for a non-string value", () => {
    expect(stringField({ count: 42 }, "count")).toBe("");
    expect(stringField({ flag: true }, "flag")).toBe("");
    expect(stringField({ nested: { a: 1 } }, "nested")).toBe("");
    expect(stringField({ list: ["a"] }, "list")).toBe("");
    expect(stringField({ nil: null }, "nil")).toBe("");
  });
});

describe("tagText", () => {
  test("joins a string array at key 'tags' with spaces", () => {
    expect(tagText({ tags: ["finance", "ops"] })).toBe("finance ops");
  });

  test("returns empty string when 'tags' is missing", () => {
    expect(tagText({ name: "x" })).toBe("");
  });

  test("returns empty string when 'tags' is not an array", () => {
    expect(tagText({ tags: "finance" })).toBe("");
    expect(tagText({ tags: { a: 1 } })).toBe("");
    expect(tagText({ tags: null })).toBe("");
  });

  test("skips non-string entries", () => {
    expect(tagText({ tags: ["finance", 42, null, { name: "x" }, "ops"] })).toBe("finance ops");
  });

  test("returns empty string for an array of only non-string entries", () => {
    expect(tagText({ tags: [1, 2, { a: 1 }] })).toBe("");
  });
});
