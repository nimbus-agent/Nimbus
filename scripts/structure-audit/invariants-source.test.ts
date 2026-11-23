import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { INVARIANTS_ENTRY_REL, readInvariantsSource } from "./invariants-source.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "invariants-source-"));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

describe("readInvariantsSource", () => {
  test("joins the entry and every non-test module under invariants/, in name order", () => {
    const root = tree({
      [INVARIANTS_ENTRY_REL]: 'import { b } from "./invariants/b.ts";\n',
      "scripts/structure-audit/invariants/b.ts": "// D2\n",
      "scripts/structure-audit/invariants/a.ts": "// D1\n",
      "scripts/structure-audit/invariants/a.test.ts": "// D99\n",
    });
    const text = readInvariantsSource(root);
    expect(text.indexOf("D1")).toBeLessThan(text.indexOf("D2"));
    expect(text).not.toContain("D99");
  });

  test("an entry with no invariants/ imports stands alone when the directory is missing", () => {
    const root = tree({ [INVARIANTS_ENTRY_REL]: "const a = /D10/;\n" });
    expect(readInvariantsSource(root)).toBe("const a = /D10/;\n");
  });

  test("an entry that imports invariants/ fails when the directory is missing", () => {
    const root = tree({ [INVARIANTS_ENTRY_REL]: 'import { a } from "./invariants/a.ts";\n' });
    expect(() => readInvariantsSource(root)).toThrow();
  });
});
