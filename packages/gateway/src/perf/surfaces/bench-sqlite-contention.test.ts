import { describe, expect, test } from "bun:test";

import { runSqliteContentionOnce, S10_BUSY_RETRIES } from "./bench-sqlite-contention.ts";

describe("runSqliteContentionOnce", () => {
  test("returns one items/sec sample per run and records busyRetries on the module symbol", async () => {
    let nWorkersSeen = 0;
    const fakeWorker = class FakeWorker {
      onmessage: ((e: MessageEvent<unknown>) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      constructor(_url: URL) {
        nWorkersSeen += 1;
        queueMicrotask(() => {
          this.onmessage?.({ data: { kind: "ready" } } as MessageEvent<unknown>);
        });
      }
      postMessage(msg: unknown): void {
        const m = msg as { kind: string };
        if (m.kind === "start") {
          setTimeout(() => {
            this.onmessage?.({
              data: { kind: "done", writes: 1000, busyRetries: 7 },
            } as MessageEvent<unknown>);
          }, 5);
        }
      }
      terminate(): void {
        /* test stub: never inspects state, so no-op */
      }
    };

    S10_BUSY_RETRIES.value = 0;
    const samples = await runSqliteContentionOnce(
      { runs: 1, runner: "local-dev" },
      {
        WorkerCtor: fakeWorker as unknown as typeof Worker,
        durationMs: 50,
      },
    );
    expect(samples).toHaveLength(1);
    expect(samples[0]).toBeGreaterThan(0);
    expect(nWorkersSeen).toBe(3);
    expect(S10_BUSY_RETRIES.value).toBe(21);
  });

  test("accumulates retries across multiple driver invocations (D-5)", async () => {
    const fakeWorker = class FakeWorker {
      onmessage: ((e: MessageEvent<unknown>) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      constructor(_url: URL) {
        queueMicrotask(() => {
          this.onmessage?.({ data: { kind: "ready" } } as MessageEvent<unknown>);
        });
      }
      postMessage(msg: unknown): void {
        const m = msg as { kind: string };
        if (m.kind === "start") {
          setTimeout(() => {
            this.onmessage?.({
              data: { kind: "done", writes: 100, busyRetries: 5 },
            } as MessageEvent<unknown>);
          }, 5);
        }
      }
      terminate(): void {
        /* test stub: never inspects state, so no-op */
      }
    };
    S10_BUSY_RETRIES.value = 0;
    for (let i = 0; i < 3; i += 1) {
      await runSqliteContentionOnce(
        { runs: 1, runner: "local-dev" },
        { WorkerCtor: fakeWorker as unknown as typeof Worker, durationMs: 50 },
      );
    }
    expect(S10_BUSY_RETRIES.value).toBe(45);
  });
});
