import { describe, expect, test } from "bun:test";
import { GpuArbiter } from "./gpu-arbiter.ts";

describe("GpuArbiter", () => {
  test("is not locked initially", () => {
    const arb = new GpuArbiter();
    expect(arb.isLocked).toBe(false);
    expect(arb.currentProvider).toBeNull();
  });

  test("acquires and releases the lock", async () => {
    const arb = new GpuArbiter();
    const release = await arb.acquire("ollama");
    expect(arb.isLocked).toBe(true);
    expect(arb.currentProvider).toBe("ollama");
    release();
    expect(arb.isLocked).toBe(false);
    expect(arb.currentProvider).toBeNull();
  });

  test("second acquire waits for release", async () => {
    const arb = new GpuArbiter();
    const events: string[] = [];

    const release1 = await arb.acquire("ollama");
    events.push("p1-acquired");

    const p2 = arb.acquire("llamacpp").then((release2) => {
      events.push("p2-acquired");
      release2();
    });

    release1();
    events.push("p1-released");

    await p2;
    expect(events).toEqual(["p1-acquired", "p1-released", "p2-acquired"]);
  });

  test("double-release is a no-op", async () => {
    const arb = new GpuArbiter();
    const release = await arb.acquire("ollama");
    release();
    expect(() => release()).not.toThrow();
    expect(arb.isLocked).toBe(false);
  });

  test("touch() updates lastActivityAt", async () => {
    const arb = new GpuArbiter(50);
    const release = await arb.acquire("ollama");
    await new Promise((r) => setTimeout(r, 30));
    arb.touch();
    await new Promise((r) => setTimeout(r, 30));
    let secondAcquired = false;
    const p2 = arb.acquire("llamacpp").then((r) => {
      secondAcquired = true;
      r();
    });
    release();
    await p2;
    expect(secondAcquired).toBe(true);
  });

  test("force-releases after timeout on stale lock", async () => {
    const arb = new GpuArbiter(20);
    const release = await arb.acquire("ollama");
    await new Promise((r) => setTimeout(r, 30));
    const release2 = await arb.acquire("llamacpp");
    expect(arb.currentProvider).toBe("llamacpp");
    release2();
    expect(() => release()).not.toThrow();
  });

  test("SIGKILL fallback: onForceRelease fires with stale provider id when timeout elapses", async () => {
    const killed: string[] = [];
    const arb = new GpuArbiter(20, (id) => killed.push(id));

    await arb.acquire("llamacpp");
    await new Promise((r) => setTimeout(r, 30));

    const release2 = await arb.acquire("ollama");
    expect(killed).toEqual(["llamacpp"]);
    expect(arb.currentProvider).toBe("ollama");
    release2();
  });

  test("Ollama keep_alive=0 eviction: onForceRelease fires for ollama provider id", async () => {
    const evicted: string[] = [];
    const arb = new GpuArbiter(20, (id) => evicted.push(id));

    await arb.acquire("ollama");
    await new Promise((r) => setTimeout(r, 30));

    const release2 = await arb.acquire("llamacpp");
    expect(evicted).toEqual(["ollama"]);
    expect(arb.currentProvider).toBe("llamacpp");
    release2();
  });
});
