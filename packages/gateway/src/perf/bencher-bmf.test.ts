import { describe, expect, test } from "bun:test";
import { toBencherBmf } from "./bencher-bmf.ts";
import type { HistoryLine } from "./history-line.ts";

function baseLine(surfaces: HistoryLine["surfaces"]): HistoryLine {
  return {
    schema_version: 2,
    run_id: "run-1",
    timestamp: "2026-06-16T00:00:00.000Z",
    runner: "gha-ubuntu",
    os_version: "linux x64",
    nimbus_git_sha: "abc123",
    bun_version: "1.2.0",
    surfaces,
  };
}

describe("toBencherBmf", () => {
  test("maps a trend latency surface (S1) to the `latency` measure", () => {
    expect(toBencherBmf(baseLine({ S1: { samples_count: 5, p95_ms: 812.5 } }))).toEqual({
      S1: { latency: { value: 812.5 } },
    });
  });

  test("maps a trend memory surface (S7-a) to the `memory` measure", () => {
    expect(
      toBencherBmf(baseLine({ "S7-a": { samples_count: 5, rss_bytes_p95: 134_217_728 } })),
    ).toEqual({ "S7-a": { memory: { value: 134_217_728 } } });
  });

  test("INCLUDES throughput trend surfaces (S10) — the gap vs the g-a-b emitter", () => {
    expect(toBencherBmf(baseLine({ S10: { samples_count: 5, throughput_per_sec: 999 } }))).toEqual({
      S10: { throughput: { value: 999 } },
    });
  });

  test("does NOT emit gate-class surfaces (S2-a)", () => {
    expect(toBencherBmf(baseLine({ "S2-a": { samples_count: 5, p95_ms: 12.3 } }))).toEqual({});
  });

  test("does NOT emit reference-class surfaces (S9)", () => {
    expect(toBencherBmf(baseLine({ S9: { samples_count: 5, tokens_per_sec: 41 } }))).toEqual({});
  });

  test("skips a stub surface (samples_count===0)", () => {
    expect(toBencherBmf(baseLine({ S4: { samples_count: 0, stub_reason: "stub" } }))).toEqual({});
  });

  test("skips a trend surface whose metric value is absent", () => {
    expect(toBencherBmf(baseLine({ S1: { samples_count: 5 } }))).toEqual({});
  });

  test("ignores a non-finite metric value", () => {
    expect(
      toBencherBmf(baseLine({ S1: { samples_count: 5, p95_ms: Number.POSITIVE_INFINITY } })),
    ).toEqual({});
  });

  test("emits multiple surfaces keyed by surfaceId", () => {
    expect(
      toBencherBmf(
        baseLine({
          S1: { samples_count: 5, p95_ms: 800 },
          "S7-a": { samples_count: 5, rss_bytes_p95: 100 },
          S10: { samples_count: 5, throughput_per_sec: 999 },
        }),
      ),
    ).toEqual({
      S1: { latency: { value: 800 } },
      "S7-a": { memory: { value: 100 } },
      S10: { throughput: { value: 999 } },
    });
  });

  test("returns an empty object when no trend surface has data (skip-on-empty input)", () => {
    expect(toBencherBmf(baseLine({}))).toEqual({});
  });
});
