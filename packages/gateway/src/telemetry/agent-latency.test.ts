import { describe, expect, test } from "bun:test";

import { AGENT_LATENCY_RING_SIZE, AgentLatencyRecorder } from "./agent-latency.ts";

describe("AgentLatencyRecorder", () => {
  test("empty recorder reports 0/0, matching the value the payload carried before instrumentation", () => {
    expect(new AgentLatencyRecorder().percentiles()).toEqual({ p50Ms: 0, p95Ms: 0 });
  });

  test("known distribution: linear-interpolated p50/p95, rounded to integers", () => {
    const r = new AgentLatencyRecorder();
    for (let ms = 1; ms <= 100; ms += 1) r.record(ms);
    // sorted 1..100: p50 at rank 49.5 -> 50.5 -> 51 (Math.round); p95 at rank 94.05 -> 95.05 -> 95
    expect(r.percentiles()).toEqual({ p50Ms: 51, p95Ms: 95 });
  });

  test("order of recording does not matter", () => {
    const r = new AgentLatencyRecorder();
    for (const ms of [300, 100, 200]) r.record(ms);
    expect(r.percentiles()).toEqual({ p50Ms: 200, p95Ms: 290 });
  });

  test("non-finite and negative durations are dropped, never recorded", () => {
    const r = new AgentLatencyRecorder();
    r.record(Number.NaN);
    r.record(Number.POSITIVE_INFINITY);
    r.record(-5);
    expect(r.size()).toBe(0);
    expect(r.percentiles()).toEqual({ p50Ms: 0, p95Ms: 0 });
  });

  test("ring wraps: only the newest AGENT_LATENCY_RING_SIZE samples count", () => {
    const r = new AgentLatencyRecorder();
    for (let i = 0; i < AGENT_LATENCY_RING_SIZE; i += 1) r.record(10_000);
    for (let i = 0; i < AGENT_LATENCY_RING_SIZE; i += 1) r.record(7);
    expect(r.size()).toBe(AGENT_LATENCY_RING_SIZE);
    expect(r.percentiles()).toEqual({ p50Ms: 7, p95Ms: 7 });
  });

  test("partial wrap keeps the newest samples and evicts the oldest", () => {
    const r = new AgentLatencyRecorder();
    for (let i = 0; i < AGENT_LATENCY_RING_SIZE; i += 1) r.record(1);
    for (let i = 0; i < AGENT_LATENCY_RING_SIZE / 2 + 1; i += 1) r.record(1_000);
    // more than half of the ring is now 1000ms, so the median moved
    expect(r.percentiles().p50Ms).toBe(1_000);
    expect(r.size()).toBe(AGENT_LATENCY_RING_SIZE);
  });
});
