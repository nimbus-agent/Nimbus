import { describe, expect, test } from "bun:test";

import {
  baseTitle,
  countStatements,
  extractTableNames,
  type LocalDbQueryInput,
  mapLocalDbQueryToItem,
} from "../../../src/connectors/localdb-query-mapping.ts";

const SYNCED_AT = 1_750_000_000_000;

function input(over: Partial<LocalDbQueryInput> = {}): LocalDbQueryInput {
  return {
    relativePath: "reports/monthly.sql",
    sizeBytes: 120,
    modifiedAtMs: 1_700_000_000_000,
    sql: "SELECT * FROM orders o JOIN customers c ON o.cust_id = c.id;",
    ...over,
  };
}

describe("baseTitle", () => {
  test("returns the basename without the .sql extension (any separator)", () => {
    expect(baseTitle("reports/monthly.sql")).toBe("monthly");
    expect(baseTitle("a\\b\\q.SQL")).toBe("q");
    expect(baseTitle("top.sql")).toBe("top");
  });
});

describe("extractTableNames", () => {
  test("pulls identifiers after FROM/JOIN/INTO/UPDATE, deduped", () => {
    expect(
      extractTableNames(
        "SELECT * FROM orders JOIN customers ON 1=1 -- from again\nUPDATE orders SET x=1",
      ),
    ).toEqual(["orders", "customers"]);
  });

  test("strips quote/bracket wrappers and handles schema-qualified names", () => {
    expect(extractTableNames('SELECT 1 FROM "public"."sales"')).toEqual(["public.sales"]);
    expect(extractTableNames("SELECT 1 FROM [dbo].[t]")).toEqual(["dbo.t"]);
  });

  test("returns [] when no tables referenced", () => {
    expect(extractTableNames("SELECT 1")).toEqual([]);
  });
});

describe("countStatements", () => {
  test("counts semicolon-terminated statements and a trailing fragment", () => {
    expect(countStatements("SELECT 1; SELECT 2;")).toBe(2);
    expect(countStatements("SELECT 1; SELECT 2")).toBe(2);
    expect(countStatements("SELECT 1")).toBe(1);
    expect(countStatements("   ")).toBe(0);
  });
});

describe("mapLocalDbQueryToItem", () => {
  test("maps a saved .sql file to a localdb:saved_query item", () => {
    const row = mapLocalDbQueryToItem(input(), { syncedAt: SYNCED_AT });
    expect(row).not.toBeNull();
    if (row === null) {
      return;
    }
    expect(row.service).toBe("localdb");
    expect(row.type).toBe("saved_query");
    expect(row.externalId).toBe("reports/monthly.sql");
    expect(row.title).toBe("monthly");
    expect(row.bodyPreview).toContain("SELECT * FROM orders");
    expect(row.modifiedAt).toBe(1_700_000_000_000);
    expect(row.metadata.tables).toEqual(["orders", "customers"]);
    expect(row.metadata.statementCount).toBe(1);
    expect(row.metadata.relativePath).toBe("reports/monthly.sql");
  });

  test("returns null for an empty SQL file or an empty path", () => {
    expect(mapLocalDbQueryToItem(input({ sql: "   \n  " }), { syncedAt: SYNCED_AT })).toBeNull();
    expect(
      mapLocalDbQueryToItem(input({ relativePath: "  " }), { syncedAt: SYNCED_AT }),
    ).toBeNull();
  });

  test("falls back to syncedAt when the mtime is null", () => {
    const row = mapLocalDbQueryToItem(input({ modifiedAtMs: null }), { syncedAt: SYNCED_AT });
    expect(row?.modifiedAt).toBe(SYNCED_AT);
  });

  test("caps an over-long SQL body preview", () => {
    const row = mapLocalDbQueryToItem(input({ sql: `SELECT 1;${"x".repeat(5000)}` }), {
      syncedAt: SYNCED_AT,
    });
    expect(row?.bodyPreview.length ?? 0).toBeLessThanOrEqual(2001);
  });
});
