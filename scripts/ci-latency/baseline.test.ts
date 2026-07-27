import { describe, expect, test } from "bun:test";

import { computeUpdatedBaseline, parseBaseline, serializeBaseline } from "./baseline.ts";
import type { KeySummary, LatencyBaseline } from "./types.ts";

const sum = (over: Partial<KeySummary> & { key: string }): KeySummary => ({
  samples: 10,
  execMedian: 10,
  execSpread: 1,
  queueMedian: 0,
  dagWaitMedian: 0,
  ...over,
});

const base = (
  entries: Record<string, { execMedian: number; execSpread: number }>,
): LatencyBaseline => ({
  version: 1,
  generated_at: "2026-07-27T00:00:00Z",
  entries: new Map(Object.entries(entries)),
});

describe("parseBaseline / serializeBaseline", () => {
  test("round-trips entries", () => {
    const json = serializeBaseline(base({ "a :: b :: c": { execMedian: 5, execSpread: 1 } }));
    const back = parseBaseline(json);
    expect(back.entries.get("a :: b :: c")).toEqual({ execMedian: 5, execSpread: 1 });
  });
  test("an empty baseline parses to an empty map, not a throw", () => {
    expect(parseBaseline('{"version":1,"generated_at":"x","entries":{}}').entries.size).toBe(0);
  });
  test("malformed JSON throws with a message naming the file's purpose", () => {
    expect(() => parseBaseline("{nope")).toThrow(/ci-latency baseline/i);
  });
  test("serialised output ends with a newline so the file is diff-clean", () => {
    expect(serializeBaseline(base({})).endsWith("\n")).toBe(true);
  });
  test("entries serialise sorted, so a re-run never reorders the diff", () => {
    const json = serializeBaseline(
      base({
        "z :: z :: z": { execMedian: 1, execSpread: 0 },
        "a :: a :: a": { execMedian: 1, execSpread: 0 },
      }),
    );
    expect(json.indexOf("a :: a :: a")).toBeLessThan(json.indexOf("z :: z :: z"));
  });
});

describe("computeUpdatedBaseline", () => {
  const now = "2026-07-28T00:00:00Z";

  test("records a key seen for the first time", () => {
    const next = computeUpdatedBaseline(
      base({}),
      new Map([["k", sum({ key: "k", execMedian: 8 })]]),
      now,
    );
    expect(next.entries.get("k")?.execMedian).toBe(8);
  });

  test("ratchets DOWN when a job gets faster", () => {
    const next = computeUpdatedBaseline(
      base({ k: { execMedian: 10, execSpread: 2 } }),
      new Map([["k", sum({ key: "k", execMedian: 6, execSpread: 1 })]]),
      now,
    );
    expect(next.entries.get("k")?.execMedian).toBe(6);
    // the band travels with the median, so the lowered bound stays achievable
    expect(next.entries.get("k")?.execSpread).toBe(1);
  });

  test("does NOT ratchet down on too few samples", () => {
    // A few hot-cache runs is a plausible window; lowering demands more evidence
    // than gating does. 6 < MIN_SAMPLES_FOR_RATCHET (7).
    const next = computeUpdatedBaseline(
      base({ k: { execMedian: 10, execSpread: 2 } }),
      new Map([["k", sum({ key: "k", execMedian: 6, samples: 6 })]]),
      now,
    );
    expect(next.entries.get("k")?.execMedian).toBe(10);
  });

  test("raises the baseline when a job legitimately got slower", () => {
    // --update-baseline is an explicit human action accepting the new reality.
    const next = computeUpdatedBaseline(
      base({ k: { execMedian: 5, execSpread: 1 } }),
      new Map([["k", sum({ key: "k", execMedian: 9, execSpread: 2 })]]),
      now,
    );
    expect(next.entries.get("k")?.execMedian).toBe(9);
  });

  test("drops a key that no longer appears (renamed or deleted job)", () => {
    const next = computeUpdatedBaseline(
      base({ gone: { execMedian: 5, execSpread: 1 } }),
      new Map(),
      now,
    );
    expect(next.entries.has("gone")).toBe(false);
  });

  test("ignores a key with too few samples to be trusted at all", () => {
    const next = computeUpdatedBaseline(
      base({}),
      new Map([["k", sum({ key: "k", samples: 1 })]]),
      now,
    );
    expect(next.entries.has("k")).toBe(false);
  });

  test("stamps generated_at", () => {
    expect(computeUpdatedBaseline(base({}), new Map(), now).generated_at).toBe(now);
  });
});
