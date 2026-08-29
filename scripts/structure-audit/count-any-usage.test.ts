// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every string in this file is a
// source-text FIXTURE fed to a source scanner, so a literal `${...}` is the subject under
// test, never a botched template literal.
import { describe, expect, test } from "bun:test";
import { countAnyInSource, stripComments, stripStringLiterals } from "./lib.ts";

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

describe("stripStringLiterals preserves template substitutions", () => {
  // A `${...}` substitution is EXECUTABLE CODE that happens to sit inside backticks — blanking it
  // with the surrounding template text made every source-scanning guard built on this helper blind
  // to it. Two guards compose it (`countAnyInSource` and D22(f)'s
  // `checkEmbeddingConstructorConfinement`), and both want to see that code: an `as any` inside a
  // substitution is a real `any`, and a `createOpenAIEmbedder(...)` inside one issues a real,
  // unledgered HTTP request regardless of what the template does with the stringified result.
  // Reported by CodeRabbit on PR #1384.
  test("the substitution body survives while the literal text around it is blanked", () => {
    const out = stripStringLiterals("const s = `pick any ${x as any} one`;");
    expect(out).toContain("${x as any}");
    // Surrounding template TEXT is still blanked, so prose can never fake a match.
    expect(out).not.toContain("pick any");
    // Length-preserving, which the paren-matching consumer depends on for its indices.
    expect(out.length).toBe("const s = `pick any ${x as any} one`;".length);
  });

  test("a nested template inside a substitution is handled recursively", () => {
    const out = stripStringLiterals("const s = `a ${f(`inner any ${y as any}`)} b`;");
    expect(out).toContain("y as any");
    // The NESTED template's own prose is blanked too — it is text, not code.
    expect(out).not.toContain("inner any");
  });

  test("a plain string inside a substitution is still blanked", () => {
    const out = stripStringLiterals('const s = `${label("any")}`;');
    expect(out).toContain("label(");
    expect(out).not.toContain('"any"');
  });

  test("an unterminated substitution does not throw or leak the rest of the file", () => {
    expect(() => stripStringLiterals("const s = `${f(")).not.toThrow();
  });
});

describe("countAnyInSource sees through template substitutions", () => {
  test("an as-cast inside a substitution counts", () => {
    expect(countAnyInSource("const s = `v=${x as any}`;")).toBe(1);
  });

  test("the template's prose still does not count", () => {
    expect(countAnyInSource("const s = `pick any one ${x}`;")).toBe(0);
  });

  test("a string literal inside a substitution still does not count", () => {
    expect(countAnyInSource('const s = `${pick("any")}`;')).toBe(0);
  });
});
