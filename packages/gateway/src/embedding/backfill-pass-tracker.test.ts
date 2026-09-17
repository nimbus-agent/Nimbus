import { describe, expect, test } from "bun:test";

import { createBackfillPassTracker } from "./backfill-pass-tracker.ts";

describe("createBackfillPassTracker", () => {
  test("a pass is active only from its first progress report", async () => {
    const t = createBackfillPassTracker();
    expect(t.active()).toBeNull();
    expect(t.last()).toBeNull();
    const seen: Array<{ done: number; total: number } | null> = [];
    await t.run(async (onProgress) => {
      // Before any report: running, but nothing to disclose yet — same as the worker bridge, which
      // is only "running" once a `backfill_progress` message has arrived.
      expect(t.active()).toBeNull();
      onProgress(1, 10);
      seen.push(t.active());
      onProgress(4, 10);
    });
    expect(seen[0]).toEqual({ done: 1, total: 10 });
    expect(t.active()).toBeNull();
    expect(t.last()).toEqual({ done: 4, total: 10 });
  });

  test("a pass with nothing to embed never becomes active and leaves no figure", async () => {
    const t = createBackfillPassTracker();
    await t.run(async () => {
      /* no rows, so no progress */
    });
    expect(t.active()).toBeNull();
    expect(t.last()).toBeNull();
  });

  test("a throwing pass stops being active, and the last figure survives", async () => {
    const t = createBackfillPassTracker();
    await expect(
      t.run(async (onProgress) => {
        onProgress(2, 9);
        throw new Error("backfill blew up");
      }),
    ).rejects.toThrow("backfill blew up");
    expect(t.active()).toBeNull();
    expect(t.last()).toEqual({ done: 2, total: 9 });
  });

  test("a pass stopped early by its gate is no longer active", async () => {
    // `backfillAll` RETURNS when the gate closes (battery, shutdown); it does not throw. A pass that
    // ended that way must not keep claiming to be running.
    const t = createBackfillPassTracker();
    await t.run(async (onProgress) => {
      onProgress(3, 100);
    });
    expect(t.active()).toBeNull();
    expect(t.last()).toEqual({ done: 3, total: 100 });
  });
});
