/**
 * Local-DB saved-query mapping paths the main suite does not reach: the `MAX_TABLES` (32) cap on
 * extracted table names, a file whose base name is empty once `.sql` is stripped (so the title
 * must fall back to the relative path rather than be blank), and an input that arrives without an
 * `sql` field at all (the interface mirrors a scanned shape, so it can come from parsed JSON).
 */
import { describe, expect, test } from "bun:test";

import {
  extractTableNames,
  type LocalDbQueryInput,
  mapLocalDbQueryToItem,
} from "./localdb-query-mapping.ts";

const SYNCED_AT = 1_750_000_000_000;
/** Mirrors `MAX_TABLES` in localdb-query-mapping.ts. */
const MAX_TABLES = 32;

describe("extractTableNames — table cap", () => {
  test("stops at the first MAX_TABLES distinct names, in order of appearance", () => {
    const sql = Array.from(
      { length: MAX_TABLES + 3 },
      (_, i) => `SELECT * FROM t${String(i)};`,
    ).join("\n");

    const tables = extractTableNames(sql);

    expect(tables).toHaveLength(MAX_TABLES);
    expect(tables[0]).toBe("t0");
    expect(tables.at(-1)).toBe(`t${String(MAX_TABLES - 1)}`);
    expect(tables).not.toContain(`t${String(MAX_TABLES)}`);
  });

  test("duplicates do not count toward the cap", () => {
    const repeated = "SELECT * FROM same; UPDATE SAME SET x = 1;\n".repeat(40);
    const sql = `${repeated}SELECT * FROM other;`;
    expect(extractTableNames(sql)).toEqual(["same", "other"]);
  });
});

describe("mapLocalDbQueryToItem — empty base names", () => {
  test("a path whose base name is only the .sql extension is titled by the full relative path", () => {
    const row = mapLocalDbQueryToItem(
      { relativePath: "adhoc/.SQL", sizeBytes: 9, modifiedAtMs: null, sql: "SELECT 1;" },
      { syncedAt: SYNCED_AT },
    );
    expect(row?.title).toBe("adhoc/.SQL");
    expect(row?.externalId).toBe("adhoc/.SQL");
  });

  test("a path ending in a separator is titled by the full relative path too", () => {
    const row = mapLocalDbQueryToItem(
      { relativePath: "  scratch/  ", sizeBytes: 9, modifiedAtMs: 5, sql: "SELECT 1;" },
      { syncedAt: SYNCED_AT },
    );
    // The path is trimmed first, so the title is the trimmed path.
    expect(row?.title).toBe("scratch/");
    expect(row?.modifiedAt).toBe(5);
  });
});

describe("mapLocalDbQueryToItem — an input with no sql field", () => {
  test("maps to null instead of throwing, exactly like an empty file", () => {
    const parsed = JSON.parse(
      '{"relativePath":"reports/lost.sql","sizeBytes":0,"modifiedAtMs":null}',
    ) as LocalDbQueryInput;
    expect(mapLocalDbQueryToItem(parsed, { syncedAt: SYNCED_AT })).toBeNull();
    // Control: the same input WITH its sql maps.
    expect(
      mapLocalDbQueryToItem({ ...parsed, sql: "SELECT 1;" }, { syncedAt: SYNCED_AT })?.externalId,
    ).toBe("reports/lost.sql");
  });
});
