import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import { CliExit } from "../lib/cli-exit.ts";

const mod = await import("./_agent-brief-cli.ts");
const { runAgentBriefCli, scanBriefCommandFlags, writeBriefOutput } = mod;

// `runAgentBriefCli` ends a failure by throwing `CliExit(2)` rather than calling
// `process.exit`, so the stream capture no longer needs to trap it.
const out = createStreamCapture();

/**
 * F30 — a fast `briefError` printed Bun's unhandled-rejection stack, with compiled source frames,
 * before the clean message.
 *
 * `runAgentBriefCli` created `briefPromise`, then `await`ed the RPC, then awaited the promise:
 *
 *   const briefPromise = awaitBrief(client, spec, …);
 *   await client.call(`agents.${spec.kind}`, spec.params);   // nothing watching briefPromise
 *   const { brief, findings } = await briefPromise;          // handler attached only now
 *
 * A `briefError` arriving in that window is an unhandled rejection AT THAT INSTANT, so Bun prints
 * a code frame and a ten-frame stack before the outer `catch` gets to write the clean line. The
 * gateway's fastest rejection — a ref that resolves to nothing, needing no work — lands squarely
 * there, which is why `nimbus pre-mortem "S2"` showed it and `why` / `janitor` / `impact` did not:
 * those render a brief with gap notes instead of rejecting.
 *
 * The clean path always worked. The defect is what the runtime printed BESIDE it, so a test that
 * exercises the catch proves nothing — this one asserts the rejection is watched from creation.
 */

interface Handlers {
  [event: string]: (params: unknown) => void;
}

/** A gateway whose `briefError` lands DURING the RPC, the window the race lived in. */
function rejectingDuringCall(handlers: Handlers, message: string) {
  return {
    connect: (): void => {},
    disconnect: (): void => {},
    onNotification: (event: string, handler: (params: unknown) => void): void => {
      handlers[event] = handler;
    },
    call: async (): Promise<unknown> => {
      // Fire the error before the RPC settles — the gateway can reject a bad ref faster than it
      // can answer the call that requested it.
      handlers["premortem.briefError"]?.({ error: message });
      // Then let a MACROTASK elapse before resolving. Without this the RPC settles in the same
      // microtask checkpoint, a handler attaches immediately, and the runtime never considers
      // the rejection unhandled — the test would pass against the unfixed code. A real RPC is a
      // socket round-trip, which is many ticks.
      await new Promise((r) => setTimeout(r, 5));
      return { sessionId: "s1" };
    },
  };
}

const spec = {
  kind: "premortem" as const,
  params: { ref: "S2" },
  json: false,
  guard: (f: unknown): f is Record<string, unknown> => typeof f === "object" && f !== null,
};

describe("runAgentBriefCli — a fast briefError (F30)", () => {
  beforeEach(() => {
    out.stdoutChunks.length = 0;
    out.stderrChunks.length = 0;
    out.install();
  });
  afterEach(() => {
    out.restore();
    clearFixture();
  });

  it("does not leave the brief promise unwatched while the RPC is in flight", async () => {
    // The property, stated as the runtime sees it: between creating `briefPromise` and awaiting
    // it, a rejection must already have a handler. Observed here by capturing Bun's own
    // unhandled-rejection event rather than by scraping stderr, which the harness intercepts.
    const handlers: Handlers = {};
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: rejectingDuringCall(handlers, "pre-mortem: 'S2' was not found"),
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (e: Event): void => {
      unhandled.push((e as Event & { reason?: unknown }).reason);
      e.preventDefault();
    };
    globalThis.addEventListener("unhandledrejection", onUnhandled);
    try {
      await expect(runAgentBriefCli(spec)).rejects.toMatchObject({ name: "CliExit", code: 2 });
      // Let the microtask queue drain — an unhandled rejection is reported a tick after the fact.
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      globalThis.removeEventListener("unhandledrejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it("still reports the error message, so the guard did not swallow it", async () => {
    // The other direction. Attaching a `.catch(() => {})` to silence the runtime must not also
    // silence the error — the message is the whole output of a failed brief.
    const handlers: Handlers = {};
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: rejectingDuringCall(handlers, "pre-mortem: 'S2' was not found"),
    });

    await expect(runAgentBriefCli(spec)).rejects.toMatchObject({ name: "CliExit", code: 2 });
    expect(out.stderrChunks.join("")).toContain("pre-mortem: 'S2' was not found");
  });
});

/** A gateway that delivers a valid brief straight away, so `spec.onResult` runs. */
function respondingClient(handlers: Handlers, findings: unknown, brief = "brief text") {
  return {
    connect: (): void => {},
    disconnect: (): void => {},
    onNotification: (event: string, handler: (params: unknown) => void): void => {
      handlers[event] = handler;
    },
    call: async (): Promise<unknown> => {
      setTimeout(() => {
        handlers["premortem.briefReady"]?.({ sessionId: "s1", brief, findings });
      }, 0);
      return { sessionId: "s1" };
    },
  };
}

describe("runAgentBriefCli — a CliExit raised by a caller-supplied extension point", () => {
  beforeEach(() => {
    out.stdoutChunks.length = 0;
    out.stderrChunks.length = 0;
    out.install();
  });
  afterEach(() => {
    out.restore();
    clearFixture();
  });

  // `spec.beforeCall`/`spec.onResult` are open extension points (see decisions.ts, glossary.ts,
  // owners.ts, preflight.ts) — none throws CliExit today, but the catch must not re-label one that
  // did: that would print a stray message and turn an intended exit 1 into exit 2, the same defect
  // `runAgentCli`'s catch had for `renderAgentBrief`'s empty-index CliExit(1).
  it("a CliExit(1) thrown from onResult propagates unchanged, with no stray stderr line", async () => {
    const handlers: Handlers = {};
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: respondingClient(handlers, { ok: true }),
    });

    await expect(
      runAgentBriefCli({
        ...spec,
        onResult: () => {
          throw new CliExit(1);
        },
      }),
    ).rejects.toMatchObject({ name: "CliExit", code: 1 });
    expect(out.stderrChunks.join("")).toBe("");
  });
});

describe("runAgentBriefCli — what it prints", () => {
  const savedEnv = {
    NIMBUS_DEMO: process.env["NIMBUS_DEMO"],
    NIMBUS_CONFIG_DIR: process.env["NIMBUS_CONFIG_DIR"],
    NIMBUS_GATEWAY_SOCKET: process.env["NIMBUS_GATEWAY_SOCKET"],
  };
  const BRIEF = "Next: `nimbus connector sync jira`";

  beforeEach(() => {
    out.stdoutChunks.length = 0;
    out.stderrChunks.length = 0;
    out.install();
  });
  afterEach(() => {
    out.restore();
    clearFixture();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("prints the brief verbatim outside the demo", async () => {
    const handlers: Handlers = {};
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: respondingClient(handlers, { ok: true }, BRIEF),
    });
    await runAgentBriefCli(spec);
    expect(out.stdoutChunks.join("")).toBe(`${BRIEF}\n`);
  });

  it("--demo: every backticked command it prints targets the demo gateway", async () => {
    delete process.env["NIMBUS_CONFIG_DIR"];
    delete process.env["NIMBUS_GATEWAY_SOCKET"];
    process.env["NIMBUS_DEMO"] = "1";
    const handlers: Handlers = {};
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: respondingClient(handlers, { ok: true }, BRIEF),
    });
    await runAgentBriefCli(spec);
    expect(out.stdoutChunks.join("")).toBe("Next: `nimbus --demo connector sync jira`\n");
  });
});

const USAGE = "Usage: nimbus probe [--service <name>]";

/** A command with two value flags of its own, the `oncall` shape. */
function scanWithValues(args: string[]) {
  return scanBriefCommandFlags(args, {
    usage: USAGE,
    defaultSince: "24h",
    valueFlags: ["--incident", "--service"],
  });
}

/** A command with none, the `standup` shape. */
function scanBare(args: string[]) {
  return scanBriefCommandFlags(args, { usage: USAGE, defaultSince: "7d", valueFlags: [] });
}

describe("scanBriefCommandFlags", () => {
  it("with no argv: the command's default --since, markdown, not --json, no values", () => {
    // `toStrictEqual`: an ungiven value flag is ABSENT, not present-and-undefined.
    expect(scanWithValues([])).toStrictEqual({
      since: "24h",
      format: "markdown",
      json: false,
      values: {},
    });
    expect(scanBare([]).since).toBe("7d");
  });

  it("reads every shared flag, and --since stays the string as typed", () => {
    expect(scanBare(["--json", "--since", " 3d ", "--format", "slack"])).toStrictEqual({
      since: "3d",
      format: "slack",
      json: true,
      values: {},
    });
    for (const f of ["markdown", "slack", "plain"] as const) {
      expect(scanBare(["--format", f]).format).toBe(f);
    }
  });

  it("a command's own value flags are captured by flag name, each consuming its value", () => {
    expect(scanWithValues(["--service", "checkout", "--json"])).toStrictEqual({
      since: "24h",
      format: "markdown",
      json: true,
      values: { "--service": "checkout" },
    });
    expect(scanWithValues(["--incident", "pagerduty:inc-9"]).values).toStrictEqual({
      "--incident": "pagerduty:inc-9",
    });
  });

  it("a repeated flag keeps its LAST value", () => {
    expect(scanBare(["--since", "1d", "--since", "2d"]).since).toBe("2d");
    expect(scanWithValues(["--service", "a", "--service", "b"]).values["--service"]).toBe("b");
  });

  it("an invalid --format is refused by value, with the usage text", () => {
    expect(() => scanBare(["--format", "html"])).toThrow(
      `--format must be one of markdown, slack, plain (got: html)\n${USAGE}`,
    );
  });

  it("--help and -h throw the usage text and nothing else", () => {
    for (const flag of ["--help", "-h"]) {
      let thrown: unknown;
      try {
        scanBare([flag]);
      } catch (e) {
        thrown = e;
      }
      expect((thrown as Error).message).toBe(USAGE);
    }
  });

  it("another command's value flag is an UNKNOWN flag here, not a silently ignored one", () => {
    // The `standup` rule: it declares no value flags, so a `--service` (or any flag that could aim
    // the brief at someone else) is refused rather than dropped.
    expect(() => scanBare(["--service", "checkout"])).toThrow(`Unknown flag: --service\n${USAGE}`);
    expect(() => scanWithValues(["--sicne", "7d"])).toThrow(`Unknown flag: --sicne\n${USAGE}`);
  });

  it("a positional argument is refused with the usage text", () => {
    expect(() => scanBare(["alice"])).toThrow(`Unexpected argument: alice\n${USAGE}`);
  });

  it("a value flag missing its value is an error, never the next flag taken as the value", () => {
    expect(() => scanWithValues(["--service"])).toThrow("--service requires a value");
    expect(() => scanWithValues(["--incident", "--json"])).toThrow("--incident requires a value");
    expect(() => scanBare(["--since"])).toThrow("--since requires a value");
    expect(() => scanBare(["--format", "--json"])).toThrow("--format requires a value");
  });
});

describe("writeBriefOutput", () => {
  const BRIEF = "## Deployments\n\n- [Fix auth](https://x/1) **shipped**";
  const FINDINGS = { kind: "probe", gaps: [] };

  beforeEach(() => {
    out.stdoutChunks.length = 0;
    out.stderrChunks.length = 0;
    out.install();
  });
  afterEach(() => {
    out.restore();
  });

  it("--json prints the findings object, never the brief", () => {
    writeBriefOutput(BRIEF, FINDINGS, { json: true, format: "slack" });
    expect(out.stdoutChunks.join("")).toBe(`${JSON.stringify(FINDINGS, null, 2)}\n`);
  });

  it("markdown prints the brief verbatim", () => {
    writeBriefOutput(BRIEF, FINDINGS, { json: false, format: "markdown" });
    expect(out.stdoutChunks.join("")).toBe(`${BRIEF}\n`);
  });

  it("slack and plain transform the brief's own Markdown", () => {
    writeBriefOutput(BRIEF, FINDINGS, { json: false, format: "slack" });
    writeBriefOutput(BRIEF, FINDINGS, { json: false, format: "plain" });
    expect(out.stdoutChunks).toStrictEqual([
      "*Deployments*\n\n- <https://x/1|Fix auth> *shipped*\n",
      "Deployments\n\n- Fix auth shipped\n",
    ]);
    expect(out.stderrChunks.join("")).toBe("");
  });
});
