import { describe, expect, test } from "bun:test";
import { ASK_EXPLAIN_RING_SIZE, AskExplainRecorder } from "./ask-explain-recorder.ts";
import type { AskExplainRecord } from "./ask-explain-types.ts";

function rec(question: string): AskExplainRecord {
  return {
    askedAt: 1_700_000_000_000,
    durationMs: 10,
    question,
    source: "local",
    persona: "standard",
    modelRoute: { provider: "ollama", model: "llama3.2", isLocal: true },
    classifier: { called: false, reason: "local preference" },
    route: "empty_index",
  };
}

describe("AskExplainRecorder", () => {
  test("last() is undefined before anything is recorded — the caller must be able to say so", () => {
    expect(new AskExplainRecorder().last()).toBeUndefined();
  });

  test("last() returns the most recent record", () => {
    const r = new AskExplainRecorder();
    r.record(rec("first"));
    r.record(rec("second"));
    expect(r.last()?.question).toBe("second");
  });

  test("the ring is bounded and evicts oldest-first", () => {
    const r = new AskExplainRecorder();
    for (let i = 0; i < ASK_EXPLAIN_RING_SIZE + 3; i++) r.record(rec(`q${String(i)}`));
    expect(r.size()).toBe(ASK_EXPLAIN_RING_SIZE);
    expect(r.last()?.question).toBe(`q${String(ASK_EXPLAIN_RING_SIZE + 2)}`);
    // The first three are gone, not merely unreachable.
    expect(r.all().some((x) => x.question === "q0")).toBe(false);
  });
});
