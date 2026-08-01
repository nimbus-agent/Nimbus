import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runWorkerBench } from "./worker-bench.ts";

interface FakeWorkerOpts {
  postedReady?: boolean;
  postWritesAfterMs?: number;
  writes?: number;
  busyRetries?: number;
  errorBeforeReady?: { message: string; stack?: string };
  hangPastStop?: boolean;
  /** Emit a message whose `kind` the coordinator does not know, just before `done`. */
  noiseKind?: string;
  /** Observe terminate(), told whether the worker had already reported `done`. */
  onTerminate?: (donePosted: boolean) => void;
}

function makeFakeWorker(opts: FakeWorkerOpts): typeof Worker {
  return class FakeWorker {
    onmessage: ((e: MessageEvent<unknown>) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    donePosted = false;
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
          if (opts.noiseKind !== undefined) {
            this.onmessage?.({ data: { kind: opts.noiseKind } } as MessageEvent<unknown>);
          }
          this.donePosted = true;
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
      opts.onTerminate?.(this.donePosted);
    }
  } as unknown as typeof Worker;
}

const realWorkerDir = mkdtempSync(join(tmpdir(), "worker-bench-real-"));
afterAll(() => {
  rmSync(realWorkerDir, { recursive: true, force: true });
});

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
    expect(result.perWorker).toHaveLength(3);
    expect(result.perWorker.every((w) => w.writes === 500)).toBe(true);
    expect(result.totalBusyRetries).toBe(9);
    expect(result.totalThroughputPerSec).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
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
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe("bind failed");
    expect(result.errors[0]?.stack).toBe("at line 42");
    expect(result.perWorker).toHaveLength(0);
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
    expect(result.perWorker).toHaveLength(1);
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
    expect(result.errors).toHaveLength(1);
    expect(result.perWorker).toHaveLength(1);
    expect(result.totalBusyRetries).toBe(1);
    expect(result.totalThroughputPerSec).toBeGreaterThan(0);
  });

  test("a message of an unknown kind is ignored, not mistaken for an error", async () => {
    // Forward-compat: a newer worker build may emit extra frames (e.g. progress).
    // They must not fall through into the error arm and zero out the run.
    const result = await runWorkerBench({
      workers: [{ name: "sync", url: new URL("file:///fake.ts"), config: {} }],
      durationMs: 100,
      sharedDbPath: "/fake/db",
      WorkerCtor: makeFakeWorker({ noiseKind: "progress", writes: 250, busyRetries: 4 }),
    });
    expect(result.errors).toHaveLength(0);
    expect(result.perWorker).toHaveLength(1);
    expect(result.perWorker[0]?.writes).toBe(250);
    expect(result.totalBusyRetries).toBe(4);
  });

  test("a zero-length run reports 0 throughput rather than Infinity", async () => {
    const result = await runWorkerBench({
      workers: [{ name: "sync", url: new URL("file:///fake.ts"), config: {} }],
      durationMs: 0,
      sharedDbPath: "/fake/db",
      WorkerCtor: makeFakeWorker({ writes: 42 }),
    });
    expect(result.perWorker[0]?.writes).toBe(42);
    expect(result.perWorker[0]?.throughputPerSec).toBe(0);
    expect(Number.isFinite(result.totalThroughputPerSec)).toBe(true);
    expect(result.totalThroughputPerSec).toBe(0);
  });

  test("on timeout the Workers are terminated while still running, without a drain wait", async () => {
    // The deadline wins the race well before the worker reports `done`, so the
    // coordinator must terminate immediately instead of draining donePromise.
    const terminatedWithDoneAlreadyPosted: boolean[] = [];
    const result = await runWorkerBench({
      workers: [{ name: "sync", url: new URL("file:///fake.ts"), config: {} }],
      durationMs: 50,
      sharedDbPath: "/fake/db",
      timeoutMs: 5,
      WorkerCtor: makeFakeWorker({
        writes: 10,
        postWritesAfterMs: 150,
        onTerminate: (donePosted) => terminatedWithDoneAlreadyPosted.push(donePosted),
      }),
    });
    expect(terminatedWithDoneAlreadyPosted).toEqual([false]);
    expect(result.perWorker).toHaveLength(1);
  });

  test("with no WorkerCtor override it drives real Workers over the message protocol", async () => {
    // Exercises the production default (the global `Worker`) against a real
    // thread speaking the init/ready/start/done contract.
    const script = [
      "self.onmessage = (e) => {",
      "  const msg = e.data;",
      '  if (msg.kind === "init") { self.postMessage({ kind: "ready" }); }',
      '  else if (msg.kind === "start") {',
      '    self.postMessage({ kind: "done", writes: 7, busyRetries: 2 });',
      "  }",
      "};",
    ].join("\n");
    writeFileSync(join(realWorkerDir, "w.js"), script, "utf8");
    const result = await runWorkerBench({
      workers: [
        { name: "sync", url: pathToFileURL(join(realWorkerDir, "w.js")), config: { a: 1 } },
      ],
      durationMs: 100,
      sharedDbPath: join(realWorkerDir, "db.sqlite"),
      timeoutMs: 10_000,
    });
    expect(result.errors).toEqual([]);
    expect(result.perWorker).toHaveLength(1);
    expect(result.perWorker[0]?.writes).toBe(7);
    expect(result.totalBusyRetries).toBe(2);
    expect(result.totalThroughputPerSec).toBeCloseTo(70, 5);
  });
});
