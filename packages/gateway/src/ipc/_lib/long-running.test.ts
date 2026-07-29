import { describe, expect, test } from "bun:test";
import { LongRunningJobRegistry } from "./long-running.ts";

type Emitted = { method: string; payload: Record<string, unknown> };

function makeRegistry(): {
  registry: LongRunningJobRegistry;
  emitted: Emitted[];
  emit: (method: string, payload: Record<string, unknown>) => void;
} {
  const emitted: Emitted[] = [];
  const emit = (method: string, payload: Record<string, unknown>): void => {
    emitted.push({ method, payload });
  };
  return { registry: new LongRunningJobRegistry(), emitted, emit };
}

describe("LongRunningJobRegistry", () => {
  test("start returns a jobId with the configured prefix", () => {
    const { registry, emit } = makeRegistry();
    const { jobId } = registry.start({
      jobIdPrefix: "demo",
      progressMethod: "demo.progress",
      doneMethod: "demo.done",
      errorMethod: "demo.error",
      emit,
      run: async () => undefined,
    });
    expect(jobId).toMatch(/^demo_/);
  });

  test("emits progress events tagged with jobId for each progress callback call", async () => {
    const { registry, emitted, emit } = makeRegistry();
    const { jobId } = registry.start({
      jobIdPrefix: "demo",
      progressMethod: "demo.progress",
      doneMethod: "demo.done",
      errorMethod: "demo.error",
      emit,
      run: async (progress) => {
        progress({ done: 1, total: 3 });
        progress({ done: 2, total: 3 });
        progress({ done: 3, total: 3 });
        return undefined;
      },
    });
    await registry.awaitJob(jobId);
    const progress = emitted.filter((e) => e.method === "demo.progress");
    expect(progress).toHaveLength(3);
    expect(progress[0]?.payload["jobId"]).toBe(jobId);
    expect(progress[0]?.payload["done"]).toBe(1);
    expect(progress[2]?.payload["done"]).toBe(3);
  });

  test("emits doneMethod with jobId + durationMs + spread of run's resolved value", async () => {
    const { registry, emitted, emit } = makeRegistry();
    const { jobId } = registry.start({
      jobIdPrefix: "demo",
      progressMethod: "demo.progress",
      doneMethod: "demo.done",
      errorMethod: "demo.error",
      emit,
      run: async () => ({ succeeded: 5, skipped: 1 }),
    });
    await registry.awaitJob(jobId);
    const done = emitted.find((e) => e.method === "demo.done");
    expect(done?.payload["jobId"]).toBe(jobId);
    expect(done?.payload["succeeded"]).toBe(5);
    expect(done?.payload["skipped"]).toBe(1);
    expect(typeof done?.payload["durationMs"]).toBe("number");
  });

  test("emits errorMethod with jobId + code + message when run throws", async () => {
    const { registry, emitted, emit } = makeRegistry();
    class CustomError extends Error {
      readonly rpcCode = -32099;
    }
    const { jobId } = registry.start({
      jobIdPrefix: "demo",
      progressMethod: "demo.progress",
      doneMethod: "demo.done",
      errorMethod: "demo.error",
      emit,
      run: async () => {
        throw new CustomError("the thing exploded");
      },
    });
    await registry.awaitJob(jobId);
    const err = emitted.find((e) => e.method === "demo.error");
    expect(err?.payload["jobId"]).toBe(jobId);
    expect(err?.payload["code"]).toBe(-32099);
    expect(err?.payload["message"]).toBe("the thing exploded");
    expect(emitted.some((e) => e.method === "demo.done")).toBe(false);
  });

  test("falls back to -32603 when thrown error has no rpcCode", async () => {
    const { registry, emitted, emit } = makeRegistry();
    const { jobId } = registry.start({
      jobIdPrefix: "demo",
      progressMethod: "demo.progress",
      doneMethod: "demo.done",
      errorMethod: "demo.error",
      emit,
      run: async () => {
        throw new Error("oops");
      },
    });
    await registry.awaitJob(jobId);
    const err = emitted.find((e) => e.method === "demo.error");
    expect(err?.payload["code"]).toBe(-32603);
  });

  test("cancel aborts the run's signal and returns true", async () => {
    const { registry, emit } = makeRegistry();
    let observedAbort = false;
    const { jobId } = registry.start({
      jobIdPrefix: "demo",
      progressMethod: "demo.progress",
      doneMethod: "demo.done",
      errorMethod: "demo.error",
      emit,
      run: async (_progress, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
            resolve();
          });
        });
      },
    });
    expect(registry.cancel(jobId)).toBe(true);
    await registry.awaitJob(jobId);
    expect(observedAbort).toBe(true);
  });

  test("cancel for an unknown jobId returns false", () => {
    const { registry } = makeRegistry();
    expect(registry.cancel("nonexistent_123_abc")).toBe(false);
  });

  test("awaitJob for an unknown or already-completed jobId resolves immediately", async () => {
    const { registry, emit } = makeRegistry();
    const { jobId } = registry.start({
      jobIdPrefix: "demo",
      progressMethod: "demo.progress",
      doneMethod: "demo.done",
      errorMethod: "demo.error",
      emit,
      run: async () => undefined,
    });
    await expect(registry.awaitJob(jobId)).resolves.toBeUndefined();
    // Already-settled job: awaiting a second time must still resolve, not hang.
    await expect(registry.awaitJob(jobId)).resolves.toBeUndefined();
    await expect(registry.awaitJob("never-existed")).resolves.toBeUndefined();
  });
});
