import { describe, expect, test } from "bun:test";

import { parseEvalQuality, readVersionQuality } from "./eval-quality.ts";
import type { EvalQuality } from "./eval-score.ts";
import type { RegistryVersionEntry } from "./index-format.ts";

const valid = (): EvalQuality => ({
  scorer: 1,
  score: 66,
  cases: 3,
  passed: 2,
  rubrics: {
    exact: { cases: 1, passed: 1 },
    "json-match": { cases: 1, passed: 1 },
    "one-of": { cases: 1, passed: 0 },
  },
});

function refused(raw: unknown): string {
  try {
    parseEvalQuality(raw);
  } catch (e) {
    const err = e as { code?: string; detail?: string };
    expect(err.code).toBe("ERR_REGISTRY_EVAL_QUALITY_INVALID");
    return err.detail ?? "";
  }
  throw new Error("expected refusal");
}

const mut = (f: (q: Record<string, unknown>) => void): unknown => {
  const q = valid() as unknown as Record<string, unknown>;
  f(q);
  return q;
};
const rub = (q: Record<string, unknown>) => q["rubrics"] as Record<string, unknown>;

describe("parseEvalQuality", () => {
  test("a valid quality round-trips", () => {
    expect(parseEvalQuality(valid())).toEqual(valid());
  });

  test("refusals", () => {
    refused(null);
    refused([]);
    refused("x");
    refused(mut((q) => (q["scorer"] = 2)));
    refused(mut((q) => (q["score"] = 101)));
    expect(refused(mut((q) => (q["score"] = 70)))).toContain("score does not match");
    refused(mut((q) => (q["score"] = 66.5)));
    refused(mut((q) => (q["passed"] = 4)));
    refused(mut((q) => (q["passed"] = -1)));
    refused(mut((q) => (q["cases"] = 0)));
    refused(mut((q) => (q["cases"] = 201)));
    refused(mut((q) => (q["cases"] = 2.5)));
    refused(mut((q) => (q["results"] = [])));
    refused(mut((q) => delete q["score"]));
    refused(mut((q) => delete rub(q)["one-of"]));
    refused(mut((q) => (rub(q)["extra"] = { cases: 0, passed: 0 })));
    expect(refused(mut((q) => (rub(q)["exact"] = { cases: 2, passed: 1 })))).toContain("sum");
    refused(mut((q) => (rub(q)["exact"] = { cases: 1, passed: 2 })));
    refused(mut((q) => (rub(q)["exact"] = { cases: 1.5, passed: 1 })));
    refused(mut((q) => (rub(q)["exact"] = { cases: 1, passed: 1, x: 1 })));
    refused(mut((q) => (rub(q)["exact"] = "no")));
    refused(mut((q) => (q["rubrics"] = null)));
    refused(mut((q) => (rub(q)["exact"] = { cases: 1, passed: 0 })));
  });
});

const entry = (extra: Record<string, unknown>): RegistryVersionEntry =>
  ({ channel: "stable", ...extra }) as unknown as RegistryVersionEntry;

describe("readVersionQuality", () => {
  test("unscored without the field", () => {
    expect(readVersionQuality(entry({}))).toEqual({ state: "unscored" });
  });
  test("scored for a valid quality", () => {
    expect(readVersionQuality(entry({ quality: valid() }))).toEqual({
      state: "scored",
      quality: valid(),
    });
  });
  test("invalid, with the reason, for a malformed quality; never throws", () => {
    for (const quality of [{ score: "high" }, null, 7, "x"]) {
      const r = readVersionQuality(entry({ quality }));
      expect(r.state).toBe("invalid");
      if (r.state === "invalid") expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});
