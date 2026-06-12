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

  test("stream-done for non-active streamId is ignored (returns same state reference)", () => {
    const before = reduce([
      { type: "submit", streamId: "s1", query: "q" },
      { type: "stream-token", streamId: "s1", text: "hello" },
    ]);
    const after = tuiReducer(before, { type: "stream-done", streamId: "stale" });
    // same reference = no state change
    expect(after).toBe(before);
    expect(after.mode).toBe("streaming");
    expect(after.activeStreamId).toBe("s1");
    expect(after.liveBuffer).toBe("hello");
  });

  test("stream-error for non-active streamId is ignored (returns same state reference)", () => {
    const before = reduce([{ type: "submit", streamId: "s1", query: "q" }]);
    const after = tuiReducer(before, { type: "stream-error", streamId: "stale", error: "oops" });
    expect(after).toBe(before);
    expect(after.mode).toBe("streaming");
    expect(after.lastError).toBeNull();
  });

  test("hitl-advance when hitlBatch is null returns same state (no-op)", () => {
    // No hitl-requested, so hitlBatch is null
    const before = reduce([{ type: "submit", streamId: "s1", query: "q" }]);
    expect(before.hitlBatch).toBeNull();
    const after = tuiReducer(before, { type: "hitl-advance", approved: true });
    expect(after).toBe(before);
  });

  test("hitl-advance when cursor is past all requests (currentRequest undefined) returns same state", () => {
    // Advance past the only request, then try to advance again
    const afterFirstAdvance = reduce([
      { type: "submit", streamId: "s1", query: "q" },
      {
        type: "hitl-requested",
        batchId: "b1",
        requests: [{ actionId: "a1", action: "x", params: {} }],
      },
      { type: "hitl-advance", approved: true },
    ]);
    // cursor is now 1, but requests has length 1, so cursor >= requests.length
    expect(afterFirstAdvance.hitlBatch?.cursor).toBe(1);
    expect(afterFirstAdvance.hitlBatch?.requests).toHaveLength(1);

    const afterSecondAdvance = tuiReducer(afterFirstAdvance, {
      type: "hitl-advance",
      approved: false,
    });
    expect(afterSecondAdvance).toBe(afterFirstAdvance);
    // cursor and decisions unchanged
    expect(afterSecondAdvance.hitlBatch?.cursor).toBe(1);
    expect(afterSecondAdvance.hitlBatch?.decisions).toHaveLength(1);
  });

  test("hitl-resolve with no active stream returns to idle mode", () => {
    // Start from idle (no submit), go hitl-requested then resolve → mode should be idle
    const s = reduce([
      {
        type: "hitl-requested",
        batchId: "b2",
        requests: [{ actionId: "a1", action: "x", params: {} }],
      },
      { type: "hitl-resolve" },
    ]);
    expect(s.mode).toBe("idle");
    expect(s.hitlBatch).toBeNull();
    expect(s.activeStreamId).toBeNull();
  });

  test("submit clears a previous lastError", () => {
    const withError = reduce([
      { type: "submit", streamId: "s1", query: "q" },
      { type: "stream-error", streamId: "s1", error: "previous error" },
    ]);
    expect(withError.lastError).toBe("previous error");

    const s = tuiReducer(withError, { type: "submit", streamId: "s2", query: "retry" });
    expect(s.mode).toBe("streaming");
    expect(s.activeStreamId).toBe("s2");
    expect(s.lastError).toBeNull();
  });

  test("disconnect from awaiting-hitl clears hitlBatch", () => {
    const s = reduce([
      { type: "submit", streamId: "s1", query: "q" },
      {
        type: "hitl-requested",
        batchId: "b1",
        requests: [{ actionId: "a1", action: "x", params: {} }],
      },
      { type: "disconnect" },
    ]);
    expect(s.mode).toBe("disconnected");
    expect(s.hitlBatch).toBeNull();
    expect(s.activeStreamId).toBeNull();
  });

  test("hitl-advance with denied decision records approved:false", () => {
    const s = reduce([
      { type: "submit", streamId: "s1", query: "q" },
      {
        type: "hitl-requested",
        batchId: "b1",
        requests: [
          { actionId: "a1", action: "x", params: { key: "val" } },
          { actionId: "a2", action: "y", params: {} },
        ],
      },
      { type: "hitl-advance", approved: false },
    ]);
    expect(s.hitlBatch?.decisions).toEqual([{ actionId: "a1", approved: false }]);
    expect(s.hitlBatch?.cursor).toBe(1);
  });

  test("multiple hitl-advance steps build the full decision list", () => {
    const s = reduce([
      { type: "submit", streamId: "s1", query: "q" },
      {
        type: "hitl-requested",
        batchId: "b1",
        requests: [
          { actionId: "a1", action: "x", params: {} },
          { actionId: "a2", action: "y", params: {} },
          { actionId: "a3", action: "z", params: {} },
        ],
      },
      { type: "hitl-advance", approved: true },
      { type: "hitl-advance", approved: false },
      { type: "hitl-advance", approved: true },
    ]);
    expect(s.hitlBatch?.cursor).toBe(3);
    expect(s.hitlBatch?.decisions).toEqual([
      { actionId: "a1", approved: true },
      { actionId: "a2", approved: false },
      { actionId: "a3", approved: true },
    ]);
  });
});
