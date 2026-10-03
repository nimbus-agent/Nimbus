import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  clearFixture,
  FAKE_SOCKET_PATH,
  type RecordedClientConstruction,
  setFixture,
} from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";

const mod = await import("./agent-cli-dispatcher.ts");
const { agentBriefClientOrExit, fetchAgentBrief, runAgentCli } = mod;

// `runAgentCli` now throws `CliExit` on failure instead of calling `process.exit`, so the
// stream capture no longer needs to trap it.
const { stdoutChunks, stderrChunks, install, restore } = createStreamCapture();

afterAll(() => {
  restore();
});

function isAnyBrief(x: unknown): x is { gaps: readonly { category: string }[] } {
  return typeof x === "object" && x !== null && Array.isArray((x as { gaps?: unknown }).gaps);
}

describe("runAgentCli", () => {
  beforeEach(() => {
    stderrChunks.length = 0;
    install();
  });
  afterEach(() => {
    clearFixture();
    restore();
  });

  it("exits 1 when the gateway is not running", async () => {
    setFixture({});
    await expect(
      runAgentCli({
        agentName: "x",
        ipcMethod: "agents.x",
        callParams: {},
        guard: isAnyBrief,
        json: false,
      }),
    ).rejects.toMatchObject({ name: "CliExit", code: 1 });
    expect(stderrChunks.join("")).toContain("Gateway is not running");
  });

  it("exits 2 and stringifies a NON-Error rejection from the IPC call", async () => {
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        connect: async () => {},
        disconnect: async () => {},
        // Throw a bare string (not an Error) → exercises the `String(err)` arm.
        call: async () => {
          throw "plain string failure";
        },
        onNotification: () => {},
      },
    });
    await expect(
      runAgentCli({
        agentName: "x",
        ipcMethod: "agents.x",
        callParams: {},
        guard: isAnyBrief,
        json: false,
      }),
    ).rejects.toMatchObject({ name: "CliExit", code: 2 });
    expect(stderrChunks.join("")).toContain("plain string failure");
  });

  it("exits 2 and still disconnects when connect() fails inside the boundary", async () => {
    let disconnected = false;
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        // connect() now runs inside the try/finally, so a setup failure must
        // hit the stderr + exit(2) path AND the finally disconnect.
        connect: async () => {
          throw new Error("stale socket");
        },
        disconnect: async () => {
          disconnected = true;
        },
        call: async () => undefined,
        onNotification: () => {},
      },
    });
    await expect(
      runAgentCli({
        agentName: "x",
        ipcMethod: "agents.x",
        callParams: {},
        guard: isAnyBrief,
        json: false,
      }),
    ).rejects.toMatchObject({ name: "CliExit", code: 2 });
    expect(stderrChunks.join("")).toContain("stale socket");
    expect(disconnected).toBe(true);
  });

  it("a rejecting disconnect() in the finally does not replace the pending CliExit(2)", async () => {
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        connect: async () => {},
        // The cleanup now RUNS on the failure path (process.exit used to skip it), so a throw
        // here would otherwise win over the CliExit and surface as a printed error + exit 1.
        disconnect: async () => {
          throw new Error("socket already torn down");
        },
        call: async () => {
          throw new Error("rpc failed");
        },
        onNotification: () => {},
      },
    });
    await expect(
      runAgentCli({
        agentName: "x",
        ipcMethod: "agents.x",
        callParams: {},
        guard: isAnyBrief,
        json: false,
      }),
    ).rejects.toMatchObject({ name: "CliExit", code: 2 });
    const stderr = stderrChunks.join("");
    expect(stderr).toContain("rpc failed");
    expect(stderr).not.toContain("socket already torn down");
  });

  it("an empty_index gap exits 1 with the hint only — the catch does not re-label it", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        connect: async () => {},
        disconnect: async () => {},
        call: async () => {
          setTimeout(() => {
            handlers.get("x.briefReady")?.({
              sessionId: "s",
              brief: "brief text",
              findings: { gaps: [{ category: "empty_index" }] },
            });
          }, 0);
          return { sessionId: "s" };
        },
        onNotification: (event: string, handler: (params: unknown) => void) => {
          handlers.set(event, handler);
        },
      },
    });
    await expect(
      runAgentCli({
        agentName: "x",
        ipcMethod: "agents.x",
        callParams: {},
        guard: isAnyBrief,
        json: false,
      }),
    ).rejects.toMatchObject({
      name: "CliExit",
      code: 1,
    });
    const stderr = stderrChunks.join("");
    expect(stderr).toContain("No data indexed yet");
    expect(stderr).not.toContain("exit 1");
    expect(stderr).not.toContain("process.exit");
  });
});

describe("agentBriefClientOrExit", () => {
  beforeEach(() => {
    stderrChunks.length = 0;
    install();
  });
  afterEach(() => {
    clearFixture();
    restore();
  });

  it("builds — but never connects — a client for the running gateway's socket", async () => {
    let connects = 0;
    const constructed: RecordedClientConstruction[] = [];
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      clientConstructions: constructed,
      ipcClient: {
        connect: async () => {
          connects += 1;
        },
        disconnect: async () => {},
        call: async () => undefined,
      },
    });

    const { demo } = await agentBriefClientOrExit();

    expect(constructed.map((c) => c.socketPath)).toEqual([FAKE_SOCKET_PATH]);
    // The caller connects INSIDE its own try, so a stale socket reaches its exit-2 path.
    expect(connects).toBe(0);
    expect(demo).toBe(false);
    expect(stderrChunks.join("")).toBe("");
  });

  it("exits 1 with the not-running message and builds no client when no gateway is running", async () => {
    const constructed: RecordedClientConstruction[] = [];
    setFixture({ clientConstructions: constructed });
    await expect(agentBriefClientOrExit()).rejects.toMatchObject({ name: "CliExit", code: 1 });
    expect(stderrChunks.join("")).toContain("Gateway is not running");
    expect(constructed).toEqual([]);
  });
});

type ProbeFindings = { kind: "probe"; gaps: unknown[] };

function isProbeFindings(x: unknown): x is ProbeFindings {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { kind?: unknown }).kind === "probe" &&
    Array.isArray((x as { gaps?: unknown }).gaps)
  );
}

const PROBE_FINDINGS: ProbeFindings = { kind: "probe", gaps: [] };

/** What the fake gateway saw, so a test can assert the wire — not just the result. */
type Recorded = { method?: string; params?: unknown; events: string[]; disconnects: number };

/**
 * A gateway that answers the `agents.*` call, then fires ONE notification on a later macrotask —
 * a real reply arrives on a later socket chunk than the call's own response.
 */
function briefingGateway(
  rec: Recorded,
  notify: { event: string; payload: unknown },
  opts: { disconnect?: () => Promise<void> } = {},
) {
  const handlers = new Map<string, (params: unknown) => void>();
  return {
    connect: async () => {},
    disconnect:
      opts.disconnect ??
      (async () => {
        rec.disconnects += 1;
      }),
    onNotification: (event: string, handler: (params: unknown) => void) => {
      rec.events.push(event);
      handlers.set(event, handler);
    },
    call: async (method: string, params: unknown) => {
      rec.method = method;
      rec.params = params;
      setTimeout(() => {
        handlers.get(notify.event)?.(notify.payload);
      }, 0);
      return { sessionId: "s1" };
    },
  };
}

describe("fetchAgentBrief", () => {
  const savedDemoEnv = {
    NIMBUS_DEMO: process.env["NIMBUS_DEMO"],
    NIMBUS_CONFIG_DIR: process.env["NIMBUS_CONFIG_DIR"],
    NIMBUS_GATEWAY_SOCKET: process.env["NIMBUS_GATEWAY_SOCKET"],
  };

  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    install();
  });
  afterEach(() => {
    clearFixture();
    restore();
    for (const [k, v] of Object.entries(savedDemoEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("calls agents.<agentName> with the params verbatim and resolves to the brief + findings", async () => {
    const rec: Recorded = { events: [], disconnects: 0 };
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: briefingGateway(rec, {
        event: "probe.briefReady",
        payload: { sessionId: "s1", brief: "## Probe", findings: PROBE_FINDINGS },
      }),
    });

    const result = await fetchAgentBrief(
      "probe",
      { sinceMs: 5, service: "checkout" },
      isProbeFindings,
    );

    expect(result).toStrictEqual({ brief: "## Probe", findings: PROBE_FINDINGS });
    expect(rec.method).toBe("agents.probe");
    expect(rec.params).toStrictEqual({ sinceMs: 5, service: "checkout" });
    // Both event names derive from the agent name; no other agent's channel is subscribed.
    expect(rec.events).toContain("probe.briefReady");
    expect(rec.events).toContain("probe.briefError");
    expect(rec.events.some((e) => e.endsWith(".briefReady") && e !== "probe.briefReady")).toBe(
      false,
    );
    // It RETURNS the brief for the command to print — nothing reaches stdout here.
    expect(stdoutChunks.join("")).toBe("");
    expect(rec.disconnects).toBe(1);
  });

  it("exits 1 when the gateway is not running, before any connection", async () => {
    setFixture({});
    await expect(fetchAgentBrief("probe", {}, isProbeFindings)).rejects.toMatchObject({
      name: "CliExit",
      code: 1,
    });
    expect(stderrChunks.join("")).toContain("Gateway is not running");
  });

  it("exits 2 and prints the gateway's briefError message verbatim", async () => {
    const rec: Recorded = { events: [], disconnects: 0 };
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: briefingGateway(rec, {
        event: "probe.briefError",
        payload: { sessionId: "s1", error: "ERR_PROBE_REFUSED: name an incident" },
      }),
    });
    await expect(fetchAgentBrief("probe", {}, isProbeFindings)).rejects.toMatchObject({
      name: "CliExit",
      code: 2,
    });
    expect(stderrChunks.join("")).toBe("ERR_PROBE_REFUSED: name an incident\n");
    expect(rec.disconnects).toBe(1);
  });

  it("exits 2 when the findings fail the guard, rather than returning an unchecked shape", async () => {
    const rec: Recorded = { events: [], disconnects: 0 };
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: briefingGateway(rec, {
        event: "probe.briefReady",
        payload: { sessionId: "s1", brief: "x", findings: { kind: "someone-else", gaps: [] } },
      }),
    });
    await expect(fetchAgentBrief("probe", {}, isProbeFindings)).rejects.toMatchObject({
      name: "CliExit",
      code: 2,
    });
    expect(stderrChunks.join("")).toContain("Malformed probe.briefReady payload");
  });

  it("a rejecting disconnect() after a delivered brief does not turn success into a failure", async () => {
    // The brief is already in hand by the time the socket is torn down; a failed teardown of a
    // socket the process is about to drop must not change the outcome.
    const rec: Recorded = { events: [], disconnects: 0 };
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: briefingGateway(
        rec,
        {
          event: "probe.briefReady",
          payload: { sessionId: "s1", brief: "ok", findings: PROBE_FINDINGS },
        },
        {
          disconnect: async () => {
            throw new Error("socket already torn down");
          },
        },
      ),
    });
    const result = await fetchAgentBrief("probe", {}, isProbeFindings);
    expect(result.brief).toBe("ok");
    expect(stderrChunks.join("")).toBe("");
  });

  it("--demo: rewrites the brief's backticked commands to the demo, never the findings", async () => {
    delete process.env["NIMBUS_CONFIG_DIR"];
    delete process.env["NIMBUS_GATEWAY_SOCKET"];
    process.env["NIMBUS_DEMO"] = "1";
    const findings: ProbeFindings = { kind: "probe", gaps: ["run `nimbus connector sync github`"] };
    const rec: Recorded = { events: [], disconnects: 0 };
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: briefingGateway(rec, {
        event: "probe.briefReady",
        payload: { sessionId: "s1", brief: "Fix: `nimbus connector sync github`", findings },
      }),
    });

    const result = await fetchAgentBrief("probe", {}, isProbeFindings);

    expect(result.brief).toBe("Fix: `nimbus --demo connector sync github`");
    // `--json` prints `findings` — it must reach the user exactly as the gateway sent it.
    expect(result.findings).toStrictEqual(findings);
  });
});

/**
 * A gateway that answers the `agents.*` call only after the brief has ALREADY settled — the window
 * `runAgentBriefCli` closed for F30, here for the lifecycle `runAgentCli` and `fetchAgentBrief`
 * share. With `briefErrorFirst`, the call fires a `<agent>.briefError` with no sessionId (the router
 * attributes it to the sole waiter and rejects at once); without it, nothing is sent and the brief
 * timer is left to fire first. Either way it then lets `replyAfterMs` of MACROTASKS elapse before
 * answering: a reply in the same microtask checkpoint would let the `await` attach a handler at
 * once, and the runtime would never see an unhandled rejection — the tests would pass unfixed.
 */
function settlesDuringCall(opts: {
  agent: string;
  briefErrorFirst?: string;
  replyAfterMs: number;
}) {
  const handlers = new Map<string, (params: unknown) => void>();
  return {
    connect: async () => {},
    disconnect: async () => {},
    onNotification: (event: string, handler: (params: unknown) => void) => {
      handlers.set(event, handler);
    },
    call: async () => {
      if (opts.briefErrorFirst !== undefined) {
        handlers.get(`${opts.agent}.briefError`)?.({ error: opts.briefErrorFirst });
      }
      await new Promise((r) => setTimeout(r, opts.replyAfterMs));
      return { sessionId: "s1" };
    },
  };
}

/**
 * Runs `body`, recording every unhandled rejection the runtime reports meanwhile. Observed through
 * Bun's own `unhandledrejection` event rather than by scraping stderr, which the capture intercepts.
 * Unwatched, Bun prints a stack trace for such a rejection and the CLI process exits 1, not the 2
 * these paths promise.
 */
async function unhandledRejectionsDuring(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (e: Event): void => {
    seen.push((e as Event & { reason?: unknown }).reason);
    e.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    await body();
    // An unhandled rejection is reported a tick after the fact.
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
  }
  return seen;
}

describe("the brief settles while the agents.* call is still in flight", () => {
  const savedTimeout = process.env["NIMBUS_BRIEF_TIMEOUT_MS"];

  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    install();
  });
  afterEach(() => {
    clearFixture();
    restore();
    if (savedTimeout === undefined) delete process.env["NIMBUS_BRIEF_TIMEOUT_MS"];
    else process.env["NIMBUS_BRIEF_TIMEOUT_MS"] = savedTimeout;
  });

  it("fetchAgentBrief: a briefError landing mid-call exits 2 with the clean message only", async () => {
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: settlesDuringCall({
        agent: "probe",
        briefErrorFirst: "probe: 'S2' was not found",
        replyAfterMs: 5,
      }),
    });

    const unhandled = await unhandledRejectionsDuring(async () => {
      await expect(fetchAgentBrief("probe", {}, isProbeFindings)).rejects.toMatchObject({
        name: "CliExit",
        code: 2,
      });
    });

    expect(unhandled).toEqual([]);
    // The no-op watcher silences the RUNTIME, not the error: the message still reaches the user.
    expect(stderrChunks.join("")).toBe("probe: 'S2' was not found\n");
  });

  it("runAgentCli: a briefError landing mid-call exits 2 with the clean message only", async () => {
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: settlesDuringCall({
        agent: "x",
        briefErrorFirst: "x: 'S2' was not found",
        replyAfterMs: 5,
      }),
    });

    const unhandled = await unhandledRejectionsDuring(async () => {
      await expect(
        runAgentCli({
          agentName: "x",
          ipcMethod: "agents.x",
          callParams: {},
          guard: isAnyBrief,
          json: false,
        }),
      ).rejects.toMatchObject({ name: "CliExit", code: 2 });
    });

    expect(unhandled).toEqual([]);
    expect(stderrChunks.join("")).toBe("x: 'S2' was not found\n");
  });

  it("a brief timeout that fires before the call answers exits 2, not a crash", async () => {
    // The user-reachable trigger: NIMBUS_BRIEF_TIMEOUT_MS set low "to fail fast" while the gateway
    // is slow to answer the call itself. `changelog` used to exit 2 here only because its
    // `process.exit(2)` overrode the crash; through this shared path it would have exited 1.
    process.env["NIMBUS_BRIEF_TIMEOUT_MS"] = "20";
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: settlesDuringCall({ agent: "probe", replyAfterMs: 80 }),
    });

    const unhandled = await unhandledRejectionsDuring(async () => {
      await expect(fetchAgentBrief("probe", {}, isProbeFindings)).rejects.toMatchObject({
        name: "CliExit",
        code: 2,
      });
    });

    expect(unhandled).toEqual([]);
    expect(stderrChunks.join("")).toBe("Agent timed out after 20 ms\n");
  });
});
