import { describe, expect, test } from "bun:test";

import { AgentLatencyRecorder } from "../telemetry/agent-latency.ts";
import { AskExplainRecorder } from "./ask-explain-recorder.ts";
import { makeRunAskParams } from "./run-ask.test-helpers.ts";
import { runAsk } from "./run-ask.ts";

/** Captures every recorded duration; percentile behaviour stays real. */
class CapturingLatencyRecorder extends AgentLatencyRecorder {
  readonly samples: number[] = [];
  override record(durationMs: number): void {
    this.samples.push(durationMs);
    super.record(durationMs);
  }
}

class ThrowingLatencyRecorder extends AgentLatencyRecorder {
  override record(): void {
    throw new Error("latency recorder boom");
  }
}

describe("runAsk agent-invocation latency (telemetry)", () => {
  test("a successful ask records exactly one duration", async () => {
    const lat = new CapturingLatencyRecorder();
    await runAsk({ ...makeRunAskParams({ input: "ok question" }), agentLatencyRecorder: lat });
    expect(lat.samples).toHaveLength(1);
    expect(Number.isFinite(lat.samples[0])).toBe(true);
    expect(lat.samples[0]).toBeGreaterThanOrEqual(0);
  });

  test("a failed ask records exactly one duration and still throws", async () => {
    const lat = new CapturingLatencyRecorder();
    await expect(
      runAsk({
        ...makeRunAskParams({ input: "boom", throwAt: "model" }),
        agentLatencyRecorder: lat,
      }),
    ).rejects.toThrow();
    expect(lat.samples).toHaveLength(1);
  });

  test("same population as `nimbus explain last`: one sample per explain record", async () => {
    const lat = new CapturingLatencyRecorder();
    const explain = new AskExplainRecorder();
    await runAsk({
      ...makeRunAskParams({ input: "q1", explainRecorder: explain }),
      agentLatencyRecorder: lat,
    });
    await runAsk({
      ...makeRunAskParams({ input: "q2", explainRecorder: explain, throwAt: "classification" }),
      agentLatencyRecorder: lat,
    }).catch(() => undefined);
    expect(lat.samples).toHaveLength(explain.size());
    expect(lat.samples).toHaveLength(2);
  });

  test("a throwing latency recorder never changes the answer", async () => {
    const out = await runAsk({
      ...makeRunAskParams({ input: "ok question" }),
      agentLatencyRecorder: new ThrowingLatencyRecorder(),
    });
    expect(typeof out.reply).toBe("string");
  });
});
