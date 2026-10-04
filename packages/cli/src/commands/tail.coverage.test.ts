import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearFixture,
  FAKE_SOCKET_PATH,
  type RecordedClientConstruction,
  setFixture,
} from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";

// Imported AFTER cli-mocks: gateway state and the IPC client are the in-process fakes.
const { readGatewayState } = await import("../lib/gateway-process.ts");
const { getCliPlatformPaths } = await import("../paths.ts");
const { runTailCommand } = await import("./tail.ts");
// A namespace, read inside each test: the fake class it holds is the one `tail.ts` constructs.
const ipcClientModule = await import("../ipc-client/index.ts");

/** One macrotask: drains `runTailCommand`'s awaits before its subscriptions are inspected. */
function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * `tail.test.ts` drives every lifecycle path through injected deps, so the production seams --
 * the real state read, the real stderr, the real `process.exit` -- were never the ones under test.
 * These run `runTailCommand` with no deps.
 */
describe("runTailCommand with its PRODUCTION deps", () => {
  const streams = createStreamCapture({ captureExit: true });

  beforeEach(async () => {
    // Prove the state read is the fake before any test can reach a connect: the real one would read
    // the developer's own state file and fail this equality instead of tailing a live gateway.
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    const seen: unknown = await readGatewayState(getCliPlatformPaths());
    expect(seen).toEqual({ socketPath: FAKE_SOCKET_PATH });
    clearFixture();
    streams.stdoutChunks.length = 0;
    streams.stderrChunks.length = 0;
    streams.install();
  });

  afterEach(() => {
    streams.restore();
    clearFixture();
  });

  test("no running gateway: the standard line on the real stderr, then the real exit(1)", async () => {
    setFixture({});
    await expect(runTailCommand([])).rejects.toThrow("process.exit(1)");
    expect(streams.stderrChunks.join("")).toBe(
      "Gateway is not running. Start with: nimbus start\n",
    );
    expect(streams.stdoutChunks).toEqual([]);
  });

  test("a stale state file whose socket refuses the connect reports the same line and exits 1", async () => {
    const stdoutErrorListeners = process.stdout.listenerCount("error");
    let connects = 0;
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        connect: async (): Promise<void> => {
          connects += 1;
          throw new Error("ECONNREFUSED");
        },
        disconnect: async (): Promise<void> => {},
        call: async (): Promise<unknown> => undefined,
      },
    });
    await expect(runTailCommand([])).rejects.toThrow("process.exit(1)");
    expect(connects).toBe(1);
    expect(streams.stderrChunks.join("")).toBe(
      "Gateway is not running. Start with: nimbus start\n",
    );
    // A failed connect never reaches the EPIPE guard, so it must not have attached one.
    expect(process.stdout.listenerCount("error")).toBe(stdoutErrorListeners);
  });

  test("a running gateway is dialed once, and its events reach the REAL stdout until it closes", async () => {
    const constructions: RecordedClientConstruction[] = [];
    const handlers = new Map<string, (params: unknown) => void>();
    let connects = 0;
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      clientConstructions: constructions,
      ipcClient: {
        connect: async (): Promise<void> => {
          connects += 1;
        },
        disconnect: async (): Promise<void> => {},
        call: async (): Promise<unknown> => undefined,
        onNotification: (method: string, handler: (params: unknown) => void): void => {
          handlers.set(method, handler);
        },
      },
    });
    // The shared fake client has no `onClose`, which this command subscribes to once connected.
    // Lend the current fake class one for this test only, and put the prototype back exactly.
    const proto = ipcClientModule.IPCClient.prototype as unknown as Record<string, unknown>;
    const savedOnClose = Object.getOwnPropertyDescriptor(proto, "onClose");
    let closeGateway: ((err: Error) => void) | undefined;
    Object.defineProperty(proto, "onClose", {
      configurable: true,
      writable: true,
      value: (handler: (err: Error) => void): void => {
        closeGateway = handler;
      },
    });
    const savedExitCode = process.exitCode;
    try {
      const done = runTailCommand([]);
      await nextMacrotask();
      // The production connect built the FAKE client (the real one records nothing here) at the
      // recorded socket, connected it once, and returned it subscribed to exactly the two methods.
      expect(constructions).toEqual([{ socketPath: FAKE_SOCKET_PATH, opts: undefined }]);
      expect(connects).toBe(1);
      expect([...handlers.keys()].sort()).toEqual(["connector.healthChanged", "gateway.event"]);

      handlers.get("gateway.event")?.({
        kind: "sync.completed",
        ts: 0,
        payload: { serviceId: "github", itemsUpserted: 3, itemsDeleted: 1, durationMs: 42 },
      });
      // Asserted, not just optionally called: a command that never subscribed to onClose would
      // otherwise leave `done` pending and fail only at the runner's 30 s timeout.
      expect(closeGateway).toBeDefined();
      closeGateway?.(new Error("socket closed"));
      await done;

      expect(streams.stdoutChunks).toEqual([
        "1970-01-01T00:00:00.000Z [sync]      github: +3 items, -1 (42ms)\n",
      ]);
      expect(streams.stderrChunks.join("")).toBe("[nimbus tail] Gateway connection closed.\n");
      expect(process.exitCode).toBe(1);
    } finally {
      if (savedOnClose === undefined) Reflect.deleteProperty(proto, "onClose");
      else Object.defineProperty(proto, "onClose", savedOnClose);
      // `?? 0`: Bun ignores `process.exitCode = undefined`, which would leak this test's 1.
      process.exitCode = savedExitCode ?? 0;
    }
  });
});
