import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { reconcileCatchupRows } from "../sources/source-catchup.ts";
import { sourceTypesFor } from "../sources/source-kinds.ts";
import { BUILTIN_SOURCE_MAPPING } from "../sources/source-mapping.ts";
import { glossarySets, isFastPath } from "./glossary-visibility.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});

describe("isFastPath", () => {
  test("true when every known type is effective", () => {
    expect(isFastPath(["a:b", "c:d"], ["c:d", "a:b", "e:f"])).toBe(true);
    expect(isFastPath([], [])).toBe(true);
  });
  test("false when any known type is not effective", () => {
    expect(isFastPath(["a:b", "c:d"], ["a:b"])).toBe(false);
  });
});

describe("glossarySets", () => {
  test("the built-in mapping on a fresh index is the fast path", () => {
    const sets = glossarySets(db, BUILTIN_SOURCE_MAPPING);
    expect(sets.effective).toEqual(sourceTypesFor("glossary"));
    expect(sets.known).toEqual(sourceTypesFor("glossary"));
    expect(sets.fast).toBe(true);
  });
  test("a tracked type that left the mapping turns the fast path off", () => {
    const cursor = { watermarkMs: 5, watermarkId: "x" };
    reconcileCatchupRows(db, "glossary", ["ext_notes:highlight"], new Set(), cursor);
    const sets = glossarySets(db, BUILTIN_SOURCE_MAPPING);
    expect(sets.known).toContain("ext_notes:highlight");
    expect(sets.fast).toBe(false);
  });
});
