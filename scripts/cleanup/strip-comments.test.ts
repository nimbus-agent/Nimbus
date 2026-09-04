import { describe, expect, test } from "bun:test";
import {
  isPublishedJsdocFile,
  shouldPreserveComment,
  stripRustSource,
  stripTsSource,
} from "./strip-comments.ts";

describe("shouldPreserveComment", () => {
  test("preserves @ts-expect-error", () => {
    expect(shouldPreserveComment("// @ts-expect-error reason")).toBe(true);
  });
  test("preserves biome-ignore", () => {
    expect(shouldPreserveComment("// biome-ignore lint/style/useTemplate: legacy")).toBe(true);
  });
  test("preserves cross-platform-ok", () => {
    expect(shouldPreserveComment("// cross-platform-ok")).toBe(true);
  });
  test("preserves audit-ignore-next-line", () => {
    expect(shouldPreserveComment("// audit-ignore-next-line D11-vault-key")).toBe(true);
  });
  test("preserves triple-slash references", () => {
    expect(shouldPreserveComment('/// <reference types="vite/client" />')).toBe(true);
    expect(shouldPreserveComment('/// <reference types="bun-types" />')).toBe(true);
    expect(shouldPreserveComment('/// <reference path="content.d.ts" />')).toBe(true);
  });
  test("preserves NOSONAR — stripping one silently re-opens a suppressed Sonar issue", () => {
    expect(shouldPreserveComment("// NOSONAR justified: the regex is linear")).toBe(true);
  });
  test("preserves coverage-instrumentation ranges", () => {
    expect(shouldPreserveComment("/* c8 ignore start -- constructs the real DAVClient */")).toBe(
      true,
    );
    expect(shouldPreserveComment("/* c8 ignore stop */")).toBe(true);
    expect(shouldPreserveComment("// v8 ignore next")).toBe(true);
    expect(shouldPreserveComment("/* istanbul ignore else */")).toBe(true);
  });
  test("preserves x-release-please-version — it drives the version bump and audit:release-please", () => {
    expect(
      shouldPreserveComment('export const GATEWAY_VERSION = "7.7.0"; // x-release-please-version'),
    ).toBe(true);
  });
  test("preserves bundler and test-runner directives", () => {
    expect(shouldPreserveComment("/* @__PURE__ */")).toBe(true);
    expect(shouldPreserveComment("/* @license MIT */")).toBe(true);
    expect(shouldPreserveComment("// @vitest-environment jsdom")).toBe(true);
  });
  test("does not preserve regular comments", () => {
    expect(shouldPreserveComment("// just a comment")).toBe(false);
    expect(shouldPreserveComment("/* block */")).toBe(false);
  });
});

describe("isPublishedJsdocFile", () => {
  test("no monorepo-tree source is a published-JSDoc file (sdk + client are external repos now)", () => {
    expect(isPublishedJsdocFile("packages/gateway/src/engine/executor.ts")).toBe(false);
    expect(isPublishedJsdocFile("packages/cli/src/index.ts")).toBe(false);
    // sdk and client are each published from their own repos, not the monorepo tree.
    expect(isPublishedJsdocFile("packages/sdk/src/index.ts")).toBe(false);
    expect(isPublishedJsdocFile("packages/client/src/index.ts")).toBe(false);
  });
});

describe("stripTsSource", () => {
  test("removes line comments", () => {
    const src = `const x = 1; // this is removed\nconst y = 2;\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).not.toContain("this is removed");
    expect(out).toContain("const x = 1;");
    expect(out).toContain("const y = 2;");
  });

  test("removes block comments", () => {
    const src = `/* block */\nconst x = 1;\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).not.toContain("/* block */");
    expect(out).toContain("const x = 1;");
  });

  test("removes JSDoc when keepJsdoc is false", () => {
    const src = `/**\n * Doc comment\n */\nexport function f() {}\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).not.toContain("Doc comment");
    expect(out).toContain("export function f() {}");
  });

  test("preserves JSDoc when keepJsdoc is true", () => {
    const src = `/**\n * Doc comment\n */\nexport function f() {}\n`;
    const out = stripTsSource(src, { keepJsdoc: true });
    expect(out).toContain("Doc comment");
  });

  test("preserves @ts-expect-error", () => {
    const src = `// @ts-expect-error this is wrong\nconst x: number = "foo";\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).toContain("@ts-expect-error");
  });

  test("preserves biome-ignore", () => {
    const src = `// biome-ignore lint/style/useTemplate: legacy code\nconst s = "a" + "b";\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).toContain("biome-ignore");
  });

  test("preserves shebang", () => {
    const src = `#!/usr/bin/env bun\n// removed\nconsole.log("hi");\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out.startsWith("#!/usr/bin/env bun")).toBe(true);
    expect(out).not.toContain("removed");
  });

  test("does not touch string literals that look like comments", () => {
    const src = `const s = "// not a comment";\nconst t = "/* still not */";\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).toContain("// not a comment");
    expect(out).toContain("/* still not */");
  });

  test("does not touch template literals containing /*", () => {
    const src = "const s = `/* literal */ value`;\n";
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).toContain("/* literal */");
  });

  test("collapses 3+ blank lines after stripping", () => {
    const src = `const x = 1;\n// removed\n\n\n\nconst y = 2;\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).not.toMatch(/\n{3,}/);
  });

  test("removes JSDoc between two top-level statements", () => {
    const src = `import { foo } from "bar";\n\n/**\n * Doc disappears.\n */\nexport const X = 1;\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).not.toContain("Doc disappears");
    expect(out).toContain('import { foo } from "bar"');
    expect(out).toContain("export const X = 1");
  });

  test("removes line comment between two adjacent statements (regression: visited-set conflation)", () => {
    const src = `const a = 1;\n// vanish\nconst b = 2;\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).not.toContain("vanish");
  });

  test("removes block comment between two top-level statements", () => {
    const src = `const a = 1;\n/* bye */\nconst b = 2;\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).not.toContain("bye");
  });
});

describe("stripRustSource", () => {
  test("removes line comments", () => {
    const src = `let x = 1; // removed\nlet y = 2;\n`;
    const { stripped, abstained } = stripRustSource(src);
    expect(abstained).toBe(false);
    expect(stripped).not.toContain("removed");
    expect(stripped).toContain("let x = 1");
    expect(stripped).toContain("let y = 2");
  });

  test("removes block comments", () => {
    const src = `/* block */\nlet x = 1;\n`;
    const { stripped, abstained } = stripRustSource(src);
    expect(abstained).toBe(false);
    expect(stripped).not.toContain("/* block */");
  });

  test("does not touch string literals", () => {
    const src = `let s = "// not a comment";\n`;
    const { stripped } = stripRustSource(src);
    expect(stripped).toContain("// not a comment");
  });

  test('does not touch raw strings r"..."', () => {
    const src = `let s = r"// raw, not a comment";\nlet y = 1; // gone\n`;
    const { stripped, abstained } = stripRustSource(src);
    expect(abstained).toBe(false);
    expect(stripped).toContain('r"// raw, not a comment"');
    expect(stripped).not.toContain("gone");
  });

  test('does not touch raw strings with hashes r#"..."#', () => {
    const src = `let s = r#"// also raw, with quote " inside"#;\nlet y = 1;\n`;
    const { stripped, abstained } = stripRustSource(src);
    expect(abstained).toBe(false);
    expect(stripped).toContain('r#"// also raw, with quote " inside"#');
  });

  test("preserves /* */ inside raw strings", () => {
    const src = `let s = r##"/* fake block */ /* still */"##;\nlet y = 1;\n`;
    const { stripped, abstained } = stripRustSource(src);
    expect(abstained).toBe(false);
    expect(stripped).toContain('r##"/* fake block */ /* still */"##');
  });

  test("abstains on unterminated raw string", () => {
    const src = `let s = r#"never closed\nlet y = 1;\n`;
    const { stripped, abstained } = stripRustSource(src);
    expect(abstained).toBe(true);
    expect(stripped).toBe(src);
  });

  test("preserves char literal 'x' and lifetime 'a", () => {
    const src = `let c = '/'; struct F<'a> { x: &'a str }\nlet y = 1; // gone\n`;
    const { stripped, abstained } = stripRustSource(src);
    expect(abstained).toBe(false);
    expect(stripped).toContain("let c = '/';");
    expect(stripped).toContain("'a");
    expect(stripped).not.toContain("gone");
  });

  test("honours PRESERVE_PRAGMAS — the Rust path used to ignore them entirely", () => {
    const src = `// cross-platform-ok\nlet x = 1;\n// ordinary\nlet y = 2;\n`;
    const { stripped } = stripRustSource(src);
    expect(stripped).toContain("cross-platform-ok");
    expect(stripped).not.toContain("ordinary");
  });

  test("does not collapse blank runs inside a raw string", () => {
    const src = `let s = r#"a\n\n\nb"#;\n`;
    const { stripped } = stripRustSource(src);
    expect(stripped).toContain("a\n\n\nb");
  });
});

// The stripper rewrites source in place, so a bug here is a silent data change rather
// than a failed run. These pin the two ways it used to corrupt a file.
describe("stripTsSource — does not edit program data", () => {
  test("leaves blank runs inside a template literal alone", () => {
    const src = "const help = `usage\n\n\ndetails`;\n";
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).toContain("usage\n\n\ndetails");
  });

  test("leaves blank runs inside a plain string alone", () => {
    const src = 'const sql = "SELECT 1;\\n\\n\\nSELECT 2;";\n';
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).toContain("SELECT 1;\\n\\n\\nSELECT 2;");
  });

  test("still collapses blank runs in code", () => {
    const src = `const x = 1;\n// removed\n\n\n\nconst y = 2;\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).not.toMatch(/\n{3,}/);
    expect(out).not.toContain("removed");
  });

  test("a trailing comment does not weld the next statement onto its line", () => {
    const src = `const a = 1; // gone\nconst b = 2;\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).not.toContain("gone");
    expect(out.split("\n").filter((l) => l.includes("const")).length).toBe(2);
  });

  test("keeps a preserved trailing pragma and its line break", () => {
    const src = `export const V = "7.7.0"; // x-release-please-version\nconst next = 1;\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).toContain("x-release-please-version");
    expect(out).toContain("const next = 1;");
  });
});
