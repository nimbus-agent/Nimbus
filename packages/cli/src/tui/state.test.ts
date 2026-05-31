import { describe, expect, test } from "bun:test";

import { initialTuiState, type TuiAction, type TuiState, tuiReducer } from "./state.ts";

function reduce(actions: TuiAction[], from: TuiState = initialTuiState): TuiState {
  return actions.reduce((s, a) => tuiReducer(s, a), from);
}

describe("tuiReducer", () => {
  test("initial state is idle", () => {
    expect(initialTuiState.mode).toBe("idle");
    expect(initialTuiState.activeStreamId).toBeNull();
    expect(initialTuiState.liveBuffer).toBe("");
    expect(initialTuiState.hitlBatch).toBeNull();
  });

  test("submit transitions idle -> streaming", () => {
    const s = reduce([{ type: "submit", streamId: "s1", query: "hello" }]);
    expect(s.mode).toBe("streaming");
    expect(s.activeStreamId).toBe("s1");
    expect(s.liveBuffer).toBe("");
  });

  test("streamToken appends to live buffer while streaming", () => {
    const s = reduce([
      { type: "submit", streamId: "s1", query: "q" },
      { type: "stream-token", streamId: "s1", text: "foo " },
      { type: "stream-token", streamId: "s1", text: "bar" },
    ]);
    expect(s.liveBuffer).toBe("foo bar");
  });

  test("streamToken for non-active streamId is ignored", () => {
    const s = reduce([
      { type: "submit", streamId: "s1", query: "q" },
      { type: "stream-token", streamId: "stale", text: "ignored" },
    ]);
    expect(s.liveBuffer).toBe("");
  });

  test("streamDone returns to idle and clears active streamId", () => {
    const s = reduce([
      { type: "submit", streamId: "s1", query: "q" },
      { type: "stream-token", streamId: "s1", text: "hi" },
      { type: "stream-done", streamId: "s1" },
    ]);
    expect(s.mode).toBe("idle");
    expect(s.activeStreamId).toBeNull();
  });

  test("streamError returns to idle and records the error text", () => {
    const s = reduce([
      { type: "submit", streamId: "s1", query: "q" },
      { type: "stream-error", streamId: "s1", error: "boom" },
    ]);
    expect(s.mode).toBe("idle");
    expect(s.lastError).toBe("boom");
  });

  test("hitl-requested while streaming transitions to awaiting-hitl", () => {
    const s = reduce([
      { type: "submit", streamId: "s1", query: "q" },
      {
        type: "hitl-requested",
        batchId: "b1",
        requests: [{ actionId: "a1", action: "slack.postMessage", params: { channel: "#x" } }],
      },
    ]);
    expect(s.mode).toBe("awaiting-hitl");
    expect(s.hitlBatch?.batchId).toBe("b1");
    expect(s.hitlBatch?.requests).toHaveLength(1);
    expect(s.hitlBatch?.cursor).toBe(0);
    expect(s.hitlBatch?.decisions).toEqual([]);
  });

  test("hitl-advance collects a decision and advances the cursor", () => {
    const s = reduce([
      { type: "submit", streamId: "s1", query: "q" },
      {
        type: "hitl-requested",
        batchId: "b1",
        requests: [
          { actionId: "a1", action: "x", params: {} },
          { actionId: "a2", action: "y", params: {} },
        ],
      },
      { type: "hitl-advance", approved: true },
    ]);
    expect(s.mode).toBe("awaiting-hitl");
    expect(s.hitlBatch?.cursor).toBe(1);
    expect(s.hitlBatch?.decisions).toEqual([{ actionId: "a1", approved: true }]);
  });

  test("hitl-resolve clears the batch and returns to streaming", () => {
    const s = reduce([
      { type: "submit", streamId: "s1", query: "q" },
      {
        type: "hitl-requested",
        batchId: "b1",
        requests: [{ actionId: "a1", action: "x", params: {} }],
      },
      { type: "hitl-advance", approved: true },
      { type: "hitl-resolve" },
    ]);
    expect(s.mode).toBe("streaming");
    expect(s.hitlBatch).toBeNull();
  });

  test("disconnect from any state transitions to disconnected", () => {
    const fromStreaming = reduce([
      { type: "submit", streamId: "s1", query: "q" },
      { type: "disconnect" },
    ]);
    expect(fromStreaming.mode).toBe("disconnected");
    expect(fromStreaming.activeStreamId).toBeNull();
  });

  test("reconnect from disconnected returns to idle", () => {
    const s = reduce([{ type: "disconnect" }, { type: "reconnect" }]);
    expect(s.mode).toBe("idle");
  });

  test("cancel during streaming flips to idle without erasing live buffer", () => {
    const s = reduce([
      { type: "submit", streamId: "s1", query: "q" },
      { type: "stream-token", streamId: "s1", text: "partial " },
      { type: "cancel" },
    ]);
    expect(s.mode).toBe("idle");
    expect(s.activeStreamId).toBeNull();
    expect(s.liveBuffer).toContain("partial");
  });

  test("flush-live clears the live buffer (used after ResultStream moves to <Static>)", () => {
    const s = reduce([
      { type: "submit", streamId: "s1", query: "q" },
      { type: "stream-token", streamId: "s1", text: "hi" },
      { type: "stream-done", streamId: "s1" },
      { type: "flush-live" },
    ]);
    expect(s.liveBuffer).toBe("");
  });
});
