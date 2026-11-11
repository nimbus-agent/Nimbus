import { describe, expect, test } from "bun:test";

import { createWorkflowRunLock } from "./workflow-run-lock.ts";

describe("the per-workflow run lock", () => {
  test("is exclusive per workflow, free for another, and released explicitly", () => {
    const lock = createWorkflowRunLock();
    expect(lock.tryAcquire("a")).toBe(true);
    expect(lock.tryAcquire("a")).toBe(false);
    expect(lock.isHeld("a")).toBe(true);
    expect(lock.tryAcquire("b")).toBe(true);
    lock.release("a");
    expect(lock.isHeld("a")).toBe(false);
    expect(lock.tryAcquire("a")).toBe(true);
  });

  test("withLock runs the body, returns its value, and releases after a throw", async () => {
    const lock = createWorkflowRunLock();
    expect(await lock.withLock("a", async () => 7)).toEqual({ held: true, value: 7 });
    expect(lock.isHeld("a")).toBe(false);
    await expect(
      lock.withLock("a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(lock.isHeld("a")).toBe(false);
  });

  test("withLock does not run the body when the lock is held", async () => {
    const lock = createWorkflowRunLock();
    lock.tryAcquire("a");
    let ran = false;
    expect(
      await lock.withLock("a", async () => {
        ran = true;
        return 1;
      }),
    ).toBeUndefined();
    expect(ran).toBe(false);
    expect(lock.isHeld("a")).toBe(true);
  });
});
