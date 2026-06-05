import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../test/helpers/cli-mocks.ts";
import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const statusMod = await import("./status.ts");
const { runStatus, runStatusImpl } = statusMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("runStatusImpl", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("prints the basic gateway summary on success", async () => {
    const ipc = createMockIpcClient([{ version: "1.2.3", uptime: 60_000 }]);
    await runStatusImpl(
      ipc.client,
      { pid: 12345, socketPath: FAKE_SOCKET_PATH },
      { wantDrift: false, verbose: false },
    );
    expect(ipc.calls[0]).toEqual({ method: "gateway.ping", params: {} });
    expect(out.stdout).toContain("Gateway: running (pid 12345)");
    expect(out.stdout).toContain("Version: 1.2.3");
    expect(out.stdout).toContain("Uptime:  60s");
    expect(out.stdout).toContain(`Socket:  ${FAKE_SOCKET_PATH}`);
  });

  it("prints agent limits when present", async () => {
    const ipc = createMockIpcClient([
      {
        version: "1.0",
        uptime: 1000,
        agentLimits: { maxAgentDepth: 3, maxToolCallsPerSession: 20 },
      },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: false },
    );
    expect(out.stdout).toContain("Agent limits: depth=3");
    expect(out.stdout).toContain("tool-calls/session=20");
  });

  it("prints embedding backfill progress when total > 0", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0, embeddingBackfill: { done: 10, total: 100 } },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: false },
    );
    expect(out.stdout).toContain("Embedding backfill: 10 / 100");
  });

  it("passes includeDrift:true when wantDrift is set and prints drift hints", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0, drift: { lines: ["repo-a: 1 file extra"] } },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: true, verbose: false },
    );
    expect(ipc.calls[0]).toEqual({
      method: "gateway.ping",
      params: { includeDrift: true },
    });
    expect(out.stdout).toContain("Drift hints");
    expect(out.stdout).toContain("repo-a: 1 file extra");
  });

  it("issues a diag.snapshot call when verbose is set and prints health rows", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      {
        connectorHealth: [{ connectorId: "github", state: "healthy" }],
        index: { totalItems: 5, queryLatencyP95Ms: 12 },
      },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: true },
    );
    expect(ipc.calls).toHaveLength(2);
    expect(ipc.calls[1]).toEqual({ method: "diag.snapshot", params: {} });
    expect(out.stdout).toContain("Connector health");
    expect(out.stdout).toContain("github");
    expect(out.stdout).toContain("Index: total items=5");
  });

  it("prints a log line when state.logPath is non-empty", async () => {
    const ipc = createMockIpcClient([{ version: "1.0", uptime: 0 }]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s", logPath: "/var/log/nimbus.log" },
      { wantDrift: false, verbose: false },
    );
    expect(out.stdout).toContain("Log:     /var/log/nimbus.log");
  });

  it("prints the IPC-failed message when call() throws", async () => {
    const ipc = createMockIpcClient([new Error("ECONNREFUSED")]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: false },
    );
    expect(out.stdout).toContain("Gateway: state exists but IPC failed");
    expect(out.stdout).toContain("ECONNREFUSED");
  });
});

describe("runStatus (dispatcher)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("prints '(no state file)' when no gateway is running", async () => {
    setFixture({});
    await runStatus([]);
    expect(out.stdout).toContain("Gateway: not running (no state file)");
  });

  it("routes through the IPC client when gateway is running", async () => {
    const ipc = createMockIpcClient([{ version: "9.9", uptime: 1000 }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 42 },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runStatus([]);
    expect(ipc.calls[0]?.method).toBe("gateway.ping");
    expect(out.stdout).toContain("Version: 9.9");
  });
});
