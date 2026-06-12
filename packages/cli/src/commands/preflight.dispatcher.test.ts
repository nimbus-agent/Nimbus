import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import { runPreflightCli } from "./preflight.ts";

const {
  stdoutChunks,
  stderrChunks,
  install: installStreamCapture,
  restore: restoreStreams,
} = createStreamCapture({ captureExit: true });

afterAll(() => {
  restoreStreams();
});

function makeValidPreflightBrief(
  opts: { anyFailed?: boolean; anyIncomplete?: boolean } = {},
): unknown {
  return {
    kind: "preflight",
    agentVersion: 1,
    generatedAt: 1_700_000_000,
    latencyMs: 9,
    gaps: [],
    query: { ref: "HEAD", namespace: "project:zurich" },
    downstreams: [],
    anyFailed: opts.anyFailed ?? false,
    anyIncomplete: opts.anyIncomplete ?? false,
  };
}

function preflightFixture(opts: {
  event?: "preflight.briefReady" | "preflight.briefError";
  payload?: unknown;
  onParams?: (p: unknown) => void;
}): void {
  const handlers = new Map<string, (params: unknown) => void>();
  setFixture({
    gatewayState: { socketPath: FAKE_SOCKET_PATH },
    ipcClient: {
      call: async (method: string, params: unknown) => {
        if (method === "agents.preflight") {
          opts.onParams?.(params);
          if (opts.event !== undefined) {
            setTimeout(() => handlers.get(opts.event as string)?.(opts.payload), 0);
          }
          return { sessionId: "s" };
        }
        return undefined;
      },
      connect: async () => {},
      disconnect: async () => {},
      onNotification: (event: string, handler: (params: unknown) => void) => {
        handlers.set(event, handler);
      },
    },
  });
}

describe("runPreflightCli — run mode", () => {
  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    process.exitCode = 0;
    installStreamCapture();
  });
  afterEach(() => {
    clearFixture();
    restoreStreams();
    process.exitCode = 0;
  });

  it("exits 1 when the gateway is not running", async () => {
    setFixture({});
    await expect(runPreflightCli(["HEAD", "--namespace", "n"])).rejects.toThrow("process.exit(1)");
    expect(stderrChunks.join("")).toContain("Gateway is not running");
  });

  it("happy path: prints the Markdown brief, exit code stays 0 when nothing failed", async () => {
    preflightFixture({
      event: "preflight.briefReady",
      payload: {
        sessionId: "s",
        brief: "# Preflight\n\nall clear",
        findings: makeValidPreflightBrief(),
      },
    });
    await runPreflightCli(["HEAD", "--namespace", "n"]);
    expect(stdoutChunks.join("")).toContain("# Preflight");
    expect(process.exitCode).toBe(0);
  });

  it("sets exit code 1 when a downstream failed", async () => {
    preflightFixture({
      event: "preflight.briefReady",
      payload: {
        sessionId: "s",
        brief: "x",
        findings: makeValidPreflightBrief({ anyFailed: true }),
      },
    });
    await runPreflightCli(["HEAD", "--namespace", "n"]);
    expect(process.exitCode).toBe(1);
  });

  it("--strict sets exit code 1 on incomplete coverage", async () => {
    preflightFixture({
      event: "preflight.briefReady",
      payload: {
        sessionId: "s",
        brief: "x",
        findings: makeValidPreflightBrief({ anyIncomplete: true }),
      },
    });
    await runPreflightCli(["HEAD", "--namespace", "n", "--strict"]);
    expect(process.exitCode).toBe(1);
  });

  it("incomplete coverage WITHOUT --strict leaves exit code 0", async () => {
    preflightFixture({
      event: "preflight.briefReady",
      payload: {
        sessionId: "s",
        brief: "x",
        findings: makeValidPreflightBrief({ anyIncomplete: true }),
      },
    });
    await runPreflightCli(["HEAD", "--namespace", "n"]);
    expect(process.exitCode).toBe(0);
  });

  it("--json prints the structured findings", async () => {
    preflightFixture({
      event: "preflight.briefReady",
      payload: { sessionId: "s", brief: "# md", findings: makeValidPreflightBrief() },
    });
    await runPreflightCli(["HEAD", "--namespace", "n", "--json"]);
    const out = stdoutChunks.join("");
    expect(out).toContain('"kind": "preflight"');
    expect(out).not.toContain("# md");
  });

  it("forwards ref + namespace to the agents.preflight IPC call", async () => {
    let seen: unknown;
    preflightFixture({
      event: "preflight.briefReady",
      payload: { sessionId: "s", brief: "x", findings: makeValidPreflightBrief() },
      onParams: (p) => {
        seen = p;
      },
    });
    await runPreflightCli(["HEAD~1..HEAD", "--namespace", "project:zurich"]);
    expect(seen).toEqual({ ref: "HEAD~1..HEAD", namespace: "project:zurich" });
  });

  it("exits 2 when preflight.briefError fires", async () => {
    preflightFixture({
      event: "preflight.briefError",
      payload: { error: "downstream unreachable" },
    });
    await expect(runPreflightCli(["HEAD", "--namespace", "n"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("downstream unreachable");
  });

  it("exits 2 with a generic message when briefError payload is not an object", async () => {
    preflightFixture({ event: "preflight.briefError", payload: 42 });
    await expect(runPreflightCli(["HEAD", "--namespace", "n"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("Agent failed");
  });

  it("exits 2 when the briefReady payload is not an object", async () => {
    preflightFixture({ event: "preflight.briefReady", payload: 42 });
    await expect(runPreflightCli(["HEAD", "--namespace", "n"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("Malformed");
  });
});

describe("runPreflightCli — approve mode", () => {
  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    installStreamCapture();
  });
  afterEach(() => {
    clearFixture();
    restoreStreams();
  });

  it("exits 1 when the gateway is not running", async () => {
    setFixture({});
    await expect(runPreflightCli(["approve", "req-1"])).rejects.toThrow("process.exit(1)");
    expect(stderrChunks.join("")).toContain("Gateway is not running");
  });

  it("prints 'approved' when a pending request matches", async () => {
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) =>
          method === "federation.preflightRespond" ? { matched: true } : undefined,
        connect: async () => {},
        disconnect: async () => {},
      },
    });
    await runPreflightCli(["approve", "req-1"]);
    expect(stdoutChunks.join("")).toContain("approved");
  });

  it("prints the no-pending-request hint when nothing matched", async () => {
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) =>
          method === "federation.preflightRespond" ? { matched: false } : undefined,
        connect: async () => {},
        disconnect: async () => {},
      },
    });
    await runPreflightCli(["approve", "req-1"]);
    expect(stdoutChunks.join("")).toContain("no pending request");
  });
});
