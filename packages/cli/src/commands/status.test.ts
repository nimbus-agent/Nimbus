import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

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

  // ── embeddingBackfill edge cases ──────────────────────────────────────────

  it("does not print backfill when embeddingBackfill is null", async () => {
    const ipc = createMockIpcClient([{ version: "1.0", uptime: 0, embeddingBackfill: null }]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: false },
    );
    expect(out.stdout).not.toContain("Embedding backfill");
  });

  it("does not print backfill when embeddingBackfill.total === 0", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0, embeddingBackfill: { done: 0, total: 0 } },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: false },
    );
    expect(out.stdout).not.toContain("Embedding backfill");
  });

  // ── logPath edge cases ────────────────────────────────────────────────────

  it("does not print a Log line when state.logPath is an empty string", async () => {
    const ipc = createMockIpcClient([{ version: "1.0", uptime: 0 }]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s", logPath: "" },
      { wantDrift: false, verbose: false },
    );
    expect(out.stdout).not.toContain("Log:");
  });

  // ── catch branch: non-Error thrown ───────────────────────────────────────

  it("prints the IPC-failed message using String() when a non-Error is thrown", async () => {
    // Craft a client whose call() throws a plain string (not an Error instance)
    const throwingClient = {
      call: async (): Promise<never> => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "plain string error";
      },
      connect: async (): Promise<void> => {},
      disconnect: async (): Promise<void> => {},
      onNotification: (): void => {},
    };
    // Cast through unknown to satisfy the IPCClient type without any
    const ipcClient = throwingClient as unknown as Parameters<typeof runStatusImpl>[0];
    await runStatusImpl(
      ipcClient,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: false },
    );
    expect(out.stdout).toContain("Gateway: state exists but IPC failed");
    expect(out.stdout).toContain("plain string error");
  });

  // ── drift: wantDrift=true but drift field absent ──────────────────────────

  it("does not print drift hints when wantDrift is true but ping has no drift field", async () => {
    const ipc = createMockIpcClient([{ version: "1.0", uptime: 0 }]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: true, verbose: false },
    );
    expect(out.stdout).not.toContain("Drift hints");
  });

  it("does not print drift hints when drift.lines is not an array", async () => {
    const ipc = createMockIpcClient([{ version: "1.0", uptime: 0, drift: { lines: "not-array" } }]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: true, verbose: false },
    );
    expect(out.stdout).not.toContain("Drift hints");
  });

  // ── verbose + connector health edge cases ────────────────────────────────

  it("skips connector health section when connectorHealth is empty array", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      { connectorHealth: [], index: null },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: true },
    );
    expect(out.stdout).not.toContain("Connector health:");
  });

  it("skips connector health section when connectorHealth is not an array", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      { connectorHealth: "not-an-array", index: null },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: true },
    );
    expect(out.stdout).not.toContain("Connector health:");
  });

  it("skips a health row when formatConnectorHealthLine returns null for a non-object row", async () => {
    // Mix a valid row with an invalid one (null element); the null row must be skipped
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      {
        connectorHealth: [null, { connectorId: "ci", state: "healthy" }],
        index: null,
      },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: true },
    );
    expect(out.stdout).toContain("Connector health:");
    expect(out.stdout).toContain("ci: healthy");
  });

  it("uses '?' placeholders when connectorId / state are not strings", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      {
        connectorHealth: [{ connectorId: 42, state: null }],
        index: null,
      },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: true },
    );
    expect(out.stdout).toContain("?: ?");
  });

  it("appends retry_after and backoff_until when retryAfterMs and backoffUntilMs are finite numbers", async () => {
    // Use a fixed epoch offset so the ISO string is deterministic
    const retryAfterMs = 1_000_000_000_000; // a real timestamp (far future from epoch)
    const backoffUntilMs = 2_000_000_000_000;
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      {
        connectorHealth: [
          {
            connectorId: "svc",
            state: "backoff",
            retryAfterMs,
            backoffUntilMs,
            lastError: "timeout",
          },
        ],
        index: null,
      },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: true },
    );
    expect(out.stdout).toContain("retry_after=");
    expect(out.stdout).toContain("backoff_until=");
    expect(out.stdout).toContain("err=timeout");
  });

  it("omits retry_after and backoff_until when those fields are non-finite", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      {
        connectorHealth: [
          {
            connectorId: "svc",
            state: "err",
            retryAfterMs: Number.POSITIVE_INFINITY,
            backoffUntilMs: Number.NaN,
          },
        ],
        index: null,
      },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: true },
    );
    expect(out.stdout).not.toContain("retry_after=");
    expect(out.stdout).not.toContain("backoff_until=");
  });

  // ── verbose + index metrics edge cases ───────────────────────────────────

  it("skips index metrics when index is null", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      { connectorHealth: [], index: null },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: true },
    );
    expect(out.stdout).not.toContain("Index:");
  });

  it("skips index metrics when index is an array (not a plain object)", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      { connectorHealth: [], index: [1, 2, 3] },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: true },
    );
    expect(out.stdout).not.toContain("Index:");
  });

  it("skips index metrics when index is a primitive string", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      { connectorHealth: [], index: "bad" },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: true },
    );
    expect(out.stdout).not.toContain("Index:");
  });

  it("shows '—' placeholders when totalItems and queryLatencyP95Ms are non-finite", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      {
        connectorHealth: [],
        index: { totalItems: Number.NaN, queryLatencyP95Ms: Number.POSITIVE_INFINITY },
      },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: true },
    );
    expect(out.stdout).toContain("total items=—");
    expect(out.stdout).toContain("query p95=—");
  });

  it("shows '—' placeholders when totalItems and queryLatencyP95Ms are not numbers", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      {
        connectorHealth: [],
        index: { totalItems: "many", queryLatencyP95Ms: null },
      },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: true },
    );
    expect(out.stdout).toContain("total items=—");
    expect(out.stdout).toContain("query p95=—");
  });

  it("skips 'Items by service' section when itemCountByService is null", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      {
        connectorHealth: [],
        index: { totalItems: 3, queryLatencyP95Ms: 5, itemCountByService: null },
      },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: true },
    );
    expect(out.stdout).not.toContain("Items by service:");
  });

  it("skips 'Items by service' section when itemCountByService is an array", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      {
        connectorHealth: [],
        index: { totalItems: 3, queryLatencyP95Ms: 5, itemCountByService: ["a", "b"] },
      },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: true },
    );
    expect(out.stdout).not.toContain("Items by service:");
  });

  it("prints 'Items by service' when itemCountByService is a plain object", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      {
        connectorHealth: [],
        index: {
          totalItems: 20,
          queryLatencyP95Ms: 8,
          itemCountByService: { github: 10, gitlab: 10 },
        },
      },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: true },
    );
    expect(out.stdout).toContain("Items by service:");
    expect(out.stdout).toContain("github: 10");
    expect(out.stdout).toContain("gitlab: 10");
  });

  it("does not print agent limits when agentLimits is undefined", async () => {
    const ipc = createMockIpcClient([{ version: "1.0", uptime: 500 }]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: false },
    );
    expect(out.stdout).not.toContain("Agent limits:");
  });

  it("does not print agent limits when agentLimits is null", async () => {
    const ipc = createMockIpcClient([{ version: "1.0", uptime: 0, agentLimits: null }]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: false },
    );
    expect(out.stdout).not.toContain("Agent limits:");
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

  it("passes --drift flag through to the impl", async () => {
    const ipc = createMockIpcClient([
      { version: "2.0", uptime: 2000, drift: { lines: ["hint-a"] } },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 7 },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runStatus(["--drift"]);
    expect(ipc.calls[0]).toEqual({ method: "gateway.ping", params: { includeDrift: true } });
    expect(out.stdout).toContain("Drift hints");
    expect(out.stdout).toContain("hint-a");
  });

  it("passes --verbose flag through to the impl and calls diag.snapshot", async () => {
    const ipc = createMockIpcClient([
      { version: "2.0", uptime: 2000 },
      { connectorHealth: [{ connectorId: "slack", state: "healthy" }], index: null },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 7 },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runStatus(["--verbose"]);
    expect(ipc.calls).toHaveLength(2);
    expect(ipc.calls[1]?.method).toBe("diag.snapshot");
    expect(out.stdout).toContain("Connector health");
    expect(out.stdout).toContain("slack");
  });
});
