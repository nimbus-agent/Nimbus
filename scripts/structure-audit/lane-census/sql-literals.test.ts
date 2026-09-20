import { describe, expect, test } from "bun:test";
import { extractSqlLiterals } from "./sql-literals.ts";

describe("extractSqlLiterals", () => {
  test("finds a template literal and neutralises interpolation", () => {
    // The `${placeholders}` sequence below is deliberate SOURCE TEXT being scanned, not a real
    // interpolation this file wants evaluated — that is the whole point of the fixture. It is
    // assembled from two pieces (`"${"` then `"placeholders}) ..."`) rather than written as one
    // inline `${...}` string so neither piece alone matches `noTemplateCurlyInString` — the rule
    // is correct in general (a `${...}` inside a plain string is almost always a forgotten
    // backtick) and wrong for a scanner fixture whose job is to contain exactly that text.
    const src = [
      "const rows = db.query(`",
      "  SELECT id FROM item",
      "  WHERE service IN (" + "${" + "placeholders}) AND type = 'ci_run'",
      "`).all();",
    ].join("\n");
    const out = extractSqlLiterals(src);
    expect(out).toHaveLength(1);
    expect(out[0]?.sql).toContain("__INTERP__");
    expect(out[0]?.sql).not.toContain("${");
    expect(out[0]?.line).toBe(1);
  });

  test("ignores a non-SQL template literal", () => {
    // Same reasoning as above: assembled so no single string-literal token contains the
    // `${...}` sequence Biome's noTemplateCurlyInString rule matches on.
    const nonSqlTemplate = "const msg = `hello " + "${" + "name}`;";
    expect(extractSqlLiterals(nonSqlTemplate)).toHaveLength(0);
  });

  test("finds SQL in a DOUBLE-quoted string", () => {
    const src = 'db.query("SELECT service, type FROM item WHERE id = ?").get(id);';
    expect(extractSqlLiterals(src)).toHaveLength(1);
  });

  test("finds SQL in a single-quoted string", () => {
    expect(extractSqlLiterals("db.query('SELECT 1 FROM item LIMIT 1');")).toHaveLength(1);
  });

  test("returns nothing for empty input", () => {
    expect(extractSqlLiterals("")).toHaveLength(0);
  });
});
