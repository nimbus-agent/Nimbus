/**
 * Unit tests for StubIpcClient to nudge the file above the 80% coverage floor.
 *
 * The TUI integration tests exercise most of StubIpcClient's call() and
 * onNotification() / emit() surface, but a few paths remain uncovered:
 *   - connect() / disconnect() lifecycle methods
 *   - emit() with no registered handler (set === undefined early return)
 *   - call() throwing when no result is configured for a method
 */

import { describe, expect, test } from "bun:test";

import { StubIpcClient } from "./stub-client.ts";

describe("StubIpcClient — lifecycle", () => {
  test("connect() sets disconnected = false", async () => {
    const stub = new StubIpcClient();
    stub.disconnected = true;
    await stub.connect();
    expect(stub.disconnected).toBe(false);
  });

  test("disconnect() sets disconnected = true", async () => {
    const stub = new StubIpcClient();
    await stub.disconnect();
    expect(stub.disconnected).toBe(true);
  });
});

describe("StubIpcClient — call()", () => {
  test("throws when method has no configured result and no configured error", async () => {
    const stub = new StubIpcClient({ results: {} });
    await expect(stub.call("unknown.method")).rejects.toThrow(
      /no result configured for method "unknown\.method"/,
    );
  });

  test("throws configured error when method has an error entry", async () => {
    const err = new Error("boom");
    const stub = new StubIpcClient({ errors: { "vault.get": err } });
    await expect(stub.call("vault.get")).rejects.toBe(err);
  });

  test("returns configured result when method is present in results", async () => {
    const stub = new StubIpcClient({ results: { "connector.list": [{ id: "github" }] } });
    const result = await stub.call<unknown[]>("connector.list");
    expect(result).toEqual([{ id: "github" }]);
  });
});

describe("StubIpcClient — emit() with no registered handler", () => {
  test("emit() for an unregistered method is a no-op", () => {
    const stub = new StubIpcClient();
    // Should not throw even though nothing is registered for "agent.chunk"
    expect(() => stub.emit("agent.chunk", { text: "hello" })).not.toThrow();
  });
});

describe("StubIpcClient — onNotification() and emit()", () => {
  test("handler registered via onNotification is called by emit()", () => {
    const stub = new StubIpcClient();
    const received: unknown[] = [];
    stub.onNotification("agent.chunk", (p) => {
      received.push(p);
    });
    stub.emit("agent.chunk", { text: "world" });
    expect(received).toEqual([{ text: "world" }]);
  });
});

describe("StubIpcClient — calls recording", () => {
  test("records each call in order", async () => {
    const stub = new StubIpcClient({
      results: { "a.method": 1, "b.method": 2 },
    });
    await stub.call("a.method", { x: 1 });
    await stub.call("b.method");
    expect(stub.calls).toEqual([
      { method: "a.method", params: { x: 1 } },
      { method: "b.method", params: undefined },
    ]);
  });
});

describe("StubIpcClient — asClient()", () => {
  test("asClient() returns the stub cast to IPCClient", () => {
    const stub = new StubIpcClient();
    // The return is the same object cast; equality is sufficient
    expect(stub.asClient()).toBe(stub as unknown as ReturnType<typeof stub.asClient>);
  });
});
