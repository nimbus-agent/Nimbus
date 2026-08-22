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

describe("withGatewayIpc — consent registration", () => {
  let dir: string;

  beforeEach(() => {
    out.reset();
    dir = mkdtempSync(join(tmpdir(), "nimbus-with-ipc-consent-"));
  });

  afterEach(() => {
    clearFixture();
    rmSync(dir, { recursive: true, force: true });
  });

  function fixtureWithOrder(order: string[]): void {
    setFixture({
      gatewayState: { socketPath: "/tmp/nimbus-consent.sock", pid: 1 },
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

  it("registers consent.request AFTER connect and BEFORE fn, with no option supplied", async () => {
    // Two properties in one order assertion.
    //
    // That it happens at all: three commands shipped unable to answer a HITL prompt —
    // `connector reindex --depth full`, `nimbus workflow run`, and (still broken when this
    // was written) `nimbus vault set` / `vault delete` / `connector add --mcp`. A default
    // that cannot be switched off is what makes forgetting impossible rather than merely
    // discouraged.
    //
    // And WHERE it happens: a handler registered after the first call is issued can miss a
    // notification arriving in the same socket chunk as that call's response.
    const order: string[] = [];
    fixtureWithOrder(order);

    await withGatewayIpc(
      async (client) => client.call<string>("vault.set", { key: "a.b", value: "c" }),
      makePaths(dir),
    );

    expect(order).toEqual(["connect", "onNotification:consent.request", "call", "disconnect"]);
  });

  it.each([
    ["prompt", { kind: "prompt" } as const],
    ["auto", { kind: "auto", sourceLabel: "--yes" } as const],
    ["flags/yes", { kind: "flags", yes: true } as const],
    ["flags/interactive", { kind: "flags", yes: false } as const],
  ])("the %s consent choice still registers consent.request", async (_label, consent) => {
    // Exhaustiveness over the union is the whole safety argument. `ConsentChoice` is worth
    // more than the free `onConnect` callback it replaced ONLY if every variant of it really
    // registers a handler — a variant that quietly did not would reintroduce the hang while
    // looking, at the call site, like a deliberate choice.
    const order: string[] = [];
    fixtureWithOrder(order);
    await withGatewayIpc(async (client) => client.call<string>("vault.set", {}), makePaths(dir), {
      consent,
    });
    expect(order).toContain("onNotification:consent.request");
  });

  it("still disconnects when registration throws", async () => {
    // Registration runs outside the try/finally, so a throw there must not strand the
    // connection. Reachable: `NIMBUS_SCRIPT_CONSENT_SOURCE` naming a file that is not there
    // makes `registerScriptConsentHandler` throw before any call is issued.
    const order: string[] = [];
    fixtureWithOrder(order);
    const prior = process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"];
    process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"] = join(dir, "no-such-decisions.jsonl");
    try {
      await expect(withGatewayIpc(async () => "unreached", makePaths(dir))).rejects.toThrow(
        "script consent source not found",
      );
    } finally {
      if (prior === undefined) delete process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"];
      else process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"] = prior;
    }
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

describe("consent cannot be dropped by a caller", () => {
  // The previous shape of this guard was a static scan, and CodeRabbit was right that it
  // could not hold: it required a consent-registrar IMPORT in any file passing `onConnect`,
  // and a file can import a registrar for one command while passing a do-nothing callback
  // for another. An earlier draft was weaker still — it matched the registrar's NAME
  // anywhere, and a COMMENT in `prove.ts` satisfied it while the real call site was broken.
  //
  // Two failed drafts is the signal. The option no longer takes a callback at all: it takes
  // a `ConsentChoice`, a closed union with no member meaning "nobody answers". So what is
  // asserted here is not a text pattern over call sites — it is that no call site can even
  // spell the failure, plus (in the `it.each` above) that every variant of the union really
  // does register.
  //
  // What remains, stated rather than glossed: a command that builds a bare `new IPCClient(...)`
  // — `extension.ts`, `team.ts`, `status.ts` and ~18 others — never reaches `withGatewayIpc`
  // and gets none of this. No gated method is called from any of them today, which is a
  // checked fact and not a guarantee.
  const SRC = join(import.meta.dir, "..");

  function* sourceFiles(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* sourceFiles(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        yield full;
      }
    }
  }

  /** Comments are not evidence — an earlier draft of this file passed on one. */
  function stripComments(src: string): string {
    return src.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");
  }

  it("no command passes a consent CALLBACK to the shared helper any more", () => {
    // `onConnect` is gone from `WithGatewayIpcOptions`, so a stray one would be a type error
    // rather than a silent hang — but `connector.ts` keeps a positional local wrapper whose
    // middle parameter a rename could turn back into a callback without the compiler minding.
    // This is the cheap check that the callback shape has not crept back in.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (stripComments(readFileSync(file, "utf8")).includes("onConnect")) {
        offenders.push(file.slice(SRC.length));
      }
    }
    expect(offenders).toEqual([]);
  });
});
