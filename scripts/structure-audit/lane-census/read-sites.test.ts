import { describe, expect, test } from "bun:test";
import { extractReadTriples } from "./read-sites.ts";

describe("extractReadTriples", () => {
  test("binds a type literal to item, not to another table", () => {
    const src = "db.query(`SELECT id FROM item i WHERE i.type = 'commit'`);";
    const out = extractReadTriples("a.ts", src);
    expect(out).toEqual([{ table: "item", kind: "type", value: "commit", file: "a.ts", line: 1 }]);
  });

  test("the same literal on graph_entity is a DIFFERENT triple", () => {
    const src = "db.query(`SELECT id FROM graph_entity e WHERE e.type = 'commit'`);";
    expect(extractReadTriples("b.ts", src)[0]?.table).toBe("graph_entity");
  });

  test("extracts a metadata key", () => {
    const src = "db.query(`SELECT 1 FROM item WHERE json_extract(metadata, '$.conclusion') = ?`);";
    const out = extractReadTriples("c.ts", src);
    expect(out).toContainEqual(
      expect.objectContaining({ table: "item", kind: "metadata-key", value: "conclusion" }),
    );
  });

  test("an IN list emits one triple per literal", () => {
    const src = "db.query(`SELECT 1 FROM item WHERE type IN ('ci_run', 'pipeline_run')`);";
    const values = extractReadTriples("e.ts", src)
      .map((t) => t.value)
      .sort();
    expect(values).toEqual(["ci_run", "pipeline_run"]);
  });

  test("returns nothing for a file with no SQL", () => {
    expect(extractReadTriples("d.ts", "export const x = 1;")).toHaveLength(0);
  });

  test("skips an unqualified type when more than one table is bound", () => {
    const src =
      "db.query(`SELECT 1 FROM item i JOIN graph_entity e ON e.id = i.id WHERE type = 'commit'`);";
    expect(extractReadTriples("f.ts", src)).toHaveLength(0);
  });

  test("skips a qualified name that binds to nothing", () => {
    const src = "db.query(`SELECT 1 FROM item WHERE zz.type = 'commit'`);";
    expect(extractReadTriples("g.ts", src)).toHaveLength(0);
  });

  test("line points at the predicate, not the top of the query", () => {
    const src = [
      "db.query(`",
      "  SELECT id",
      "  FROM item i",
      "  WHERE i.type = 'commit'",
      "`);",
    ].join("\n");
    const out = extractReadTriples("h.ts", src);
    expect(out).toEqual([{ table: "item", kind: "type", value: "commit", file: "h.ts", line: 4 }]);
  });

  test("picks up a JS-side metadata read", () => {
    const src = [
      "const meta = JSON.parse(row.metadata) as Record<string, unknown>;",
      'if (meta["conclusion"] !== "success") return null;',
    ].join("\n");
    const out = extractReadTriples("e.ts", src);
    expect(out).toContainEqual(
      expect.objectContaining({ table: "item", kind: "metadata-key", value: "conclusion" }),
    );
  });

  test("matches optional chaining and single quotes", () => {
    const src = 'if (meta?.["conclusion"] !== "success") return; const b = metadata?.[\'branch\'];';
    const values = extractReadTriples("dora.ts", src)
      .map((t) => t.value)
      .sort();
    expect(values).toEqual(["branch", "conclusion"]);
  });

  test("a named helper contributes the keys it reads", () => {
    const src = [
      "function repoLikeMatchesUrn(metadata: Record<string, unknown>) {",
      '  return metadata["repo"] === "x" || metadata["project"] === "y";',
      "}",
    ].join("\n");
    const values = extractReadTriples("f.ts", src).map((t) => t.value);
    expect(values).toContain("repo");
    expect(values).toContain("project");
  });
});
