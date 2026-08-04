// scripts/typecheck-tests/parse.test.ts
import { describe, expect, test } from "bun:test";
import { parseTscOutput } from "./parse.ts";

describe("parseTscOutput", () => {
  test("keys by (file, code) and counts occurrences", () => {
    const raw = [
      "packages/gateway/test/a.ts(12,3): error TS2554: Expected 5 arguments, but got 3.",
      "packages/gateway/test/a.ts(40,7): error TS2554: Expected 5 arguments, but got 3.",
      "packages/gateway/test/b.ts(9,1): error TS2532: Object is possibly 'undefined'.",
      "  Types of property 'x' are incompatible.", // continuation line — must be ignored
    ].join("\n");
    const out = parseTscOutput(raw);
    expect(out.get("packages/gateway/test/a.ts")?.get("TS2554")).toBe(2);
    expect(out.get("packages/gateway/test/b.ts")?.get("TS2532")).toBe(1);
    expect(out.size).toBe(2);
  });

  test("normalizes Windows separators to forward slashes", () => {
    const raw = String.raw`packages\gateway\test\a.ts(1,1): error TS2554: nope.`;
    const out = parseTscOutput(raw);
    expect([...out.keys()]).toEqual(["packages/gateway/test/a.ts"]);
  });

  test("ignores lines that are not error records", () => {
    expect(parseTscOutput("Found 3 errors.\n\n").size).toBe(0);
  });

  test("strips an absolute repo-root prefix so keys stay repo-relative", () => {
    const raw = "C:/gitrep/Nimbus/packages/gateway/test/a.ts(1,1): error TS2554: nope.";
    const out = parseTscOutput(raw, "C:/gitrep/Nimbus");
    expect([...out.keys()]).toEqual(["packages/gateway/test/a.ts"]);
  });

  test("leaves already-relative paths untouched when a root is supplied", () => {
    const raw = "packages/gateway/test/a.ts(1,1): error TS2554: nope.";
    const out = parseTscOutput(raw, "C:/gitrep/Nimbus");
    expect([...out.keys()]).toEqual(["packages/gateway/test/a.ts"]);
  });
});
