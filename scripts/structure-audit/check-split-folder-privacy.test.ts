import { describe, expect, test } from "bun:test";

import {
  derivePairs,
  EXEMPT_FOLDERS,
  EXPLICIT_PAIRS,
  findRelativeSpecifiers,
  findViolations,
  isTestFile,
  type SourceFile,
  staleTableEntries,
} from "./check-split-folder-privacy.ts";

const G = "packages/gateway/src";
const f = (path: string, contents = ""): SourceFile => ({ path, contents });

/** A split `ext/install.ts` + `ext/install/{plan,types}.ts`, plus the given extra files. */
function tree(...extra: SourceFile[]): SourceFile[] {
  return [
    f(`${G}/ext/install.ts`),
    f(`${G}/ext/install/plan.ts`),
    f(`${G}/ext/install/types.ts`),
    ...extra,
  ];
}

const violationsFor = (importer: string, contents: string): number =>
  findViolations(tree(f(importer, contents))).filter((v) => v.importer === importer).length;

describe("derivePairs", () => {
  test("a folder with a sibling .ts is a pair; a folder without one is not", () => {
    const pairs = pairsOf([...tree(), f(`${G}/ext/plain/a.ts`)]);
    expect(pairs.map((p) => p.dir)).toContain(`${G}/ext/install`);
    expect(pairs.map((p) => p.dir)).not.toContain(`${G}/ext/plain`);
  });

  test("a sibling .tsx is a facade too", () => {
    const pairs = pairsOf([f("packages/ui/src/Page.tsx"), f("packages/ui/src/Page/part.tsx")]);
    expect(pairs).toContainEqual({
      dir: "packages/ui/src/Page",
      facade: "packages/ui/src/Page.tsx",
    });
  });

  test("the explicit non-sibling pairs are always present", () => {
    const dirs = derivePairs([]).map((p) => p.dir);
    for (const e of EXPLICIT_PAIRS) expect(dirs).toContain(e.dir);
  });

  test("an exempt folder is not derived, by exact path only", () => {
    const [exempt] = Object.keys(EXEMPT_FOLDERS);
    expect(exempt).toBeDefined();
    const pairs = pairsOf([f(`${exempt}.ts`), f(`${exempt}/a.ts`), f(`${exempt}-other.ts`)]);
    expect(pairs.map((p) => p.dir)).not.toContain(exempt as string);
    // A folder that merely starts with the exempt path is not exempt.
    const near = pairsOf([f(`${exempt}x.ts`), f(`${exempt}x/a.ts`)]);
    expect(near.map((p) => p.dir)).toContain(`${exempt}x`);
  });
});

describe("findViolations", () => {
  test("a foreign importer is refused in every import spelling", () => {
    const importer = `${G}/other/user.ts`;
    const spellings = [
      `import { installApprovedPlan } from "../ext/install/plan.ts";`,
      `import { installApprovedPlan } from "../ext/install/plan";`,
      `import { installApprovedPlan } from "../ext/install/plan.js";`,
      `import "../ext/install/plan.ts";`,
      `import * as plan from "../ext/install/plan.ts";`,
      `import def from '../ext/install/plan.ts';`,
      `export { installApprovedPlan } from "../ext/install/plan.ts";`,
      `export * from "../ext/install/plan.ts";`,
      `const m = await import("../ext/install/plan.ts");`,
      `const m = require("../ext/install/plan.ts");`,
      `import {\n  a,\n  b,\n} from "../ext/install/plan.ts";`,
      `import { type Only } from "../ext/install/types.ts";`,
      `import { b, type T } from "../ext/install/types.ts";`,
    ];
    for (const s of spellings) expect(violationsFor(importer, s)).toBe(1);
  });

  test("a deeper relative spelling and a dot-slash spelling resolve to the same module", () => {
    expect(violationsFor(`${G}/ext/sub/user.ts`, `import { x } from "../install/plan.ts";`)).toBe(
      1,
    );
    expect(
      violationsFor(`${G}/ext/sub/deeper/user.ts`, `import { x } from "../../install/plan.ts";`),
    ).toBe(1);
    expect(violationsFor(`${G}/ext/user.ts`, `import { x } from "./install/plan.ts";`)).toBe(1);
  });

  test("import type and export type from are allowed", () => {
    const importer = `${G}/other/user.ts`;
    expect(violationsFor(importer, `import type { T } from "../ext/install/types.ts";`)).toBe(0);
    expect(violationsFor(importer, `import type * as T from "../ext/install/types.ts";`)).toBe(0);
    expect(violationsFor(importer, `export type { T } from "../ext/install/types.ts";`)).toBe(0);
    expect(
      violationsFor(importer, `import type {\n  A,\n  B,\n} from "../ext/install/types.ts";`),
    ).toBe(0);
  });

  test("a type import on the line before a value import does not excuse it", () => {
    const src = `import type { T } from "../ext/install/types.ts";\nimport { v } from "../ext/install/plan.ts";`;
    expect(violationsFor(`${G}/other/user.ts`, src)).toBe(1);
  });

  test("the facade is allowed", () => {
    expect(violationsFor(`${G}/ext/install.ts`, `import { x } from "./install/plan.ts";`)).toBe(0);
  });

  test("a sibling module inside the folder is allowed", () => {
    expect(violationsFor(`${G}/ext/install/types.ts`, `import { x } from "./plan.ts";`)).toBe(0);
    expect(violationsFor(`${G}/ext/install/deep/a.ts`, `import { x } from "../plan.ts";`)).toBe(0);
  });

  test("test files are allowed: *.test.ts and anything under a test directory", () => {
    const src = `import { x } from "../ext/install/plan.ts";`;
    expect(violationsFor(`${G}/other/user.test.ts`, src)).toBe(0);
    expect(violationsFor(`packages/gateway/test/helpers/user.ts`, src)).toBe(0);
    expect(isTestFile("packages/gateway/test/a.ts")).toBe(true);
    expect(isTestFile("packages/gateway/src/test-helpers.ts")).toBe(false);
  });

  test("going through the facade is clean", () => {
    expect(violationsFor(`${G}/other/user.ts`, `import { x } from "../ext/install.ts";`)).toBe(0);
    expect(violationsFor(`${G}/other/user.ts`, `import { x } from "../ext/install";`)).toBe(0);
  });

  test("a non-relative specifier and a similarly named sibling file are not matched", () => {
    expect(violationsFor(`${G}/other/user.ts`, `import { x } from "zod";`)).toBe(0);
    expect(
      violationsFor(`${G}/other/user.ts`, `import { x } from "../ext/install-other/a.ts";`),
    ).toBe(0);
  });

  test("the explicit non-sibling facade pair is enforced", () => {
    const dir = "packages/gateway/src/agents/_lib/negotiate";
    const files = [
      f("packages/gateway/src/agents/negotiate.ts"),
      f(`${dir}/subject.ts`),
      f("packages/gateway/src/agents/other.ts", `import { s } from "./_lib/negotiate/subject.ts";`),
      f(
        "packages/gateway/src/agents/negotiate.test.ts",
        `import { s } from "./_lib/negotiate/subject.ts";`,
      ),
    ];
    const v = findViolations(files);
    expect(v.map((x) => x.importer)).toEqual(["packages/gateway/src/agents/other.ts"]);
    expect(v[0]?.facade).toBe("packages/gateway/src/agents/negotiate.ts");
  });

  test("an exempt folder is not policed", () => {
    const [exempt] = Object.keys(EXEMPT_FOLDERS);
    const base = exempt as string;
    const files = [
      f(`${base}.ts`),
      f(`${base}/a.ts`),
      f(
        `${G}/other/user.ts`,
        `import { x } from "${"../".repeat(0)}${relativeTo(`${G}/other`, `${base}/a.ts`)}";`,
      ),
    ];
    expect(findViolations(files)).toEqual([]);
  });

  test("the violation reports the line", () => {
    const [v] = findViolations(
      tree(f(`${G}/other/user.ts`, `// c\n\nimport { x } from "../ext/install/plan.ts";`)),
    );
    expect(v?.line).toBe(3);
    expect(v?.target).toBe(`${G}/ext/install/plan`);
  });
});

describe("findRelativeSpecifiers", () => {
  test("flags type-only statements and nothing else", () => {
    const r = findRelativeSpecifiers(
      `import type { A } from "./a.ts";\nimport { B } from "./b.ts";\nexport type { C } from "./c.ts";`,
    );
    expect(r.map((x) => x.typeOnly)).toEqual([true, false, true]);
  });
});

describe("staleTableEntries", () => {
  test("is clean when the table matches the tree, and names a missing facade", () => {
    const real = EXPLICIT_PAIRS.flatMap((e) => [e.facade, `${e.dir}/x.ts`]);
    const exempt = Object.keys(EXEMPT_FOLDERS).map((d) => `${d}.ts`);
    expect(staleTableEntries([...real, ...exempt])).toEqual([]);
    expect(staleTableEntries([]).length).toBeGreaterThan(0);
  });
});

function relativeTo(fromDir: string, to: string): string {
  const a = fromDir.split("/");
  const b = to.split("/");
  while (a.length > 0 && b.length > 0 && a[0] === b[0]) {
    a.shift();
    b.shift();
  }
  return `${"../".repeat(a.length)}${b.join("/")}`;
}

function pairsOf(files: readonly SourceFile[]) {
  return derivePairs(files.map((x) => x.path));
}
