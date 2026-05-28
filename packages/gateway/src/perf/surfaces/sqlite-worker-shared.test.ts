import { describe, expect, test } from "bun:test";

import { runWorkerLoop, type WorkerLoopDeps } from "./sqlite-worker-shared.ts";

describe("runWorkerLoop", () => {
  test("performs writes for the requested duration and returns done counters", async () => {
    let writes = 0;
    const deps: WorkerLoopDeps = {
      doOneWrite: () => {
        writes += 1;
      },
      now: () => performance.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    const result = await runWorkerLoop({ durationMs: 50, deps });
    expect(result.writes).toBeGreaterThan(0);
    expect(result.busyRetries).toBe(0);
    expect(writes).toBe(result.writes);
  });

  test("counts SQLITE_BUSY retries without inflating the writes count", async () => {
    let attempt = 0;
    const deps: WorkerLoopDeps = {
      doOneWrite: () => {
        attempt += 1;
        if (attempt % 3 === 0) {
          const err = new Error("database is locked") as Error & { code: number };
          err.code = 5;
          throw err;
        }
      },
      now: () => performance.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    const result = await runWorkerLoop({ durationMs: 50, deps });
    expect(result.busyRetries).toBeGreaterThan(0);
    expect(result.writes).toBeGreaterThan(0);
    expect(result.writes + result.busyRetries).toBe(attempt);
  });

  test("aborts on a non-BUSY error and surfaces the message + stack", async () => {
    const err = new Error("disk full");
    err.stack = "Error: disk full\n    at fakeWrite";
    const deps: WorkerLoopDeps = {
      doOneWrite: () => {
        throw err;
      },
      now: () => performance.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    await expect(runWorkerLoop({ durationMs: 50, deps })).rejects.toMatchObject({
      message: "disk full",
    });
  });

  test("respects an early stop signal", async () => {
    const ac = new AbortController();
    let writes = 0;
    const deps: WorkerLoopDeps = {
      doOneWrite: () => {
        writes += 1;
        if (writes === 5) ac.abort();
      },
      now: () => performance.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    const result = await runWorkerLoop({ durationMs: 60_000, signal: ac.signal, deps });
    expect(result.writes).toBe(5);
  });
});
