import { describe, expect, test } from "bun:test";

import { ExpiringRunRegistry } from "./expiring-run-registry.ts";

type TestRun = {
  readonly id: string;
  status: "running" | "done" | "failed";
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
};

/**
 * A registry over an injected clock, recording every `onExpire` call together with whether the run
 * was still in the map at that moment — the hook's contract is that it runs BEFORE the run leaves.
 */
function harness(
  over: { maxTombstones?: number; maxRetainedTerminal?: number; hook?: boolean } = {},
) {
  let now = 1_000;
  const expired: Array<{ id: string; stillHeld: boolean }> = [];
  const registry: ExpiringRunRegistry<TestRun> = new ExpiringRunRegistry<TestRun>({
    nowMs: () => now,
    maxTombstones: over.maxTombstones ?? 8,
    maxRetainedTerminal: over.maxRetainedTerminal ?? 2,
    ...(over.hook === false
      ? {}
      : {
          onExpire: (run: TestRun) => {
            expired.push({ id: run.id, stillHeld: registry.peek(run.id) === run });
          },
        }),
  });
  const add = (
    id: string,
    ttlMs: number,
    status: TestRun["status"] = "running",
    createdAtMs: number = now,
  ): TestRun => {
    const run: TestRun = { id, status, createdAtMs, expiresAtMs: createdAtMs + ttlMs };
    registry.add(run);
    return run;
  };
  return {
    registry,
    add,
    expired,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ExpiringRunRegistry — lookup and lazy expiry", () => {
  test("get returns a held run; an id never held is null and not known", () => {
    const { registry, add } = harness();
    const run = add("a", 5_000);
    expect(registry.get("a")).toBe(run);
    expect(registry.get("nope")).toBeNull();
    expect(registry.wasKnown("nope")).toBe(false);
  });

  test("a run sitting exactly on its expiry is still live; one ms later get() drops it", () => {
    const { registry, add, advance, expired } = harness();
    add("a", 5_000);
    advance(5_000);
    // Both TTL paths compare strictly, so the boundary survives the sweep as well as the lookup.
    registry.sweep();
    expect(registry.get("a")).not.toBeNull();
    expect(expired).toEqual([]);
    advance(1);
    expect(registry.get("a")).toBeNull();
    expect(registry.wasKnown("a")).toBe(true);
    // The hook ran once, while the run was still in the map, and the run is gone afterwards.
    expect(expired).toEqual([{ id: "a", stillHeld: true }]);
    expect(registry.peek("a")).toBeUndefined();
  });

  test("peek returns an expired-but-unswept run without dropping it", () => {
    const { registry, add, advance, expired } = harness();
    const run = add("a", 5_000);
    advance(5_001);
    expect(registry.peek("a")).toBe(run);
    expect(registry.wasKnown("a")).toBe(false);
    expect(expired).toEqual([]);
  });

  test("the TTL is not refreshed by a get()", () => {
    const { registry, add, advance } = harness();
    add("a", 5_000);
    advance(4_000);
    expect(registry.get("a")).not.toBeNull();
    advance(1_001);
    expect(registry.get("a")).toBeNull();
  });

  test("sweep drops every expired run with nobody polling, in insertion order", () => {
    const { registry, add, advance, expired } = harness();
    add("a", 1_000);
    add("b", 9_000);
    add("c", 1_000);
    advance(1_001);
    registry.sweep();
    expect(expired).toEqual([
      { id: "a", stillHeld: true },
      { id: "c", stillHeld: true },
    ]);
    expect(registry.peek("b")).toBeDefined();
    expect(registry.wasKnown("a")).toBe(true);
    expect(registry.wasKnown("b")).toBe(false);
    expect(registry.wasKnown("c")).toBe(true);
  });

  test("with no onExpire hook, expiry still drops and tombstones the run", () => {
    const { registry, add, advance } = harness({ hook: false });
    add("a", 1_000);
    add("b", 1_000);
    advance(1_001);
    registry.sweep();
    expect(registry.get("b")).toBeNull();
    expect(registry.peek("a")).toBeUndefined();
    expect(registry.wasKnown("a")).toBe(true);
    expect(registry.wasKnown("b")).toBe(true);
  });
});

describe("ExpiringRunRegistry — concurrency count", () => {
  test("activeCount counts only non-terminal runs", () => {
    const { registry, add } = harness();
    add("live-1", 5_000);
    add("live-2", 5_000);
    add("done", 5_000, "done");
    add("failed", 5_000, "failed");
    expect(registry.activeCount()).toBe(2);
  });

  test("activeCount sweeps first, so an expired run frees its slot without being polled", () => {
    const { registry, add, advance, expired } = harness();
    add("old", 1_000);
    add("new", 9_000);
    advance(1_001);
    expect(registry.activeCount()).toBe(1);
    expect(expired.map((e) => e.id)).toEqual(["old"]);
  });
});

describe("ExpiringRunRegistry — terminal retention", () => {
  test("keeps the newest terminal runs by createdAtMs, not by insertion order", () => {
    const { registry, add } = harness({ maxRetainedTerminal: 2 });
    add("t-2000", 60_000, "done", 2_000);
    add("t-1000", 60_000, "failed", 1_000);
    add("t-3000", 60_000, "done", 3_000);
    add("live", 60_000, "running", 500);
    registry.trimTerminal();
    expect(registry.peek("t-1000")).toBeUndefined();
    expect(registry.wasKnown("t-1000")).toBe(true);
    expect(registry.peek("t-2000")).toBeDefined();
    expect(registry.peek("t-3000")).toBeDefined();
    // A non-terminal run is never trimmed, however old.
    expect(registry.peek("live")).toBeDefined();
  });

  test("the trim tombstones what it evicts but never calls onExpire", () => {
    const { registry, add, expired } = harness({ maxRetainedTerminal: 1 });
    add("t1", 60_000, "done", 1_000);
    add("t2", 60_000, "done", 2_000);
    add("t3", 60_000, "done", 3_000);
    registry.trimTerminal();
    expect(registry.wasKnown("t1")).toBe(true);
    expect(registry.wasKnown("t2")).toBe(true);
    expect(registry.peek("t3")).toBeDefined();
    expect(expired).toEqual([]);
  });

  test("a trim within the cap evicts nothing", () => {
    const { registry, add } = harness({ maxRetainedTerminal: 2 });
    add("t1", 60_000, "done");
    add("t2", 60_000, "failed");
    registry.trimTerminal();
    expect(registry.peek("t1")).toBeDefined();
    expect(registry.peek("t2")).toBeDefined();
    expect(registry.wasKnown("t1")).toBe(false);
  });
});

describe("ExpiringRunRegistry — tombstones", () => {
  test("the tombstone set is capped, evicting the OLDEST id first (410 degrades to 404)", () => {
    const { registry, add, advance } = harness({ maxTombstones: 2 });
    for (const id of ["a", "b", "c"]) {
      add(id, 1_000);
      advance(1_001);
      expect(registry.get(id)).toBeNull();
    }
    expect(registry.wasKnown("a")).toBe(false);
    expect(registry.wasKnown("b")).toBe(true);
    expect(registry.wasKnown("c")).toBe(true);
  });

  test("a negative cap keeps no tombstones and still terminates (every id reads as 404)", () => {
    // The eviction loop runs while size > cap, and an EMPTY set is still above -1: only the
    // guard on an exhausted set stops it, rather than spinning on `delete(undefined)` forever.
    const { registry, add, advance } = harness({ maxTombstones: -1 });
    add("a", 1_000);
    advance(1_001);
    expect(registry.get("a")).toBeNull();
    expect(registry.wasKnown("a")).toBe(false);
  });
});

describe("ExpiringRunRegistry — secondsUntilSoonestExpiry", () => {
  test("null when nothing is held", () => {
    const { registry } = harness();
    expect(registry.secondsUntilSoonestExpiry()).toBeNull();
  });

  test("null when every held run is terminal — no Infinity standing in for 'unknown'", () => {
    const { registry, add } = harness();
    add("done", 5_000, "done");
    add("failed", 5_000, "failed");
    expect(registry.secondsUntilSoonestExpiry()).toBeNull();
  });

  test("the soonest NON-terminal expiry, rounded up to whole seconds", () => {
    const { registry, add } = harness();
    add("terminal-sooner", 500, "done");
    add("later", 9_000);
    // 2.001 s, below the half: only rounding UP gives 3 (round-to-nearest and floor both give 2).
    add("sooner", 2_001);
    expect(registry.secondsUntilSoonestExpiry()).toBe(3);
  });

  test("never negative, and does not sweep: an unswept past-expiry run reads 0 and stays held", () => {
    const { registry, add, advance, expired } = harness();
    const run = add("a", 1_000);
    advance(5_000);
    expect(registry.secondsUntilSoonestExpiry()).toBe(0);
    expect(registry.peek("a")).toBe(run);
    expect(expired).toEqual([]);
  });
});
