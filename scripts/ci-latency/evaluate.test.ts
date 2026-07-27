import { describe, expect, test } from "bun:test";

import { evaluate } from "./evaluate.ts";
import type { KeySummary, LatencyBaseline } from "./types.ts";

const sum = (over: Partial<KeySummary> & { key: string }): KeySummary => ({
  samples: 10,
  execMedian: 10,
  execSpread: 1,
  queueMedian: 0,
  dagWaitMedian: 0,
  ...over,
});
const base = (e: Record<string, { execMedian: number; execSpread: number }>): LatencyBaseline => ({
  version: 1,
  generated_at: "x",
  entries: new Map(Object.entries(e)),
});
const kinds = (r: { findings: { key: string; kind: string }[] }, key: string) =>
  r.findings.filter((f) => f.key === key).map((f) => f.kind);

describe("evaluate", () => {
  test("a job within its noise band is not a finding", () => {
    const r = evaluate(
      new Map([["k", sum({ key: "k", execMedian: 10.5 })]]),
      base({ k: { execMedian: 10, execSpread: 2 } }),
    );
    expect(r.regressions).toEqual([]);
  });

  test("a regression beyond the band fails", () => {
    // Ubuntu Unit+Coverage: median 12.2, spread 2.0 — a 4-minute regression must
    // fail. Under a flat 50% tolerance it needed 6.1 and would have passed.
    const r = evaluate(
      new Map([["k", sum({ key: "k", execMedian: 16.2 })]]),
      base({ k: { execMedian: 12.2, execSpread: 2 } }),
    );
    expect(r.regressions.map((f) => f.key)).toEqual(["k"]);
    expect(r.regressions[0]?.detail).toContain("12.2");
  });

  test("a noisy job gets its own wide band, not a global constant", () => {
    // Windows Unit+Coverage: median 13.2, spread 14.5. A 10-minute swing is this
    // job's normal behaviour and must NOT fail; a global 3-minute cap would.
    const r = evaluate(
      new Map([["k", sum({ key: "k", execMedian: 23.2 })]]),
      base({ k: { execMedian: 13.2, execSpread: 14.5 } }),
    );
    expect(r.regressions).toEqual([]);
  });

  test("MIN_ABSOLUTE_DELTA floors the band on a sub-minute job", () => {
    // 0.3 -> 0.5 is +67% but irrelevant; the 1-minute floor absorbs it.
    const r = evaluate(
      new Map([["k", sum({ key: "k", execMedian: 0.5 })]]),
      base({ k: { execMedian: 0.3, execSpread: 0 } }),
    );
    expect(r.regressions).toEqual([]);
  });

  test("too few samples is insufficient-data, never a regression", () => {
    const r = evaluate(
      new Map([["k", sum({ key: "k", execMedian: 99, samples: 2 })]]),
      base({ k: { execMedian: 1, execSpread: 0 } }),
    );
    expect(kinds(r, "k")).toContain("insufficient-data");
    expect(r.regressions).toEqual([]);
  });

  test("a key absent from the baseline is new-key, never a regression", () => {
    const r = evaluate(new Map([["k", sum({ key: "k" })]]), base({}));
    expect(kinds(r, "k")).toContain("new-key");
    expect(r.regressions).toEqual([]);
  });

  test("a baseline entry with no observations is stale, never a regression", () => {
    const r = evaluate(new Map(), base({ gone: { execMedian: 5, execSpread: 1 } }));
    expect(kinds(r, "gone")).toContain("stale-baseline-entry");
    expect(r.regressions).toEqual([]);
  });

  test("an erratic job is reported unstable but never failed for it", () => {
    const r = evaluate(
      new Map([["k", sum({ key: "k", execMedian: 13.2, execSpread: 14.5 })]]),
      base({ k: { execMedian: 13.2, execSpread: 14.5 } }),
    );
    expect(kinds(r, "k")).toContain("unstable");
    expect(r.regressions).toEqual([]);
  });

  test("a stable job is not reported unstable", () => {
    const r = evaluate(
      new Map([["k", sum({ key: "k", execMedian: 12, execSpread: 1 })]]),
      base({ k: { execMedian: 12, execSpread: 1 } }),
    );
    expect(kinds(r, "k")).not.toContain("unstable");
  });
});
