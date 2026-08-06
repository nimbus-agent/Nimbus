import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { checkImportMetaDir } from "./check-import-meta-dir.ts";

const ROOT = mkdtempSync(join(tmpdir(), "nimbus-meta-dir-audit-"));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function fixture(rel: string, source: string): void {
  const full = join(ROOT, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, source);
}

fixture("ipc/bad-dir.ts", `const p = resolve(import.meta.dir, "..", "x.yaml");\n`);
fixture("ipc/bad-dirname.ts", `const p = join(import.meta.dirname, "x");\n`);
fixture("ipc/bad-path.ts", `const p = import.meta.path;\n`);
fixture("ipc/bad-file.ts", `const p = import.meta.file;\n`);
fixture("ipc/bad-fileurl.ts", `const d = dirname(fileURLToPath(import.meta.url));\n`);
// A formatter wrapping a long line produces exactly this. A line-by-line scan misses it.
fixture(
  "ipc/bad-fileurl-multiline.ts",
  `const d = dirname(\n  fileURLToPath(\n    import.meta.url,\n  ),\n);\n`,
);
fixture("ipc/bad-dir-multiline.ts", `const p = resolve(\n  import.meta\n    .dir,\n  "x",\n);\n`);
fixture("ipc/bad-twice.ts", `const a = import.meta.dir;\nconst b = import.meta.path;\n`);
fixture("ipc/ok-comment.ts", `// baseDir is the caller's import.meta.dir\nexport const x = 1;\n`);
fixture("ipc/ok-worker.ts", `new Worker(new URL("./w.ts", import.meta.url).href);\n`);
fixture("ipc/ok-asset.ts", `import p from "./a.html" with { type: "file" };\n`);
fixture("perf/surfaces/bench-x.ts", `const p = resolve(import.meta.dir, "..", "index.ts");\n`);
fixture("ipc/thing.test.ts", `const p = join(import.meta.dir, "fixture.json");\n`);
fixture("ipc/shapes.d.ts", `declare const p: typeof import.meta.dir;\n`);
fixture("platform/runtime-layout.ts", `const D = dirname(fileURLToPath(import.meta.url));\n`);

function flagged(): string[] {
  return checkImportMetaDir(ROOT)
    .map((v) => v.file)
    .sort((a, b) => a.localeCompare(b));
}

describe("checkImportMetaDir", () => {
  test("flags every filesystem-path form of import.meta", () => {
    expect(flagged()).toEqual([
      "ipc/bad-dir-multiline.ts",
      "ipc/bad-dir.ts",
      "ipc/bad-dirname.ts",
      "ipc/bad-file.ts",
      "ipc/bad-fileurl-multiline.ts",
      "ipc/bad-fileurl.ts",
      "ipc/bad-path.ts",
      "ipc/bad-twice.ts",
      "ipc/bad-twice.ts", // two occurrences in one file — both reported
    ]);
  });

  test("catches an expression a formatter split across lines", () => {
    // The line-by-line scan this replaced returned exit 0 for both of these.
    const v = checkImportMetaDir(ROOT);
    const wrapped = v.find((x) => x.file === "ipc/bad-fileurl-multiline.ts");
    expect(wrapped?.line).toBe(2); // the line the expression STARTS on, not where it ends
    expect(wrapped?.snippet).toBe("fileURLToPath( import.meta.url, )");
    const dotted = v.find((x) => x.file === "ipc/bad-dir-multiline.ts");
    expect(dotted?.line).toBe(2);
    expect(dotted?.snippet).toBe("import.meta .dir");
  });

  test("reports every occurrence in a file, not just the first", () => {
    const hits = checkImportMetaDir(ROOT).filter((x) => x.file === "ipc/bad-twice.ts");
    expect(hits.map((h) => h.line)).toEqual([1, 2]);
  });

  test("reports a 1-based line number and the offending source line", () => {
    const v = checkImportMetaDir(ROOT).find((x) => x.file === "ipc/bad-dir.ts");
    expect(v?.line).toBe(1);
    expect(v?.snippet).toContain("import.meta.dir");
  });

  test("ignores prose mentions in comments", () => {
    expect(flagged()).not.toContain("ipc/ok-comment.ts");
  });

  test("ignores the bundler-rewritten Worker URL form", () => {
    expect(flagged()).not.toContain("ipc/ok-worker.ts");
  });

  test("ignores an embedded asset import", () => {
    expect(flagged()).not.toContain("ipc/ok-asset.ts");
  });

  test("ignores perf bench surfaces, test files and declaration files", () => {
    expect(flagged()).not.toContain("perf/surfaces/bench-x.ts");
    expect(flagged()).not.toContain("ipc/thing.test.ts");
    expect(flagged()).not.toContain("ipc/shapes.d.ts");
  });

  test("allows the canonical runtime-layout module", () => {
    expect(flagged()).not.toContain("platform/runtime-layout.ts");
  });

  test("the real gateway source tree is clean", () => {
    expect(checkImportMetaDir()).toEqual([]);
  });
});
