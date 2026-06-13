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

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => table({ table_name: `table_${String(i)}` }));
    expect(filterSnowflakeTables(many, { query: "table_", limit: 3 })).toHaveLength(3);
  });

  test("defaults the cap to 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => table({ table_name: `table_${String(i)}` }));
    expect(filterSnowflakeTables(many, { query: "table_" })).toHaveLength(50);
  });
});
