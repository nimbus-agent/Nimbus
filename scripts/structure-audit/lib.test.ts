import { describe, expect, test } from "bun:test";
import { iterateSourceFiles, REPO_ROOT, stripComments, stripStringLiterals } from "./lib.ts";

describe("iterateSourceFiles", () => {
  // Collected once: the walk reads every production source file in the monorepo, so doing it
  // per-test would multiply the slowest part of this file by the number of assertions.
  const visited: string[] = [];
  const collected = (async (): Promise<void> => {
    for await (const f of iterateSourceFiles()) visited.push(f.relPath);
  })();

  test("visits the production source tree at all", async () => {
    await collected;
    // The floor the exclusion test below needs to mean anything. `expect(testingPaths)
    // .toEqual([])` is satisfied just as well by visiting NOTHING, and this generator is the
    // single source of files for every D10-D22 rule in check-nimbus-invariants.ts — so a walk
    // that silently stopped matching would leave those rules scanning an empty set and
    // reporting clean. That is not hypothetical: pointing the package glob at a directory
    // that does not exist still yields ~179 files from the mcp-connectors glob, which is why
    // the auditor's own floor keys on specific files rather than a count.
    expect(visited.length).toBeGreaterThan(500);
    expect(visited).toContain("packages/gateway/src/engine/executor.ts");
  });

  test("excludes paths under */testing/*", async () => {
    await collected;
    const testingPaths = visited.filter((p) => p.includes("/testing/"));
    expect(testingPaths).toEqual([]);
  });

  test("the */testing/* exclusion is actually doing work", async () => {
    await collected;
    // Guard the guard from the other side: if no such directory existed, the exclusion test
    // above would pass without the exclusion being written at all. Five exist today
    // (gateway/src/testing, gateway/src/identity/testing, gateway/src/updater/testing,
    // cli/src/commands/testing, cli/src/tui/testing), and each holds test-only scaffolding
    // that no production module imports.
    const glob = new Bun.Glob("packages/*/src/**/testing/**/*.ts");
    const onDisk: string[] = [];
    // REPO_ROOT, not `new URL(...).pathname` — a pathname is percent-encoded and carries a
    // leading slash on Windows, so it names a directory that is not there and the scan throws
    // ENOENT. lib.ts derives REPO_ROOT from import.meta.dir for exactly this reason.
    for await (const p of glob.scan({ cwd: REPO_ROOT })) {
      onDisk.push(p);
    }
    expect(onDisk.length).toBeGreaterThan(0);
  });

  test("excludes test files, declarations and fixtures", async () => {
    await collected;
    expect(visited.filter((p) => p.endsWith(".test.ts"))).toEqual([]);
    expect(visited.filter((p) => p.endsWith(".d.ts"))).toEqual([]);
    expect(visited.filter((p) => p.includes("/__fixtures__/"))).toEqual([]);
  });
});

describe("stripComments — regex literals", () => {
  test("a quote inside a regex literal does not open a phantom string", () => {
    const src = 'const RE = /(["|]) /;\n/** marker */\nconst a = 1;\n';
    expect(stripComments(src)).not.toContain("marker");
  });

  test("without the regex, the same comment is stripped", () => {
    expect(stripComments("const RE = 1;\n/** marker */\nconst a = 1;\n")).not.toContain("marker");
  });

  test("the regex literal itself survives comment stripping", () => {
    expect(stripComments('const RE = /a"b/;\nconst x = 1;\n')).toContain('/a"b/');
  });
});

describe("stripStringLiterals — regex literals", () => {
  test("a double quote inside a regex does not swallow the code after it", () => {
    const src = `const RE = /"([^"]*)"/m;\nconst z = Bun.spawnSync({ cmd: [] });`;
    expect(stripStringLiterals(stripComments(src))).toContain("Bun.spawnSync");
  });

  test("an apostrophe inside a regex does not swallow the code after it", () => {
    const src = `const RE = /it's/;\nconst z = Bun.spawnSync({ cmd: [] });`;
    expect(stripStringLiterals(stripComments(src))).toContain("Bun.spawnSync");
  });

  test("the regex body is blanked, so its contents cannot be read as code", () => {
    const out = stripStringLiterals(`const RE = /Bun.spawn\\(x\\)/;`);
    expect(out).not.toContain("Bun.spawn");
    expect(out).toContain("/");
  });

  test("division is not mistaken for a regex", () => {
    const src = `const q = a / b;\nconst z = Bun.spawn(a);`;
    expect(stripStringLiterals(src)).toBe(src);
  });

  test("division after a closing paren is not mistaken for a regex", () => {
    const src = `const q = (a + b) / 2;\nconst z = Bun.spawn(a);`;
    expect(stripStringLiterals(src)).toBe(src);
  });

  test("a slash inside a character class does not end the regex early", () => {
    const src = `const RE = /[/"]x/;\nconst z = Bun.spawn(a);`;
    expect(stripStringLiterals(stripComments(src))).toContain("Bun.spawn");
  });

  test("an escaped slash does not end the regex early", () => {
    const src = `const RE = /a\\/"b/;\nconst z = Bun.spawn(a);`;
    expect(stripStringLiterals(stripComments(src))).toContain("Bun.spawn");
  });

  test("a regex after `return` is recognised", () => {
    const src = `function f() { return /"/.test(x); }\nconst z = Bun.spawn(a);`;
    expect(stripStringLiterals(stripComments(src))).toContain("Bun.spawn");
  });

  test("an unclosed slash-on-one-line is treated as ordinary code, bounding any misparse", () => {
    // A real regex literal cannot span a newline, so refusing to cross one is what keeps a
    // wrong regex-vs-division call from eating the rest of the file.
    const src = `const q = x /y;\nconst z = Bun.spawn(a);`;
    expect(stripStringLiterals(src)).toContain("Bun.spawn");
  });

  test("length is preserved so callers can still recover line numbers", () => {
    const src = `const RE = /"([^"]*)"/m;\nconst z = 1;`;
    expect(stripStringLiterals(src)).toHaveLength(src.length);
  });

  test("a string literal is still blanked", () => {
    expect(stripStringLiterals(`const a = "secret";`)).toBe(`const a = "      ";`);
  });
});
