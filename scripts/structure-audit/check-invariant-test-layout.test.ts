import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The invariant enforcement tests live one file per invariant under
 * `packages/gateway/src/security-invariants/` (they were one 17,000-line file until 2026-11-22).
 * This guard keeps that layout honest: a live `## I<N>` heading in docs/SECURITY-INVARIANTS.md
 * with no `describe("I<N> ...")` anywhere in the folder is an invariant with no enforcement test,
 * and a file named `iNN-*` that holds no `describe("INN ...")` is a block that wandered off.
 */
const REPO_ROOT = resolve(import.meta.dir, "../..");
const DIR = join(REPO_ROOT, "packages/gateway/src/security-invariants");
const OLD_FILE = join(REPO_ROOT, "packages/gateway/src/security-invariants.test.ts");

function liveInvariantNumbers(doc: string): number[] {
  const out: number[] = [];
  for (const line of doc.split("\n")) {
    const m = /^## I(\d+)\b(.*)$/.exec(line);
    if (!m) continue;
    // A retired or merely reserved invariant keeps its heading but has no test to find.
    if (/\b(retired|reserved)\b/i.test(m[2] ?? "")) continue;
    out.push(Number(m[1]));
  }
  return out;
}

function describedInvariantNumbers(files: Record<string, string>): Set<number> {
  const out = new Set<number>();
  for (const text of Object.values(files)) {
    for (const m of text.matchAll(/^describe\("I(\d+)\b/gm)) out.add(Number(m[1]));
  }
  return out;
}

function readFolder(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(DIR)) {
    if (f.endsWith(".test.ts")) out[f] = readFileSync(join(DIR, f), "utf8");
  }
  return out;
}

describe("invariant test layout", () => {
  test("the old single file is gone and the folder holds the tests", () => {
    expect(existsSync(OLD_FILE)).toBe(false);
    expect(Object.keys(readFolder()).length).toBeGreaterThan(0);
  });

  test("every live invariant heading has a describe block in the folder", () => {
    const doc = readFileSync(join(REPO_ROOT, "docs/SECURITY-INVARIANTS.md"), "utf8");
    const live = liveInvariantNumbers(doc);
    expect(live.length).toBeGreaterThan(50);
    const described = describedInvariantNumbers(readFolder());
    const missing = live.filter((n) => !described.has(n)).map((n) => `I${n}`);
    expect(missing).toEqual([]);
  });

  test("a file named iNN-* holds a describe for that invariant, and every file is named by the scheme", () => {
    for (const [name, text] of Object.entries(readFolder())) {
      const m = /^i(\d{2})-[a-z0-9-]+\.test\.ts$/.exec(name);
      if (!m) {
        expect(name).toMatch(/^x-[a-z0-9-]+\.test\.ts$/);
        continue;
      }
      const n = Number(m[1]);
      expect(text).toMatch(new RegExp(String.raw`^describe\("I${n}\b`, "m"));
    }
  });

  test("the extractors see what they should (positive controls)", () => {
    expect(liveInvariantNumbers("## I1 — a\n## I2 — b (reserved)\n### I3\n## I10 — c\n")).toEqual([
      1, 10,
    ]);
    expect(
      [
        ...describedInvariantNumbers({ a: 'describe("I7 — x", () => {});\ndescribe("I70 — y"' }),
      ].sort((a, b) => a - b),
    ).toEqual([7, 70]);
  });
});
