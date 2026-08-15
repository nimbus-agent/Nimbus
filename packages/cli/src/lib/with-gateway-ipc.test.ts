import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      const r = await client.call<{ ok: boolean }>("status.gateway", {});
      return r.ok ? "yes" : "no";
    }, makePaths(dir));

    expect(result).toBe("yes");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: "status.gateway", params: {} });
  });

  it("uses the default paths (no explicit argument) when only fn is provided", async () => {
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

describe("withGatewayIpc — onConnect", () => {
  let dir: string;

  beforeEach(() => {
    out.reset();
    dir = mkdtempSync(join(tmpdir(), "nimbus-with-ipc-onconnect-"));
  });

  afterEach(() => {
    clearFixture();
    rmSync(dir, { recursive: true, force: true });
  });

  function fixtureWithOrder(order: string[]): void {
    setFixture({
      gatewayState: { socketPath: "/tmp/nimbus-onconnect.sock", pid: 1 },
      ipcClient: {
        connect: async (): Promise<void> => {
          order.push("connect");
        },
        call: async (): Promise<string> => {
          order.push("call");
          return "ok";
        },
        disconnect: async (): Promise<void> => {
          order.push("disconnect");
        },
        onNotification: (event: string): void => {
          order.push(`onNotification:${event}`);
        },
      },
    });
  }

  it("runs onConnect AFTER connect and BEFORE fn", async () => {
    // Ordering is the property, not merely that it runs. A handler registered after the
    // first call is issued can miss a notification that arrives in the same socket chunk
    // as that call's response — which is how `connector reindex --depth full` and
    // `nimbus workflow run` both shipped hanging on a consent prompt that never appeared.
    const order: string[] = [];
    fixtureWithOrder(order);

    await withGatewayIpc(
      async (client) => client.call<string>("status.gateway", {}),
      makePaths(dir),
      {
        onConnect: (client) => {
          order.push("onConnect");
          client.onNotification("consent.request", () => {});
        },
      },
    );

    expect(order).toEqual([
      "connect",
      "onConnect",
      "onNotification:consent.request",
      "call",
      "disconnect",
    ]);
  });

  it("is optional — omitting it changes nothing", async () => {
    const order: string[] = [];
    fixtureWithOrder(order);
    await withGatewayIpc(
      async (client) => client.call<string>("status.gateway", {}),
      makePaths(dir),
    );
    expect(order).toEqual(["connect", "call", "disconnect"]);
  });

  it("still disconnects when onConnect throws", async () => {
    // A throwing registration must not strand the connection. `onConnect` runs outside
    // the try/finally, so this pins that the client is not leaked.
    const order: string[] = [];
    fixtureWithOrder(order);
    await expect(
      withGatewayIpc(async () => "unreached", makePaths(dir), {
        onConnect: () => {
          throw new Error("registration-failed");
        },
      }),
    ).rejects.toThrow("registration-failed");
    expect(order).not.toContain("call");
  });
});

describe("no command re-implements the connect/disconnect lifecycle", () => {
  // This consolidated ELEVEN near-identical local helpers into `withGatewayIpc`
  // (`withIpc` in audit / clip / people / share / vault / watch / connector / workflow /
  // prove, plus `withConsentIpc` and data's `withClient`). Six were byte-identical.
  //
  // The duplication was not cosmetic. Each copy was its own place to get the lifecycle
  // subtly wrong, and two of them did: `connector reindex --depth full` and
  // `nimbus workflow run` both shipped with no `consent.request` handler, so a HITL gate
  // hung until the request timeout. One implementation means one place to fix that.
  //
  // A thin local wrapper is still fine — `connector.ts` keeps one because eleven call
  // sites use its positional shape. What this forbids is a wrapper that does the work
  // ITSELF instead of delegating.
  const COMMANDS_DIR = join(import.meta.dir, "..", "commands");

  it("every local withIpc/withClient/withConsentIpc delegates to withGatewayIpc", () => {
    const offenders: string[] = [];
    for (const entry of readdirSync(COMMANDS_DIR)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      const src = readFileSync(join(COMMANDS_DIR, entry), "utf8");
      const declaresHelper = /async function with(?:Ipc|Client|ConsentIpc)\b/.test(src);
      if (!declaresHelper) continue;
      if (!src.includes("withGatewayIpc")) offenders.push(entry);
    }
    expect(offenders).toEqual([]);
  });

  it("no command file re-derives the full lifecycle inline in such a helper", () => {
    // The specific shape that was copied around: read the gateway state, throw the
    // not-running message, construct a client, connect, try/finally disconnect. A file
    // declaring its own helper must not also contain the raw not-running throw — that
    // string belongs to `GatewayNotRunningError` now.
    const offenders: string[] = [];
    for (const entry of readdirSync(COMMANDS_DIR)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      const src = readFileSync(join(COMMANDS_DIR, entry), "utf8");
      if (!/async function with(?:Ipc|Client|ConsentIpc)\b/.test(src)) continue;
      if (src.includes('throw new Error("Gateway is not running')) offenders.push(entry);
    }
    expect(offenders).toEqual([]);
  });
});
