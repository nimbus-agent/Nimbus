import { describe, expect, test } from "bun:test";

import { createListenerRegistry, processListeners, registerListener } from "./listener-registry.ts";

describe("createListenerRegistry", () => {
  test("live() drops null probes and unregistered listeners", () => {
    const r = createListenerRegistry();
    let open = true;
    const off = r.register(() =>
      open ? { name: "http", address: "127.0.0.1:1", loopback: true } : null,
    );
    r.register(() => null);
    expect(r.live()).toEqual([{ name: "http", address: "127.0.0.1:1", loopback: true }]);
    open = false;
    expect(r.live()).toEqual([]);
    open = true;
    off();
    expect(r.live()).toEqual([]);
  });

  test("a throwing probe is absent, not fatal", () => {
    const r = createListenerRegistry();
    r.register(() => {
      throw new Error("x");
    });
    expect(r.live()).toEqual([]);
  });

  test("live() sorts by name then address for stable output", () => {
    const r = createListenerRegistry();
    r.register(() => ({ name: "metrics", address: "127.0.0.1:2", loopback: true }));
    r.register(() => ({ name: "http", address: "127.0.0.1:9", loopback: true }));
    r.register(() => ({ name: "http", address: "127.0.0.1:1", loopback: true }));
    expect(r.live().map((l) => `${l.name}:${l.address}`)).toEqual([
      "http:127.0.0.1:1",
      "http:127.0.0.1:9",
      "metrics:127.0.0.1:2",
    ]);
  });

  // The comparator's tie-break arms: the test above only ever asks the comparator to place items
  // that are ALREADY out of order, which never exercises the "leave it where it is" (false) side
  // of either the name or the address comparison. Registering two reports already in ASCENDING
  // order forces that side too, and a full tie (same name AND address) forces the final `return
  // 0` — neither observable from the OUTPUT order alone (a comparator returning the wrong
  // constant on either side of a tie can still sort two elements correctly), so each asserts the
  // full report is still present, not dropped.
  test("live() keeps two already-ascending, same-name reports in their address order", () => {
    const r = createListenerRegistry();
    r.register(() => ({ name: "http", address: "127.0.0.1:1", loopback: true }));
    r.register(() => ({ name: "http", address: "127.0.0.1:9", loopback: true }));
    expect(r.live().map((l) => l.address)).toEqual(["127.0.0.1:1", "127.0.0.1:9"]);
  });

  test("live() keeps two already-ascending, differently-named reports in their name order", () => {
    const r = createListenerRegistry();
    r.register(() => ({ name: "http", address: "a", loopback: true }));
    r.register(() => ({ name: "metrics", address: "a", loopback: true }));
    expect(r.live().map((l) => l.name)).toEqual(["http", "metrics"]);
  });

  test("live() keeps BOTH reports when two probes report the identical name and address", () => {
    const r = createListenerRegistry();
    r.register(() => ({ name: "http", address: "127.0.0.1:1", loopback: true }));
    r.register(() => ({ name: "http", address: "127.0.0.1:1", loopback: true }));
    expect(r.live()).toEqual([
      { name: "http", address: "127.0.0.1:1", loopback: true },
      { name: "http", address: "127.0.0.1:1", loopback: true },
    ]);
  });
});

describe("processListeners / registerListener", () => {
  test("registerListener registers on the process-global singleton", () => {
    // Filter by a distinctive address, since processListeners is process-global and other tests
    // (or, in a real process, real listen sites) may register concurrently.
    const address = "127.0.0.1:59999-listener-registry-test";
    const off = registerListener(() => ({ name: "http", address, loopback: true }));
    try {
      expect(processListeners.live().some((l) => l.address === address)).toBe(true);
    } finally {
      off();
    }
    expect(processListeners.live().some((l) => l.address === address)).toBe(false);
  });
});
