import { describe, expect, test } from "bun:test";

import { AgentLatencyRecorder } from "../../telemetry/agent-latency.ts";
import { timeBriefSettlement } from "./brief-latency.ts";

class Capturing extends AgentLatencyRecorder {
  readonly samples: number[] = [];
  override record(ms: number): void {
    this.samples.push(ms);
  }
}

function clock(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

describe("timeBriefSettlement", () => {
  test("records dispatch -> briefReady once, and still forwards every notification", () => {
    const rec = new Capturing();
    const seen: string[] = [];
    const notify = timeBriefSettlement((m) => seen.push(m), rec, clock(1_000, 1_250, 9_999));
    notify("why.progress", {});
    notify("why.briefReady", { sessionId: "s" });
    notify("why.briefReady", { sessionId: "s" });
    expect(rec.samples).toEqual([250]);
    expect(seen).toEqual(["why.progress", "why.briefReady", "why.briefReady"]);
  });

  test("records dispatch -> briefError too", () => {
    const rec = new Capturing();
    const notify = timeBriefSettlement(() => {}, rec, clock(10, 40));
    notify("catchup.briefError", { error: "x" });
    expect(rec.samples).toEqual([30]);
  });

  test("a non-terminal notification records nothing", () => {
    const rec = new Capturing();
    const notify = timeBriefSettlement(() => {}, rec, clock(0, 5));
    notify("consent.request", {});
    expect(rec.samples).toEqual([]);
  });

  test("a throwing recorder never stops the notification reaching the caller", () => {
    const rec = new (class extends AgentLatencyRecorder {
      override record(): void {
        throw new Error("boom");
      }
    })();
    const seen: string[] = [];
    const notify = timeBriefSettlement((m) => seen.push(m), rec, clock(0, 1));
    notify("why.briefReady", {});
    expect(seen).toEqual(["why.briefReady"]);
  });
});
