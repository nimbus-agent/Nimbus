import { describe, expect, test } from "bun:test";

import { median, observationKey, p90, summarize } from "./summarize.ts";
import type { JobObservation } from "./types.ts";

const obs = (over: Partial<JobObservation> = {}): JobObservation => ({
  repo: "Nimbus",
  workflow: "CI",
  job: "Unit + Coverage",
  exec: 10,
  queue: 1,
  dagWait: 0,
  ...over,
});

describe("median", () => {
  test("odd count takes the middle value", () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  test("even count averages the two middle values", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  test("a single outlier cannot drag it (this is why not a mean)", () => {
    // mean would be 12.6; the median ignores the contended 58-minute run.
    expect(median([3, 3, 4, 4, 58])).toBe(4);
  });
  test("empty is 0", () => {
    expect(median([])).toBe(0);
  });
});

describe("p90", () => {
  test("picks the 90th-percentile value by nearest rank", () => {
    // Nearest-rank p90 of 10 sorted values is the 9th, NOT the max. Using the
    // max here would make p90 degenerate to max at every sample size this gate
    // reaches, widening a noisy job's tolerance band ~6x and letting a real
    // regression through.
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
  });
  test("small samples fall back to the max", () => {
    expect(p90([2, 5])).toBe(5);
  });
  test("empty is 0", () => {
    expect(p90([])).toBe(0);
  });
});

describe("observationKey", () => {
  test("keys on repo, workflow and job so matrix legs stay distinct", () => {
    expect(observationKey(obs({ job: "Static — windows-2025" }))).toBe(
      "Nimbus :: CI :: Static — windows-2025",
    );
  });
});

describe("summarize", () => {
  test("groups by key and counts samples", () => {
    const m = summarize([obs({ exec: 10 }), obs({ exec: 12 }), obs({ exec: 14 })]);
    const s = m.get("Nimbus :: CI :: Unit + Coverage");
    expect(s?.samples).toBe(3);
    expect(s?.execMedian).toBe(12);
  });

  test("execSpread is p90 minus median — the job's own noise band", () => {
    // Nearest-rank p90 of 10 values is the 9th: 9. Median is 5.5. So the band
    // is 3.5 — a POSITIVE assertion of the number the whole tolerance
    // mechanism rests on. The 20 is deliberately excluded by p90, which is the
    // outlier-resistance this statistic exists for.
    const m = summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map((e) => obs({ exec: e })));
    const s = m.get("Nimbus :: CI :: Unit + Coverage");
    expect(s?.execMedian).toBe(5.5);
    expect(s?.execSpread).toBe(3.5);
  });

  test("a stable job has a near-zero spread", () => {
    const m = summarize([12, 12.2, 12.1].map((e) => obs({ exec: e })));
    expect(m.get("Nimbus :: CI :: Unit + Coverage")?.execSpread).toBeLessThan(0.5);
  });

  test("queue and dagWait are summarised independently of exec", () => {
    const m = summarize([
      obs({ exec: 10, queue: 30, dagWait: 5 }),
      obs({ exec: 10, queue: 2, dagWait: 5 }),
      obs({ exec: 10, queue: 2, dagWait: 5 }),
    ]);
    const s = m.get("Nimbus :: CI :: Unit + Coverage");
    expect(s?.queueMedian).toBe(2);
    expect(s?.dagWaitMedian).toBe(5);
  });

  test("different repos never share a key", () => {
    const m = summarize([obs(), obs({ repo: "nimbus-sdk" })]);
    expect(m.size).toBe(2);
  });

  test("no observations yields an empty map", () => {
    expect(summarize([]).size).toBe(0);
  });
});
