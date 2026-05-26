import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  type ConnectionDeps,
  type ConnectionState,
  createConnectionManager,
} from "../../src/connection/connection-manager.js";

class FakeClient {
  closed = false;
  async close(): Promise<void> {
    this.closed = true;
  }
}

function makeDeps(opts: { openSequence: Array<"ok" | "eacces" | "enoent"> }): {
  deps: ConnectionDeps;
  events: ConnectionState[];
  openCalls: number;
} {
  const events: ConnectionState[] = [];
  let openCallIndex = 0;
  const deps: ConnectionDeps = {
    open: async () => {
      const outcome = opts.openSequence[openCallIndex] ?? "ok";
      openCallIndex += 1;
      if (outcome === "eacces") {
        const err = new Error("permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      if (outcome === "enoent") {
        const err = new Error("no such file") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return new FakeClient() as unknown as never;
    },
    discoverSocket: async () => ({
      socketPath: "/run/nimbus-test/test.sock",
      source: "default" as const,
    }),
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    reconnectDelayMs: 5,
  };
  const mgr = createConnectionManager(deps);
  mgr.onState((s) => events.push(s));
  return { deps, events, openCalls: 0 };
}

describe("ConnectionManager", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("transitions connecting → connected on success", async () => {
    const { deps } = makeDeps({ openSequence: ["ok"] });
    const mgr = createConnectionManager(deps);
    const collected: ConnectionState[] = [];
    mgr.onState((s) => collected.push(s));
    await mgr.start();
    expect(collected.map((s) => s.kind)).toContain("connected");
    await mgr.dispose();
  });

  test("transitions to permission-denied on EACCES", async () => {
    const deps: ConnectionDeps = {
      open: async () => {
        const err = new Error("permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      },
      discoverSocket: async () => ({
        socketPath: "/run/nimbus-test/x.sock",
        source: "default" as const,
      }),
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      reconnectDelayMs: 1000,
    };
    const mgr = createConnectionManager(deps);
    const states: ConnectionState[] = [];
    mgr.onState((s) => states.push(s));
    await mgr.start();
    const last = states.at(-1);
    expect(last?.kind).toBe("permission-denied");
    if (last?.kind === "permission-denied") {
      expect(last.socketPath).toBe("/run/nimbus-test/x.sock");
    }
    await mgr.dispose();
  });

  test("retries on ENOENT until success", async () => {
    const deps: ConnectionDeps = (() => {
      let i = 0;
      return {
        open: async () => {
          i += 1;
          if (i < 3) {
            const err = new Error("nope") as NodeJS.ErrnoException;
            err.code = "ENOENT";
            throw err;
          }
          return new FakeClient() as unknown as never;
        },
        discoverSocket: async () => ({
          socketPath: "/run/nimbus-test/y.sock",
          source: "default" as const,
        }),
        log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
        reconnectDelayMs: 1,
      };
    })();
    const mgr = createConnectionManager(deps);
    const states: ConnectionState[] = [];
    mgr.onState((s) => states.push(s));
    await mgr.start();
    // Allow retries
    await new Promise((r) => setTimeout(r, 50));
    const kinds = states.map((s) => s.kind);
    expect(kinds).toContain("connected");
    await mgr.dispose();
  });
});
