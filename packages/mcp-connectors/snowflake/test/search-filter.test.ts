import { describe, expect, test } from "bun:test";

import { filterSnowflakeTables } from "../src/search-filter.ts";

function table(over: {
  table_name?: string;
  schema_name?: string;
  database_name?: string;
}): Record<string, unknown> {
  return {
    database_name: over.database_name ?? "MY_DB",
    schema_name: over.schema_name ?? "PUBLIC",
    table_name: over.table_name ?? "ORDERS",
    row_count: 1000,
    last_altered: "2026-01-01T00:00:00Z",
  };
}

describe("filterSnowflakeTables", () => {
  test("matches against table_name (case-insensitive)", () => {
    expect(filterSnowflakeTables([table({})], { query: "ORDERS" })).toHaveLength(1);
    expect(filterSnowflakeTables([table({})], { query: "orders" })).toHaveLength(1);
  });

  test("matches against schema_name", () => {
    expect(
      filterSnowflakeTables([table({ schema_name: "ANALYTICS" })], { query: "analytics" }),
    ).toHaveLength(1);
  });

  test("matches against database_name", () => {
    expect(
      filterSnowflakeTables([table({ database_name: "PROD_DB" })], { query: "prod" }),
    ).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterSnowflakeTables([table({})], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(filterSnowflakeTables([null, 42, "x", table({})], { query: "orders" })).toHaveLength(1);
  });

  test("tolerates missing fields without throwing", () => {
    const noSchema = { database_name: "DB", table_name: "USERS" };
    expect(filterSnowflakeTables([noSchema], { query: "users" })).toHaveLength(1);
    expect(filterSnowflakeTables([noSchema], { query: "missing" })).toHaveLength(0);
  });

  test("returns empty when item list is empty", () => {
    expect(filterSnowflakeTables([], { query: "orders" })).toHaveLength(0);
  });

  test("handles non-string field values gracefully", () => {
    const mixedFields = {
      database_name: 123,
      schema_name: true,
      table_name: null,
      other_field: "match_this",
    };
    expect(filterSnowflakeTables([mixedFields], { query: "123" })).toHaveLength(0);
    expect(filterSnowflakeTables([mixedFields], { query: "true" })).toHaveLength(0);
    expect(filterSnowflakeTables([mixedFields], { query: "null" })).toHaveLength(0);
  });

  test("matches queries that span across multiple fields", () => {
    const row = table({
      database_name: "PROD_DB",
      schema_name: "ANALYTICS",
      table_name: "ORDERS",
    });
    // The query filter lowercases both haystack and needle, and splits the extracted fields with space.
    // e.g. "orders analytics prod_db"
    expect(filterSnowflakeTables([row], { query: "orders analytics" })).toHaveLength(1);
    expect(filterSnowflakeTables([row], { query: "analytics prod" })).toHaveLength(1);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => table({ table_name: `table_${String(i)}` }));
    expect(filterSnowflakeTables(many, { query: "table_", limit: 3 })).toHaveLength(3);
  });

  test("defaults the cap to 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => table({ table_name: `table_${String(i)}` }));
    expect(filterSnowflakeTables(many, { query: "table_" })).toHaveLength(50);
  });
});
