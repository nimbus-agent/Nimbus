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
