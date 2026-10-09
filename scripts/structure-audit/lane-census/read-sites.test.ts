import { describe, expect, test } from "bun:test";
import { extractNonItemJsReads, extractReadTriples } from "./read-sites.ts";

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

  test("a multi-line interpolation does not shift the line of a predicate that follows it", () => {
    // `${…}` neutralisation must preserve one `\n` per newline it swallows — otherwise every
    // predicate after a multi-line interpolation reports too early, corrupting the census's
    // primary output (`file:line`).
    const src = [
      "db.query(`",
      "  SELECT id",
      "  FROM item i",
      "  WHERE i.service = ${",
      "    condition",
      "  }",
      "  AND i.type = 'commit'",
      "`);",
    ].join("\n");
    const out = extractReadTriples("i.ts", src);
    expect(out).toEqual([{ table: "item", kind: "type", value: "commit", file: "i.ts", line: 7 }]);
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

describe("JS metadata reads — A3 noise fixes", () => {
  const keys = (src: string) => extractReadTriples("x.ts", src).map((t) => t.value);

  test("an assignment target is a write, not a read", () => {
    const src = [
      "const meta: Record<string, unknown> = {};",
      'meta["status_category"] = "done";',
      "meta.other = 1;",
      'if (meta["kept"] === 1) {}',
    ].join("\n");
    expect(keys(src)).toEqual(["kept"]);
  });

  test("== / === / => after the bracket are reads, not assignments", () => {
    const src = 'function f(meta: R) { return meta["a"] == 1 || meta["b"] === 2; }';
    expect(keys(src).sort()).toEqual(["a", "b"]);
  });

  test("meta built from a vendor object is not an item read", () => {
    const src = [
      'const meta = asRecord(row["metadata"]) ?? {};',
      'const created = meta["creationTimestamp"];',
    ].join("\n");
    expect(keys(src)).toEqual([]);
    expect(extractNonItemJsReads("x.ts", src).map((r) => r.value)).toEqual(["creationTimestamp"]);
  });

  test("meta parsed from an item row's metadata column stays an item read", () => {
    for (const init of [
      "JSON.parse(row.metadata) as Record<string, unknown>",
      'parseMetadata(row["metadata"])',
      "parsePrMetadata(row.metadata)",
      "(item.rawMeta ?? {}) as Record<string, unknown>",
      "readStoredMetadata(ctx, id)",
    ]) {
      expect(keys(`const meta = ${init};\nconst v = meta["k"];`)).toEqual(["k"]);
    }
  });

  test("parameter meta stays an item read (fail-safe, Review Focus 1)", () => {
    expect(keys('function f(meta: Record<string, unknown>) { return meta["k"]; }')).toEqual(["k"]);
  });

  test("a sibling function's vendor `const meta` does not leak into a later parameter `meta` (review 2.1)", () => {
    const src = [
      "function parseSlack(res: R) {",
      '  const meta = asRecord(res.json["response_metadata"]);',
      '  return meta["next_cursor"];',
      "}",
      "function formatItem(meta: Record<string, unknown>) {",
      '  return meta["status"];',
      "}",
    ].join("\n");
    expect(keys(src)).toEqual(["status"]);
    expect(extractNonItemJsReads("x.ts", src).map((r) => r.value)).toEqual(["next_cursor"]);
  });

  test("a parameter shadowing an outer vendor `const meta` is an item read", () => {
    const src = [
      'const meta = asRecord(cfg["meta"]);',
      'const f = (meta: Record<string, unknown>) => meta["status"];',
    ].join("\n");
    expect(keys(src)).toEqual(["status"]);
  });

  test("an assignment with aligned whitespace before = is still a write (review 2.2)", () => {
    expect(keys('const meta: R = {};\nmeta["status_category"]    = "done";')).toEqual([]);
  });

  test("an uninitialised let stays an item read", () => {
    expect(keys('let meta: R;\nmeta = load();\nconst v = meta["k"];')).toEqual(["k"]);
  });

  test("a dotted receiver is always an item read", () => {
    const src = 'const meta = asRecord(x["meta"]);\nconst m = row.metadata["merged"];';
    expect(keys(src)).toEqual(["merged"]);
  });

  test("an object-literal initializer with an `as` cast is item origin (Ruling B)", () => {
    const src = 'const meta = { ...base, a: 1 } as Record<string, unknown>;\nconst v = meta["a"];';
    expect(keys(src)).toEqual(["a"]);
    expect(extractNonItemJsReads("x.ts", src)).toEqual([]);
  });

  test("a paren-less arrow parameter shadowing an outer vendor `const meta` is an item read", () => {
    const src = [
      'const meta = asRecord(cfg["meta"]);',
      'const statuses = rows.map(meta => meta["status"]);',
    ].join("\n");
    expect(keys(src)).toEqual(["status"]);
  });

  test("a `{` inside a return-type annotation is not taken as the body (fix round 1)", () => {
    for (const fn of [
      'function f(meta: R): Promise<{ a: T }> { return meta["status"]; }',
      'const f = (meta: R): { a: T } => ({ s: meta["status"] });',
      'const f = async (meta: R): Promise<{a: T}> => { return meta["status"]; };',
    ]) {
      const src = `const meta = vendor();\n${fn}`;
      expect(keys(src)).toEqual(["status"]);
      expect(extractNonItemJsReads("x.ts", src)).toEqual([]);
    }
  });

  test("a destructuring declaration that binds the name shadows an outer vendor `const meta` (fix round 1)", () => {
    const src = [
      'const meta = asRecord(cfg["x"]);',
      "function g(row: R) {",
      "  const { metadata: meta } = row;",
      '  return meta["status"];',
      "}",
    ].join("\n");
    expect(keys(src)).toEqual(["status"]);
    expect(extractNonItemJsReads("x.ts", src)).toEqual([]);
  });
});
