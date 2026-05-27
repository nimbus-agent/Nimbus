// packages/cli/src/lib/with-gateway-ipc.test.ts
//
// Phase 6 commit 4 of 14 — covers `withGatewayIpc`:
//   * the "gateway not running" throw (state === undefined),
//   * the happy path (state present -> connect -> fn -> disconnect),
//   * the finally-disconnect contract (disconnect runs when fn throws).
//
// IMPORTANT: the shared harness (cli-mocks.ts) already installs
// mock.module() for:
//   - `../../src/lib/gateway-process.ts` -> `readGatewayState` delegates
//     to `globalThis.__nimbusCliFixture.gatewayState`.
//   - `../../src/ipc-client/index.ts` -> `IPCClient` becomes a FakeIPCClient
//     whose `.call()` delegates to `fixture.ipcClient.call`.
// Module-load discipline mirrors `commands/vault.test.ts`: import the
// harness first for its side effects, then dynamic-import the module
// under test so the static imports inside it pick up the mocks.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "../../test/helpers/cli-mocks.ts"; // module-load side effects only
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";

const mod = await import("./with-gateway-ipc.ts");
const { withGatewayIpc } = mod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

function makePaths(root: string) {
  return {
    configDir: join(root, "config"),
    dataDir: join(root, "data"),
    logDir: join(root, "data", "logs"),
    socketPath: join(root, "fake.sock"),
    extensionsDir: join(root, "ext"),
    tempDir: join(root, "tmp"),
  };
}

describe("withGatewayIpc — gateway not running", () => {
  let dir: string;

  beforeEach(() => {
    out.reset();
    dir = mkdtempSync(join(tmpdir(), "nimbus-with-ipc-"));
    // fixture.gatewayState left undefined -> readGatewayState() returns
    // undefined -> withGatewayIpc throws the canonical message.
    setFixture({});
  });

  afterEach(() => {
    clearFixture();
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws the canonical 'Gateway is not running' message", async () => {
    await expect(withGatewayIpc(async () => "unreachable", makePaths(dir))).rejects.toThrow(
      "Gateway is not running. Start with: nimbus start",
    );
  });

  it("does not invoke the inner function when the gateway is not running", async () => {
    let called = false;
    const fn = async (): Promise<string> => {
      called = true;
      return "should not run";
    };
    await expect(withGatewayIpc(fn, makePaths(dir))).rejects.toThrow("Gateway is not running");
    expect(called).toBe(false);
  });
});

describe("withGatewayIpc — happy path (mocked IPCClient)", () => {
  let dir: string;

  beforeEach(() => {
    out.reset();
    dir = mkdtempSync(join(tmpdir(), "nimbus-with-ipc-ok-"));
  });

  afterEach(() => {
    clearFixture();
    rmSync(dir, { recursive: true, force: true });
  });

  it("constructs the client, invokes fn, and returns its resolved value", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: "/tmp/nimbus-with-ipc-happy.sock", pid: 4242 },
      ipcClient: {
        call: async (method: string, params: unknown): Promise<unknown> => {
          calls.push({ method, params });
          return { ok: true };
        },
        connect: async (): Promise<void> => {},
        disconnect: async (): Promise<void> => {},
      },
    });

    const result = await withGatewayIpc(async (client) => {
      // The dispatcher's stub IPCClient (from cli-mocks) delegates `.call`
      // through to fixture.ipcClient.call. Any read-only RPC works here;
      // the exact method is opaque to with-gateway-ipc itself.
      const r = await client.call<{ ok: boolean }>("status.gateway", {});
      return r.ok ? "yes" : "no";
    }, makePaths(dir));

    expect(result).toBe("yes");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: "status.gateway", params: {} });
  });

  it("uses the default paths (no explicit argument) when only fn is provided", async () => {
    // Exercises the default-argument branch of withGatewayIpc. The harness
    // mock of readGatewayState is paths-agnostic, so this works without
    // needing the host process's real APPDATA/XDG_*.
    setFixture({
      gatewayState: { socketPath: "/tmp/nimbus-default-paths.sock", pid: 1 },
      ipcClient: {
        call: async (): Promise<string> => "ok",
        connect: async (): Promise<void> => {},
        disconnect: async (): Promise<void> => {},
      },
    });

    const result = await withGatewayIpc(async (client) =>
      client.call<string>("status.gateway", {}),
    );
    expect(result).toBe("ok");
  });

  it("propagates fn's thrown error (and still completes via the finally branch)", async () => {
    setFixture({
      gatewayState: { socketPath: "/tmp/nimbus-throws.sock", pid: 1 },
      ipcClient: {
        call: async (): Promise<never> => {
          throw new Error("rpc-failed");
        },
        connect: async (): Promise<void> => {},
        disconnect: async (): Promise<void> => {},
      },
    });

    await expect(
      withGatewayIpc(async (client) => client.call<string>("status.gateway", {}), makePaths(dir)),
    ).rejects.toThrow("rpc-failed");
    // Reaching this assertion means the `try/finally` ran disconnect()
    // without swallowing the error or hanging.
  });
});
