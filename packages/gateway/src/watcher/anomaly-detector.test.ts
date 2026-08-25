import { describe, expect, test } from "bun:test";

import { AnomalyDetectorStub } from "./anomaly-detector.ts";

describe("AnomalyDetectorStub", () => {
  test("low sample count yields zero score", () => {
    const d = new AnomalyDetectorStub({ windowSize: 8 });
    expect(d.deviationScore("x", 10)).toBe(0);
    d.recordSample("x", 1, 1);
    d.recordSample("x", 2, 2);
    expect(d.deviationScore("x", 100)).toBe(0);
  });

  test("extreme value increases deviation score", () => {
    const d = new AnomalyDetectorStub({ windowSize: 20 });
    for (let i = 0; i < 10; i += 1) {
      d.recordSample("latency", 100 + i, i);
    }
    const s = d.deviationScore("latency", 500);
    expect(s).toBeGreaterThan(2);
  });

  test("notify fires once score threshold reached", () => {
    let seen = 0;
    const d = new AnomalyDetectorStub({
      windowSize: 10,
      onNotify: () => {
        seen += 1;
      },
    });
    for (let i = 0; i < 8; i += 1) {
      d.recordSample("k", 10, i);
    }
    d.recordSample("k", 10_000, 9);
    expect(seen).toBe(1);
  });
});

describe("AnomalyDetectorStub — window and guards", () => {
  // The window is what makes this a DETECTOR rather than a lifetime average:
  // once a series settles at a new level, the old level must stop counting as
  // the baseline or every sample at the new level scores as an anomaly forever.
  test("old samples age out of the window", () => {
    const d = new AnomalyDetectorStub({ windowSize: 3 });
    for (let i = 0; i < 3; i += 1) d.recordSample("s", 10, i);
    for (let i = 0; i < 3; i += 1) d.recordSample("s", 20, 10 + i);
    // Window now holds [20, 20, 20]; the three 10s are gone.
    expect(d.deviationScore("s", 20)).toBe(0);
    expect(d.deviationScore("s", 10)).toBeGreaterThan(3);
  });

  test("the default window keeps the last 64 samples", () => {
    const d = new AnomalyDetectorStub();
    d.recordSample("s", 1_000_000, 0);
    for (let i = 0; i < 64; i += 1) d.recordSample("s", 10, i + 1);
    // 65 samples recorded, 64 retained — the outlier is the one evicted.
    expect(d.deviationScore("s", 10)).toBe(0);
  });

  // A flat series has zero standard deviation. Dividing by it would yield
  // Infinity or NaN, which propagates into the notification payload and any
  // downstream comparison silently becomes false.
  test("a perfectly flat series yields a finite score for a departure", () => {
    const d = new AnomalyDetectorStub({ windowSize: 8 });
    for (let i = 0; i < 5; i += 1) d.recordSample("flat", 10, i);
    const score = d.deviationScore("flat", 11);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThan(3);
  });

  test("a blank series id is ignored and records nothing", () => {
    let seen = 0;
    const d = new AnomalyDetectorStub({
      windowSize: 8,
      onNotify: () => {
        seen += 1;
      },
    });
    for (let i = 0; i < 6; i += 1) expect(d.recordSample("   ", 10, i)).toBe(0);
    expect(d.recordSample("   ", 10_000, 7)).toBe(0);
    expect(seen).toBe(0);
    // Nothing was stored under the trimmed key either.
    expect(d.deviationScore("", 10_000)).toBe(0);
  });

  test("setNotifyHandler installs a handler after construction", () => {
    const seen: number[] = [];
    const d = new AnomalyDetectorStub({ windowSize: 10 });
    d.setNotifyHandler((e) => seen.push(e.value));
    for (let i = 0; i < 8; i += 1) d.recordSample("k", 10, i);
    d.recordSample("k", 10_000, 9);
    expect(seen).toEqual([10_000]);
  });

  test("setNotifyHandler(undefined) silences an installed handler", () => {
    let seen = 0;
    const d = new AnomalyDetectorStub({
      windowSize: 10,
      onNotify: () => {
        seen += 1;
      },
    });
    d.setNotifyHandler(undefined);
    for (let i = 0; i < 8; i += 1) d.recordSample("k", 10, i);
    d.recordSample("k", 10_000, 9);
    expect(seen).toBe(0);
  });

  test("the notification carries the trimmed series id, value, score and timestamp", () => {
    const events: Array<{ seriesId: string; value: number; score: number; atMs: number }> = [];
    const d = new AnomalyDetectorStub({ windowSize: 10, onNotify: (e) => events.push({ ...e }) });
    for (let i = 0; i < 8; i += 1) d.recordSample("  latency  ", 10, i);
    const score = d.recordSample("  latency  ", 10_000, 12_345);
    expect(events).toHaveLength(1);
    expect(events[0]?.seriesId).toBe("latency");
    expect(events[0]?.value).toBe(10_000);
    expect(events[0]?.atMs).toBe(12_345);
    expect(events[0]?.score).toBe(score);
  });
});
