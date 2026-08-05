// scripts/typecheck-tests/baseline.test.ts
import { describe, expect, test } from "bun:test";
import { evaluate, parseBaseline, serializeBaseline } from "./baseline.ts";
import type { ErrorCounts } from "./parse.ts";

function counts(o: Record<string, Record<string, number>>): ErrorCounts {
  return new Map(Object.entries(o).map(([f, c]) => [f, new Map(Object.entries(c))]));
}

/** Default predicate for cases that are not about deletion: every baselined file still exists. */
const allExist = (): boolean => true;

describe("evaluate", () => {
  test("unchanged counts produce no violations", () => {
    const c = counts({ "a.ts": { TS1: 2 } });
    expect(evaluate(c, counts({ "a.ts": { TS1: 2 } }), allExist)).toEqual([]);
  });

  test("a higher count for a known (file, code) is a regression", () => {
    const v = evaluate(counts({ "a.ts": { TS1: 3 } }), counts({ "a.ts": { TS1: 2 } }), allExist);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      kind: "regression",
      file: "a.ts",
      code: "TS1",
      baseline: 2,
      actual: 3,
    });
  });

  test("a NEW code in a known file fails (this is the #1038 case)", () => {
    const v = evaluate(
      counts({ "a.ts": { TS1: 2, TS2554: 5 } }),
      counts({ "a.ts": { TS1: 2 } }),
      allExist,
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: "regression", code: "TS2554", baseline: 0, actual: 5 });
  });

  test("a file absent from the baseline fails", () => {
    const v = evaluate(counts({ "new.ts": { TS1: 1 } }), counts({}), allExist);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: "new_file", file: "new.ts" });
  });

  test("a LOWER count must be banked — the ratchet does not leave slack behind", () => {
    const v = evaluate(counts({ "a.ts": { TS1: 1 } }), counts({ "a.ts": { TS1: 2 } }), allExist);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      kind: "must_raise",
      file: "a.ts",
      code: "TS1",
      baseline: 2,
      actual: 1,
    });
  });

  test("a fully fixed (file, code) must be banked too", () => {
    const v = evaluate(counts({}), counts({ "a.ts": { TS1: 2 } }), allExist);
    expect(v).toEqual([{ kind: "must_raise", file: "a.ts", code: "TS1", baseline: 2, actual: 0 }]);
  });

  test("a baselined file that no longer exists is a phantom allowance", () => {
    const v = evaluate(counts({}), counts({ "gone.ts": { TS1: 2 } }), (f) => f !== "gone.ts");
    expect(v).toEqual([{ kind: "must_remove", file: "gone.ts" }]);
  });

  test("a deleted file reports must_remove ONCE, not one must_raise per code", () => {
    const v = evaluate(counts({}), counts({ "gone.ts": { TS1: 2, TS2: 3, TS3: 1 } }), () => false);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: "must_remove" });
  });
});

describe("serializeBaseline", () => {
  test("writes keys sorted, so diffs stay reviewable", () => {
    const json = serializeBaseline(counts({ "b.ts": { TS2: 1 }, "a.ts": { TS9: 1, TS1: 1 } }), "T");
    expect(json.indexOf('"a.ts"')).toBeLessThan(json.indexOf('"b.ts"'));
    expect(json.indexOf('"TS1"')).toBeLessThan(json.indexOf('"TS9"'));
  });

  test("round-trips through parseBaseline", () => {
    const c = counts({ "a.ts": { TS1: 2 }, "b.ts": { TS3: 1 } });
    expect(parseBaseline(serializeBaseline(c, "T"))).toEqual(c);
  });
});
