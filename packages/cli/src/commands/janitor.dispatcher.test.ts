import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import { runJanitorCli } from "./janitor.ts";

const {
  stdoutChunks,
  stderrChunks,
  install: installStreamCapture,
  restore: restoreStreams,
} = createStreamCapture({ captureExit: true });

afterAll(() => {
  restoreStreams();
});

function makeValidJanitorBrief(): unknown {
  return {
    kind: "janitor",
    agentVersion: 1,
    generatedAt: 1_700_000_000,
    latencyMs: 9,
    gaps: [],
    query: { resourceRef: "i-12345", idleDays: 14 },
    idle: true,
    proposalSuppressed: false,
    cleanupAction: null,
    peersClear: 2,
    peersTouched: [],
  };
}

/** A fixture whose `agents.janitor` call replays a notification, then completes. */
function janitorFixture(opts: {
  event: "janitor.briefReady" | "janitor.briefError";
  payload: unknown;
  onParams?: (p: unknown) => void;
}): void {
  const handlers = new Map<string, (params: unknown) => void>();
  setFixture({
    gatewayState: { socketPath: FAKE_SOCKET_PATH },
    ipcClient: {
      call: async (method: string, params: unknown) => {
        if (method === "agents.janitor") {
          opts.onParams?.(params);
          setTimeout(() => handlers.get(opts.event)?.(opts.payload), 0);
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

describe("runJanitorCli — dispatcher", () => {
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
    await expect(runJanitorCli(["i-12345"])).rejects.toThrow("process.exit(1)");
    expect(stderrChunks.join("")).toContain("Gateway is not running");
  });

  it("happy path: prints the Markdown brief on janitor.briefReady", async () => {
    janitorFixture({
      event: "janitor.briefReady",
      payload: { sessionId: "s", brief: "# Janitor\n\nidle", findings: makeValidJanitorBrief() },
    });
    await runJanitorCli(["i-12345"]);
    expect(stdoutChunks.join("")).toContain("# Janitor");
  });

  it("--json prints the structured findings (not the Markdown brief)", async () => {
    janitorFixture({
      event: "janitor.briefReady",
      payload: { sessionId: "s", brief: "# md", findings: makeValidJanitorBrief() },
    });
    await runJanitorCli(["i-12345", "--json"]);
    const out = stdoutChunks.join("");
    expect(out).toContain('"kind": "janitor"');
    expect(out).not.toContain("# md");
  });

  it("forwards --idle-days / --cleanup / --allow-gaps to the agents.janitor IPC call", async () => {
    let seen: unknown;
    janitorFixture({
      event: "janitor.briefReady",
      payload: { sessionId: "s", brief: "x", findings: makeValidJanitorBrief() },
      onParams: (p) => {
        seen = p;
      },
    });
    await runJanitorCli([
      "i-12345",
      "--idle-days",
      "30",
      "--cleanup",
      "cloud.instance.terminate",
      "--allow-gaps",
    ]);
    expect(seen).toEqual({
      resourceRef: "i-12345",
      idleDays: 30,
      allowGaps: true,
      cleanupAction: "cloud.instance.terminate",
    });
  });

  it("omits cleanupAction from the IPC params when --cleanup is absent", async () => {
    let seen: unknown;
    janitorFixture({
      event: "janitor.briefReady",
      payload: { sessionId: "s", brief: "x", findings: makeValidJanitorBrief() },
      onParams: (p) => {
        seen = p;
      },
    });
    await runJanitorCli(["i-12345"]);
    expect(seen).toEqual({ resourceRef: "i-12345", idleDays: 14, allowGaps: false });
  });

  it("exits 2 when janitor.briefError fires", async () => {
    janitorFixture({
      event: "janitor.briefError",
      payload: { error: "fan-out failed" },
    });
    await expect(runJanitorCli(["i-12345"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("fan-out failed");
  });

  it("exits 2 when the briefReady payload is malformed", async () => {
    janitorFixture({
      event: "janitor.briefReady",
      payload: { brief: 42, findings: {} },
    });
    await expect(runJanitorCli(["i-12345"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("Malformed");
  });
});
