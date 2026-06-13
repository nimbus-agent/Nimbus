import { expect, test } from "bun:test";
import { normalizeDataModelKey } from "./data-model-key.ts";

test("lowercases, unquotes, and keeps db.schema.table", () => {
  expect(normalizeDataModelKey('ANALYTICS.PUBLIC."Revenue"')).toBe("analytics.public.revenue");
  expect(normalizeDataModelKey("`analytics`.`public`.`revenue`")).toBe("analytics.public.revenue");
});
test("two-part schema.table is preserved (no synthetic db prefix)", () => {
  expect(normalizeDataModelKey("public.revenue")).toBe("public.revenue");
});
test("trims surrounding whitespace and collapses brackets", () => {
  expect(normalizeDataModelKey("  [Analytics].[Public].[Revenue]  ")).toBe(
    "analytics.public.revenue",
  );
});
test("returns null for empty / unusable input", () => {
  expect(normalizeDataModelKey("")).toBeNull();
  expect(normalizeDataModelKey("   ")).toBeNull();
});
test("collapses empty parts from dot-only or double-dot input", () => {
  expect(normalizeDataModelKey("a..b")).toBe("a.b");
  expect(normalizeDataModelKey(".")).toBeNull();
});
test("returns null for non-string input (typeof raw !== 'string' branch)", () => {
  // Exercises the typeof guard: line 13 branch 0
  expect(normalizeDataModelKey(123 as unknown as string)).toBeNull();
  expect(normalizeDataModelKey(null as unknown as string)).toBeNull();
  expect(normalizeDataModelKey(undefined as unknown as string)).toBeNull();
  expect(normalizeDataModelKey([] as unknown as string)).toBeNull();
});
