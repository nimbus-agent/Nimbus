import { describe, expect, test } from "bun:test";
import { collectLaneCensus } from "../check-index-lane-coverage.ts";
import { extractAnnotations } from "./annotations.ts";

const one = (contents: string) => extractAnnotations("f.ts", contents);

describe("extractAnnotations", () => {
  test("covers the whole template, stops at the statement's ; (Review Focus 2)", () => {
    const src = [
      "// lane-census: scope=incident service=pagerduty", // 1
      "const rows = db", // 2
      "  .query(`", // 3
      "    SELECT json_extract(metadata, '$.status') FROM item", // 4
      "    WHERE service = ?`)", // 5
      "  .all(x);", // 6
      "const after = 1;", // 7
    ].join("\n");
    const { annotations, errors } = one(src);
    expect(errors).toEqual([]);
    expect(annotations[0]).toMatchObject({
      types: ["incident"],
      services: ["pagerduty"],
      startLine: 2,
      endLine: 6,
    });
  });

  test("a function declaration is covered through its closing brace", () => {
    const src = [
      "// lane-census: scope=ci_run,pr",
      "function f(m: R) {",
      '  return m["repo"];',
      "}",
      "const x = 1;",
    ].join("\n");
    expect(one(src).annotations[0]).toMatchObject({
      types: ["ci_run", "pr"],
      services: null,
      startLine: 2,
      endLine: 4,
    });
  });

  test("a malformed annotation is an error", () => {
    expect(one("// lane-census: scope pr\nconst x = 1;").errors[0]?.message).toContain("malformed");
  });

  test("two annotations on one statement is an error", () => {
    expect(
      one("// lane-census: scope=pr\n// lane-census: scope=issue\nconst x = 1;").errors,
    ).toHaveLength(1);
  });

  test("an annotation above a compound statement is an error, not a span that bleeds (review 2.4)", () => {
    for (const head of ["for (const r of rows) {", "if (x) {", "try {"]) {
      const src = `// lane-census: scope=pr\n${head}\n  r["k"];\n}\nconst next = 1;`;
      expect(one(src).errors[0]?.message).toContain("compound statement");
      expect(one(src).annotations).toHaveLength(0);
    }
  });

  test("an annotation followed by nothing is an error", () => {
    expect(one("const x = 1;\n// lane-census: scope=pr\n").errors[0]?.message).toContain(
      "covers nothing",
    );
  });
});

describe("annotations in the census", () => {
  const writer = {
    relPath: "packages/gateway/src/connectors/pd.ts",
    contents:
      'ctx.upsertItem({ service: "pagerduty", type: "incident", metadata: { status: 1 } });',
  };
  const reader = (body: string) => ({
    relPath: "packages/gateway/src/agents/r.ts",
    contents: body,
  });

  test("an annotated read is scoped and matched strictly", () => {
    const c = collectLaneCensus([
      writer,
      reader('// lane-census: scope=incident\nfunction f(meta: R) { return meta["status"]; }'),
    ]);
    expect(c.unscopedReads).toHaveLength(0);
    expect(c.unmatchedItemReads).toHaveLength(0);
  });

  test("an unannotated parameter read is unscoped", () => {
    const c = collectLaneCensus([writer, reader('function f(meta: R) { return meta["status"]; }')]);
    expect(c.unscopedReads.map((r) => r.value)).toEqual(["status"]);
  });

  test("an annotation naming a type no writer emits is an error", () => {
    const c = collectLaneCensus([
      writer,
      reader('// lane-census: scope=nosuch\nfunction f(meta: R) { return meta["status"]; }'),
    ]);
    expect(c.annotationErrors[0]?.message).toContain("nosuch");
  });

  test("a listed service that writes none of the scoped types is an error", () => {
    const c = collectLaneCensus([
      writer,
      reader(
        '// lane-census: scope=incident service=opsgenie\nfunction f(meta: R) { return meta["status"]; }',
      ),
    ]);
    expect(c.annotationErrors[0]?.message).toContain("opsgenie");
  });

  test("an annotation covering no metadata read is stale", () => {
    const c = collectLaneCensus([writer, reader("// lane-census: scope=incident\nconst x = 1;")]);
    expect(c.annotationErrors[0]?.message).toContain("covers no metadata read");
  });
});

describe("extractAnnotations edges", () => {
  test("an object return type is not mistaken for the function body", () => {
    const src = [
      "// lane-census: scope=pr", // 1
      "export function f(m: R): { a: string } {", // 2
      '  return { a: m["k"] };', // 3
      "}", // 4
      'const y = meta["other"];', // 5
    ].join("\n");
    expect(one(src).annotations[0]).toMatchObject({ startLine: 2, endLine: 4 });
  });

  test("CRLF line endings keep the same span", () => {
    const src = "// lane-census: scope=pr\r\nconst a = db\r\n  .all(x);\r\nconst b = 1;";
    expect(one(src).annotations[0]).toMatchObject({ startLine: 2, endLine: 3 });
  });
});

describe("annotation service narrowing in the census", () => {
  const files = [
    {
      relPath: "packages/gateway/src/connectors/pd.ts",
      contents:
        'ctx.upsertItem({ service: "pagerduty", type: "incident", metadata: { status: 1 } });',
    },
    {
      relPath: "packages/gateway/src/connectors/og.ts",
      contents:
        'ctx.upsertItem({ service: "opsgenie", type: "incident", metadata: { other: 1 } });',
    },
  ];
  const read = (annotation: string) => ({
    relPath: "packages/gateway/src/agents/r.ts",
    contents: `${annotation}\nfunction f(meta: R) { return meta["status"]; }`,
  });

  test("without service= a key one of two writers emits is partial", () => {
    const c = collectLaneCensus([...files, read("// lane-census: scope=incident")]);
    expect(c.unmatchedItemReads[0]).toMatchObject({
      matchState: "partial",
      partialCoverage: ["pagerduty"],
    });
  });

  test("service= narrows the writer set to the listed service", () => {
    const c = collectLaneCensus([
      ...files,
      read("// lane-census: scope=incident service=pagerduty"),
    ]);
    expect(c.unmatchedItemReads).toHaveLength(0);
    expect(c.annotationErrors).toHaveLength(0);
  });

  test("annotations in a test-helper file are ignored like its reads", () => {
    const c = collectLaneCensus([
      ...files,
      {
        relPath: "packages/gateway/src/agents/x.test-helpers.ts",
        contents: "// lane-census: scope=nosuch\nconst x = 1;",
      },
    ]);
    expect(c.annotationErrors).toHaveLength(0);
  });
});

describe("task-4 review fixes", () => {
  test("a class is brace-terminated, not bled into the next statement (finding 1)", () => {
    const src =
      '// lane-census: scope=pr\nclass C {\n  f(m) { return m["k"]; }\n}\nconst b = meta["k"];';
    expect(one(src).annotations[0]).toMatchObject({ startLine: 2, endLine: 4 });
    for (const head of [
      "export default abstract class C<T extends { a: 1 }> {",
      "export interface I {",
      "enum E {",
    ]) {
      const s = `// lane-census: scope=pr\n${head}\n  x;\n}\nconst b = 1;`;
      expect(one(s).annotations[0]).toMatchObject({ startLine: 2, endLine: 4 });
    }
  });

  test("the read after an annotated class stays unscoped (finding 1)", () => {
    const writer = {
      relPath: "packages/gateway/src/connectors/gh.ts",
      contents: 'ctx.upsertItem({ service: "github", type: "pr", metadata: { k: 1 } });',
    };
    const c = collectLaneCensus([
      writer,
      {
        relPath: "packages/gateway/src/agents/r.ts",
        contents:
          '// lane-census: scope=pr\nclass C {\n  f(meta: R) { return meta["k"]; }\n}\nfunction g(meta: R) { return meta["k"]; }',
      },
    ]);
    expect(c.unscopedReads.map((r) => r.line)).toEqual([5]);
  });

  test("a scoped type none of the listed services writes is an error (finding 2)", () => {
    const c = collectLaneCensus([
      {
        relPath: "packages/gateway/src/connectors/pd.ts",
        contents:
          'ctx.upsertItem({ service: "pagerduty", type: "incident", metadata: { status: 1 } });',
      },
      {
        relPath: "packages/gateway/src/connectors/gh.ts",
        contents: 'ctx.upsertItem({ service: "github", type: "pr", metadata: { status: 1 } });',
      },
      {
        relPath: "packages/gateway/src/agents/r.ts",
        contents:
          '// lane-census: scope=incident,pr service=pagerduty\nfunction f(meta: R) { return meta["status"]; }',
      },
    ]);
    expect(c.annotationErrors.map((e) => e.message)).toEqual([
      "annotation scopes type 'pr', which none of pagerduty writes",
    ]);
  });

  test("the narrowest covering annotation wins (finding 3)", () => {
    const c = collectLaneCensus([
      {
        relPath: "packages/gateway/src/connectors/pd.ts",
        contents:
          'ctx.upsertItem({ service: "pagerduty", type: "incident", metadata: { status: 1 } });',
      },
      {
        relPath: "packages/gateway/src/connectors/gh.ts",
        contents: 'ctx.upsertItem({ service: "github", type: "pr", metadata: { number: 1 } });',
      },
      {
        relPath: "packages/gateway/src/agents/r.ts",
        contents: [
          "// lane-census: scope=pr",
          "function f(meta: R, metadata: R) {",
          '  const n = meta["number"];',
          "  // lane-census: scope=incident",
          '  const s = metadata["status"];',
          "  return [n, s];",
          "}",
        ].join("\n"),
      },
    ]);
    expect(c.annotationErrors).toEqual([]);
    expect(c.unmatchedItemReads).toEqual([]);
  });

  test("an inner annotation alone leaves the outer one stale (finding 3)", () => {
    const c = collectLaneCensus([
      {
        relPath: "packages/gateway/src/connectors/pd.ts",
        contents:
          'ctx.upsertItem({ service: "pagerduty", type: "incident", metadata: { status: 1 } });',
      },
      {
        relPath: "packages/gateway/src/agents/r.ts",
        contents:
          '// lane-census: scope=incident\nfunction f(inc: R) {\n  // lane-census: scope=incident\n  const s = metadata["status"];\n  return s;\n}',
      },
    ]);
    expect(c.annotationErrors.map((e) => [e.line, e.message])).toEqual([
      [1, "annotation covers no metadata read"],
    ]);
  });

  test("a mention inside JSDoc, a string or after code is prose, not an annotation (finding 5)", () => {
    for (const src of [
      "/**\n * use // lane-census: scope=<type>\n */\nconst x = 1;",
      'const s = "// lane-census: scope=pr";',
      "const x = 1; // lane-census: scope=pr",
    ]) {
      expect(one(src)).toEqual({ annotations: [], errors: [] });
    }
  });
});

describe("an annotation never re-types a SQL-scoped read (final review I-1, R4 amended)", () => {
  const writers = [
    {
      relPath: "packages/gateway/src/connectors/gha.ts",
      contents:
        'ctx.upsertItem({ service: "github_actions", type: "ci_run", metadata: { conclusion: 1 } });',
    },
    {
      relPath: "packages/gateway/src/connectors/deploy.ts",
      contents:
        'ctx.upsertItem({ service: "vercel", type: "deployment", metadata: { state: 1 } });',
    },
    {
      relPath: "packages/gateway/src/connectors/pd.ts",
      contents:
        'ctx.upsertItem({ service: "pagerduty", type: "incident", metadata: { status: 1 } });',
    },
    {
      relPath: "packages/gateway/src/connectors/og.ts",
      contents:
        'ctx.upsertItem({ service: "opsgenie", type: "incident", metadata: { other: 1 } });',
    },
  ];
  const reader = (contents: string) => ({ relPath: "packages/gateway/src/agents/r.ts", contents });

  test("a differently-typed query inside an annotated function is an error and is matched against its own SQL type", () => {
    const c = collectLaneCensus([
      ...writers,
      reader(
        [
          "// lane-census: scope=ci_run", // 1
          "function selectFailingCiRuns(db: D, meta: R) {", // 2
          '  const c = meta["conclusion"];', // 3
          "  return db.query(`SELECT id FROM item WHERE type = 'deployment' AND json_extract(metadata, '$.conclusion') = 'x'`);", // 4
          "}", // 5
        ].join("\n"),
      ),
    ]);
    expect(c.annotationErrors.map((e) => [e.line, e.message])).toEqual([
      [4, "annotation contradicts the statement's SQL type scope (deployment)"],
    ]);
    expect(c.unmatchedItemReads).toEqual([
      expect.objectContaining({ line: 4, value: "conclusion", matchState: "unmatched" }),
    ]);
  });

  test("the same query outside any annotation is unmatched, with no annotation error", () => {
    const c = collectLaneCensus([
      ...writers,
      reader(
        "db.query(`SELECT id FROM item WHERE type = 'deployment' AND json_extract(metadata, '$.conclusion') = 'x'`);",
      ),
    ]);
    expect(c.annotationErrors).toEqual([]);
    expect(c.unmatchedItemReads.map((r) => [r.value, r.matchState])).toEqual([
      ["conclusion", "unmatched"],
    ]);
  });

  test("an agreeing annotation's service= still narrows a SQL-scoped read", () => {
    const sql =
      "  return db.query(`SELECT id FROM item WHERE type = 'incident' AND json_extract(metadata, '$.status') = 'x'`);";
    const narrowed = collectLaneCensus([
      ...writers,
      reader(
        ["// lane-census: scope=incident service=pagerduty", "function f(db: D) {", sql, "}"].join(
          "\n",
        ),
      ),
    ]);
    expect(narrowed.annotationErrors).toEqual([]);
    expect(narrowed.unmatchedItemReads).toEqual([]);

    const unnarrowed = collectLaneCensus([
      ...writers,
      reader(["function f(db: D) {", sql, "}"].join("\n")),
    ]);
    expect(unnarrowed.unmatchedItemReads.map((r) => r.matchState)).toEqual(["partial"]);
  });

  test("an annotation covering only part of a type IN (...) scope contradicts it", () => {
    const c = collectLaneCensus([
      ...writers,
      reader(
        [
          "// lane-census: scope=incident",
          "const rows = db.query(`SELECT id FROM item WHERE type IN ('incident', 'deployment') AND json_extract(metadata, '$.status') = 'x'`);",
        ].join("\n"),
      ),
    ]);
    expect(c.annotationErrors.map((e) => e.message)).toEqual([
      "annotation contradicts the statement's SQL type scope (deployment, incident)",
    ]);
  });
});

describe("method and object-property spans (final review M-1)", () => {
  test("an annotation above a class METHOD ends at the method's closing brace, not the class's", () => {
    for (const head of [
      "load(m: R) {",
      "async load(m: R): Promise<number> {",
      "private static get x(): number {",
    ]) {
      const src = [
        "class C {", // 1
        "  // lane-census: scope=pr", // 2
        `  ${head}`, // 3
        '    return m["number"];', // 4
        "  }", // 5
        "  other(m: R) {", // 6
        '    return m["state"];', // 7
        "  }", // 8
        "}", // 9
      ].join("\n");
      expect(one(src).annotations[0]).toMatchObject({ startLine: 3, endLine: 5 });
    }
  });

  test("a multi-line parameter list still reads as a method head", () => {
    const src = [
      "class C {",
      "  // lane-census: scope=pr",
      "  async load(",
      "    m: R,",
      "  ) {",
      '    return m["number"];',
      "  }",
      "  other() {}",
      "}",
    ].join("\n");
    expect(one(src).annotations[0]).toMatchObject({ startLine: 3, endLine: 7 });
  });

  test("a plain call statement is not mistaken for a method", () => {
    const src = ["// lane-census: scope=pr", "load(m);", "const y = 1;"].join("\n");
    expect(one(src).annotations[0]).toMatchObject({ startLine: 2, endLine: 2 });
  });

  test("an annotation above an object-literal PROPERTY covers that property only", () => {
    const src = [
      "const o = {", // 1
      "  // lane-census: scope=pr", // 2
      '  number: meta["number"],', // 3
      '  state: meta["state"],', // 4
      "};", // 5
    ].join("\n");
    expect(one(src).annotations[0]).toMatchObject({ startLine: 3, endLine: 3 });
  });

  test("a multi-line property value is covered through its own comma", () => {
    const src = [
      "const o = {", // 1
      "  // lane-census: scope=pr", // 2
      "  pair: {", // 3
      '    a: meta["a"],', // 4
      '    b: meta["b"],', // 5
      "  },", // 6
      '  state: meta["state"],', // 7
      "};", // 8
    ].join("\n");
    expect(one(src).annotations[0]).toMatchObject({ startLine: 3, endLine: 6 });
  });

  test("a declaration's depth-0 comma (a generic type argument) does not end it", () => {
    const src = [
      "// lane-census: scope=pr", // 1
      "const m: Map<string, number> = new Map([", // 2
      '  ["k", meta["number"]],', // 3
      "]);", // 4
      "const y = 1;", // 5
    ].join("\n");
    expect(one(src).annotations[0]).toMatchObject({ startLine: 2, endLine: 4 });
  });
});
