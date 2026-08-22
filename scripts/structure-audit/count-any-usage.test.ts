import { describe, expect, test } from "bun:test";
import { countAnyInSource, stripComments } from "./lib.ts";

describe("stripComments", () => {
  test("removes single-line comments", () => {
    expect(stripComments("const x = 1; // any here")).toBe("const x = 1; ");
  });
  test("removes multi-line comments", () => {
    expect(stripComments("/* any here */ const x = 1;")).toBe(" const x = 1;");
  });
  test("preserves any in code", () => {
    expect(stripComments("const x: any = 1;")).toBe("const x: any = 1;");
  });
  test("does not strip inside double-quoted string", () => {
    expect(stripComments('const u = "https://x.com/any";')).toBe('const u = "https://x.com/any";');
  });
  test("does not strip inside single-quoted string", () => {
    expect(stripComments("const u = 'https://x.com/any';")).toBe("const u = 'https://x.com/any';");
  });
  test("does not strip inside template literal", () => {
    expect(stripComments("const u = `https://x.com/any`;")).toBe("const u = `https://x.com/any`;");
  });
  test("honours escaped quote inside string", () => {
    expect(stripComments(String.raw`const u = "a\"//not a comment";`)).toBe(
      String.raw`const u = "a\"//not a comment";`,
    );
  });
  test("strips line comment after a string", () => {
    expect(stripComments('const u = "x"; // any')).toBe('const u = "x"; ');
  });
  test("preserves newlines inside block comments", () => {
    const src = "/*\n line1\n line2\n*/\nconst x = y as Foo;";
    const stripped = stripComments(src);
    expect(stripped.split("\n").length).toBe(src.split("\n").length);
    expect(stripped.split("\n")[4]).toBe("const x = y as Foo;");
  });
});

describe("countAnyInSource", () => {
  test("counts type annotation", () => {
    expect(countAnyInSource("const x: any = 1;")).toBe(1);
  });
  test("counts as-cast", () => {
    expect(countAnyInSource("const x = y as any;")).toBe(1);
  });
  test("counts generic", () => {
    expect(countAnyInSource("Promise<any>")).toBe(1);
  });
  test("does not count comments", () => {
    expect(countAnyInSource("// this any is in a comment\nconst x = 1;")).toBe(0);
  });
  test("does not count words containing 'any'", () => {
    expect(countAnyInSource("const company = 1; const many = 2;")).toBe(0);
  });
  test("counts multiple occurrences", () => {
    expect(countAnyInSource("const a: any = 1; const b = c as any;")).toBe(2);
  });
});

describe("countAnyInSource ignores the word inside string literals", () => {
  // The ratchet exists to bound the `any` TYPE. Counting the word wherever it appears makes it
  // a prose check: an English stopword list containing "any", a user-facing error message, or a
  // SQL fragment all raised the count and demanded a baseline bump for nothing. Comments were
  // already stripped for exactly this reason — string literals are the same problem, one step
  // further in.
  test("a double-quoted literal does not count", () => {
    expect(countAnyInSource('const stopwords = ["any", "all"];')).toBe(0);
  });

  test("a single-quoted literal does not count", () => {
    expect(countAnyInSource("const s = 'any';")).toBe(0);
  });

  test("a template literal does not count", () => {
    expect(countAnyInSource("const s = `pick any one`;")).toBe(0);
  });

  test("a real annotation beside a literal still counts exactly once", () => {
    expect(countAnyInSource('const x: any = "any";')).toBe(1);
  });

  test("an escaped quote inside a literal does not end it early", () => {
    // Otherwise the scanner would leave the string mid-way and count the tail as code.
    expect(countAnyInSource('const s = "he said \\"any\\" thing";')).toBe(0);
  });

  test("an apostrophe inside a double-quoted string does not open one", () => {
    expect(countAnyInSource(`const s = "don't use any";`)).toBe(0);
  });
});
