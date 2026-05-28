import { describe, expect, test } from "bun:test";

import { runWorkerBench } from "./worker-bench.ts";

interface FakeWorkerOpts {
  postedReady?: boolean;
  postWritesAfterMs?: number;
  writes?: number;
  busyRetries?: number;
  errorBeforeReady?: { message: string; stack?: string };
  hangPastStop?: boolean;
}

function makeFakeWorker(opts: FakeWorkerOpts): typeof Worker {
  return class FakeWorker {
    onmessage: ((e: MessageEvent<unknown>) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    constructor(_url: URL) {
      queueMicrotask(() => {
        if (opts.errorBeforeReady !== undefined) {
          this.onmessage?.({
            data: { kind: "error", ...opts.errorBeforeReady },
          } as MessageEvent<unknown>);
          return;
        }
        if (opts.postedReady !== false) {
          this.onmessage?.({ data: { kind: "ready" } } as MessageEvent<unknown>);
        }
      });
    }
    postMessage(msg: unknown): void {
      const m = msg as { kind: string };
      if (m.kind === "start") {
        const after = opts.postWritesAfterMs ?? 5;
        setTimeout(() => {
          this.onmessage?.({
            data: {
              kind: "done",
              writes: opts.writes ?? 100,
              busyRetries: opts.busyRetries ?? 0,
            },
          } as MessageEvent<unknown>);
        }, after);
      }
      if (m.kind === "stop" && opts.hangPastStop === true) {
        // never resolve — coordinator must terminate()
      }
    }
    terminate(): void {
      /* test stub: never inspects state, so no-op */
    }
  } as unknown as typeof Worker;
}

describe("runWorkerBench", () => {
  test("aggregates throughput across Workers (happy path)", async () => {
    const result = await runWorkerBench({
      workers: [
        { name: "sync", url: new URL("file:///fake-sync.ts"), config: {} },
        { name: "watcher", url: new URL("file:///fake-watcher.ts"), config: {} },
        { name: "audit", url: new URL("file:///fake-audit.ts"), config: {} },
      ],
      durationMs: 100,
      sharedDbPath: "/fake/db",
      WorkerCtor: makeFakeWorker({ writes: 500, busyRetries: 3 }),
    });
    expect(result.perWorker.length).toBe(3);
    expect(result.perWorker.every((w) => w.writes === 500)).toBe(true);
    expect(result.totalBusyRetries).toBe(9);
    expect(result.totalThroughputPerSec).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);
  });

  test("captures error message and stack when a Worker errors before ready", async () => {
    const result = await runWorkerBench({
      workers: [{ name: "sync", url: new URL("file:///fake.ts"), config: {} }],
      durationMs: 100,
      sharedDbPath: "/fake/db",
      WorkerCtor: makeFakeWorker({
        errorBeforeReady: { message: "bind failed", stack: "at line 42" },
      }),
    });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.message).toBe("bind failed");
    expect(result.errors[0]?.stack).toBe("at line 42");
    expect(result.perWorker.length).toBe(0);
    expect(result.totalThroughputPerSec).toBe(0);
  });

  test("terminates Workers that hang past durationMs + 2s", async () => {
    const start = performance.now();
    const result = await runWorkerBench({
      workers: [{ name: "sync", url: new URL("file:///fake.ts"), config: {} }],
      durationMs: 50,
      sharedDbPath: "/fake/db",
      timeoutMs: 200,
      WorkerCtor: makeFakeWorker({
        writes: 10,
        hangPastStop: true,
        postWritesAfterMs: 10,
      }),
    });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(result.perWorker.length).toBe(1);
  });

  test("partial failure — surviving Workers contribute to totalThroughput", async () => {
    let n = 0;
    const result = await runWorkerBench({
      workers: [
        { name: "sync", url: new URL("file:///a.ts"), config: {} },
        { name: "watcher", url: new URL("file:///b.ts"), config: {} },
      ],
      durationMs: 100,
      sharedDbPath: "/fake/db",
      WorkerCtor: function (this: unknown, _url: URL) {
        n += 1;
        const ctor =
          n === 1
            ? makeFakeWorker({ errorBeforeReady: { message: "boom" } })
            : makeFakeWorker({ writes: 100, busyRetries: 1 });
        return new (ctor as unknown as new (u: URL) => Worker)(_url);
      } as unknown as typeof Worker,
    });
    expect(result.errors.length).toBe(1);
    expect(result.perWorker.length).toBe(1);
    expect(result.totalBusyRetries).toBe(1);
    expect(result.totalThroughputPerSec).toBeGreaterThan(0);
  });
});
