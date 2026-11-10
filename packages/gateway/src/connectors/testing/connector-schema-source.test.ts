import { describe, expect, test } from "bun:test";

import {
  constStatement,
  declaredInputKeys,
  matchingClose,
  registrationCallOf,
  requiredInputKeys,
  topLevelArgs,
  withSchemaArgumentDeclarations,
} from "./connector-schema-source.ts";

describe("constStatement", () => {
  test("ends at the first semicolon outside brackets", () => {
    const code = "const a = z.object({ x: z.string(); });\nconst b = 1;";
    expect(constStatement(code, "a")).toBe("const a = z.object({ x: z.string(); });");
    expect(constStatement(code, "b")).toBe("const b = 1;");
  });

  test("an unterminated statement runs to the end; an absent or longer-named const is undefined", () => {
    expect(constStatement("const a = z.object({", "a")).toBe("const a = z.object({");
    expect(constStatement("const ab = 1;", "a")).toBeUndefined();
    expect(constStatement("nothing here", "a")).toBeUndefined();
  });
});

describe("topLevelArgs and matchingClose", () => {
  test("splits on commas outside brackets and quotes, honouring escapes", () => {
    expect(topLevelArgs("(\"a,b\", f(1, 2), [3, 4], 'it\\'s, ok', `t,`)")).toEqual([
      '"a,b"',
      "f(1, 2)",
      "[3, 4]",
      "'it\\'s, ok'",
      "`t,`",
    ]);
    expect(topLevelArgs("()")).toEqual([""]);
  });

  test("matchingClose skips strings and reports -1 when the bracket never closes", () => {
    const code = '{ a: ")", b: { c: 1 } } tail';
    expect(matchingClose(code, 0)).toBe(code.indexOf("} tail"));
    expect(matchingClose("{ a: 1", 0)).toBe(-1);
    expect(matchingClose("{ a: 'x\\'}' }", 0)).toBe(12);
  });
});

describe("registrationCallOf", () => {
  test("returns the call for a tool id and ignores a name that is not a registration", () => {
    const code =
      'register("gh_issue_get", { x: 1 }, async () => {}); const names = ["gh_issue_list"];';
    expect(registrationCallOf(code, "gh_issue_get")).toBe(
      '("gh_issue_get", { x: 1 }, async () => {})',
    );
    expect(registrationCallOf(code, "gh_issue_list")).toBeUndefined();
  });

  test("an unclosed call is undefined", () => {
    expect(registrationCallOf('register("t", { a: 1 ', "t")).toBeUndefined();
  });
});

describe("declaredInputKeys and requiredInputKeys", () => {
  const decl = `const s = z.object({
    id: z.string(),
    note: z.string().optional(),
    n: z.number().default(3),
    maybe: z.string().nullish(),
    nested: z.object({ inner: z.string() }),
  });
  const t = s.extend({ more: z.string() });`;

  test("declared keys are every z.object and .extend key, sorted without repeats", () => {
    expect(declaredInputKeys(decl)).toEqual([
      "id",
      "inner",
      "maybe",
      "more",
      "n",
      "nested",
      "note",
    ]);
  });

  test("required keys drop optional, default and nullish entries", () => {
    expect(requiredInputKeys(decl)).toEqual(["id", "inner", "more", "nested"]);
  });

  test("an unclosed object literal is skipped, and an unrecognised shape yields no keys", () => {
    expect(declaredInputKeys("z.object({ a: z.string()")).toEqual([]);
    expect(requiredInputKeys("z.object({ a: z.string()")).toEqual([]);
    expect(declaredInputKeys("const x = 1;")).toEqual([]);
  });
});

describe("withSchemaArgumentDeclarations", () => {
  const code = [
    "const base = z.object({ a: z.string() });",
    "const mid = base.extend({ b: z.string() });",
    "const loop = loop.extend({ c: z.string() });",
    "const notSchema = 5;",
  ].join("\n");

  test("follows a local schema const and its extend chain", () => {
    const out = withSchemaArgumentDeclarations([], code, '("tool", mid, handler)');
    expect(out).toContain("const mid = base.extend");
    expect(out).toContain("const base = z.object");
    expect(out).not.toContain("notSchema");
  });

  test("stops at a self-referencing chain and at a const that is not a schema", () => {
    expect(
      withSchemaArgumentDeclarations([], code, '("tool", loop)').match(/const loop/g),
    ).toHaveLength(1);
    const out = withSchemaArgumentDeclarations([], code, '("tool", notSchema, missing)');
    expect(out).toBe('("tool", notSchema, missing)');
  });

  test("an emailToolSchemas member is followed into the shared mail kit only when the table names it", () => {
    const kit = [
      "const draft = z.object({ to: z.string() });",
      "const emailToolSchemas = { draft };",
      "const hidden = z.object({ secret: z.string() });",
    ].join("\n");
    const sources = [{ rel: "shared/imap-tool-kit.ts", text: kit }];
    const named = withSchemaArgumentDeclarations(sources, "", '("t", emailToolSchemas.draft)');
    expect(named).toContain("const draft = z.object");
    const unnamed = withSchemaArgumentDeclarations(sources, "", '("t", emailToolSchemas.hidden)');
    expect(unnamed).not.toContain("secret");
    const noKit = withSchemaArgumentDeclarations([], "", '("t", emailToolSchemas.draft)');
    expect(noKit).toBe('("t", emailToolSchemas.draft)');
    const notSchema = withSchemaArgumentDeclarations(
      [
        {
          rel: "shared/imap-tool-kit.ts",
          text: "const emailToolSchemas = { plain };\nconst plain = 3;",
        },
      ],
      "",
      '("t", emailToolSchemas.plain)',
    );
    expect(notSchema).not.toContain("const plain");
  });
});
