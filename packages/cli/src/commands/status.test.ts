import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import type { StatusJson } from "./status.ts";

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

  // WITHOUT --verbose. The line's purpose is to let a user tell "still draining" from "broken",
  // which is useless if they must already suspect a problem to pass a flag; the design spec § 7
  // puts it alongside `Embedding backfill:`, which is unconditional.
  it("prints PR file coverage on the DEFAULT status, without --verbose", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      {
        connectorHealth: [],
        index: { totalItems: 5, prFileCoverage: { covered: 412, totalPrs: 1203, truncated: 18 } },
      },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: false },
    );
    expect(ipc.calls[1]).toEqual({ method: "diag.snapshot", params: {} });
    expect(out.stdout).toContain("PR file coverage: 412 / 1203 (18 truncated)");
    // Verbose-only sections stay verbose-only.
    expect(out.stdout).not.toContain("Items by service:");
  });

  it("prints PR file coverage exactly once under --verbose", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      {
        connectorHealth: [],
        index: {
          totalItems: 5,
          itemCountByService: { github: 5 },
          prFileCoverage: { covered: 1, totalPrs: 2, truncated: 0 },
        },
      },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: true },
    );
    expect(out.stdout.split("PR file coverage:")).toHaveLength(2);
    expect(out.stdout).toContain("PR file coverage: 1 / 2");
    expect(out.stdout).toContain("Items by service:");
  });

  // The payload crosses an IPC seam, so its shape is external data. `typeof x === "number"` alone
  // admits NaN, Infinity, negatives and non-integers, each of which reaches the user as a
  // confident-looking nonsense ratio. Rejecting the payload prints NOTHING — the same outcome as a
  // missing snapshot, which the user can already read as "not measured".
  const MALFORMED_COVERAGE: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["covered is NaN", { covered: Number.NaN, totalPrs: 10, truncated: 0 }],
    ["totalPrs is Infinity", { covered: 1, totalPrs: Number.POSITIVE_INFINITY, truncated: 0 }],
    ["covered is negative", { covered: -1, totalPrs: 10, truncated: 0 }],
    ["totalPrs is negative", { covered: 0, totalPrs: -5, truncated: 0 }],
    ["covered is fractional", { covered: 2.5, totalPrs: 10, truncated: 0 }],
    ["truncated is NaN", { covered: 5, totalPrs: 10, truncated: Number.NaN }],
    ["truncated is negative", { covered: 5, totalPrs: 10, truncated: -3 }],
    // Internally inconsistent rather than malformed: every count is a fine integer on its own,
    // but no real index state produces them. `covered` counts a subset of `totalPrs`, and
    // `truncated` counts a subset of `covered`.
    ["covered exceeds totalPrs", { covered: 11, totalPrs: 10, truncated: 0 }],
    ["truncated exceeds covered", { covered: 3, totalPrs: 10, truncated: 4 }],
  ];

  for (const [label, prFileCoverage] of MALFORMED_COVERAGE) {
    it(`omits the PR file coverage line when ${label}`, async () => {
      const ipc = createMockIpcClient([
        { version: "1.0", uptime: 0 },
        { connectorHealth: [], index: { totalItems: 5, prFileCoverage } },
      ]);
      await runStatusImpl(
        ipc.client,
        { pid: 1, socketPath: "/s" },
        { wantDrift: false, verbose: false },
      );
      expect(out.stdout).not.toContain("PR file coverage");
    });
  }

  // The complement of the table above: a payload that omits `truncated` entirely is still VALID —
  // it reads as zero. Without this, tightening the guard could silently start suppressing the line
  // for every well-formed payload and the tests above would all still pass.
  it("prints the coverage line when truncated is absent, with no suffix", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      {
        connectorHealth: [],
        index: { totalItems: 5, prFileCoverage: { covered: 7, totalPrs: 9 } },
      },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: false },
    );
    expect(out.stdout).toContain("PR file coverage: 7 / 9");
    expect(out.stdout).not.toContain("truncated)");
  });

  it("omits the PR file coverage line entirely when there are no PRs", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      {
        connectorHealth: [],
        index: { totalItems: 5, prFileCoverage: { covered: 0, totalPrs: 0, truncated: 0 } },
      },
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: "/s" },
      { wantDrift: false, verbose: false },
    );
    expect(out.stdout).not.toContain("PR file coverage");
  });

  // The default status now makes a second call that a gateway without a local index answers with
  // an error ("Local index is not available"). That must cost the coverage line only, never the
  // rest of the output.
  it("a failing diag.snapshot on the default status costs only the coverage line", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      new Error("Local index is not available"),
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: FAKE_SOCKET_PATH },
      { wantDrift: false, verbose: false },
    );
    expect(out.stdout).toContain("Gateway: running (pid 1)");
    expect(out.stdout).toContain(`Socket:  ${FAKE_SOCKET_PATH}`);
    expect(out.stdout).not.toContain("IPC failed");
    expect(out.stdout).not.toContain("PR file coverage");
  });

  // …but --verbose output is entirely snapshot-derived, so there the failure still surfaces.
  it("a failing diag.snapshot under --verbose still reports the IPC failure", async () => {
    const ipc = createMockIpcClient([
      { version: "1.0", uptime: 0 },
      new Error("Local index is not available"),
    ]);
    await runStatusImpl(
      ipc.client,
      { pid: 1, socketPath: FAKE_SOCKET_PATH },
      { wantDrift: false, verbose: true },
    );
    expect(out.stdout).toContain("state exists but IPC failed — Local index is not available");
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

describe("nimbus status --json", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  /** Parses the whole of stdout — proves nothing but the JSON document was written there. */
  function parseStdout(): StatusJson {
    return JSON.parse(out.stdout) as StatusJson;
  }

  it("emits a parseable status document and nothing else on stdout", async () => {
    const ipc = createMockIpcClient([
      {
        version: "9.9",
        uptime: 61_000,
        agentLimits: { maxAgentDepth: 3, maxToolCallsPerSession: 20 },
        embeddingBackfill: { done: 10, total: 100 },
      },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 42 },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runStatus(["--json"]);

    const doc = parseStdout();
    expect(doc.running).toBe(true);
    expect(doc.pid).toBe(42);
    expect(doc.socketPath).toBe(FAKE_SOCKET_PATH);
    expect(doc.version).toBe("9.9");
    expect(doc.uptimeMs).toBe(61_000);
    expect(doc.agentLimits).toEqual({ maxAgentDepth: 3, maxToolCallsPerSession: 20 });
    expect(doc.embeddingBackfill).toEqual({ done: 10, total: 100 });
    expect(doc.error).toBeNull();
    // No human decoration leaked onto stdout.
    expect(out.stdout).not.toContain("Gateway: running");
    expect(out.stdout).not.toContain("Uptime:");
  });

  it("reports running:false with every key still present when no state file exists", async () => {
    setFixture({});
    await runStatus(["--json"]);

    const doc = parseStdout();
    expect(doc.running).toBe(false);
    expect(doc.pid).toBeNull();
    expect(doc.socketPath).toBeNull();
    expect(doc.version).toBeNull();
    expect(doc.uptimeMs).toBeNull();
    expect(doc.error).toBeNull();
    expect(Object.keys(doc).sort()).toEqual([
      "agentLimits",
      "connectorHealth",
      "drift",
      "embeddingBackfill",
      "error",
      "index",
      "logPath",
      "pid",
      "running",
      "socketPath",
      "uptimeMs",
      "version",
    ]);
    expect(out.stdout).not.toContain("not running (no state file)");
  });

  it("reports running:false and the IPC message in `error` when the socket connects but the ping fails", async () => {
    const ipc = createMockIpcClient([new Error("socket closed")]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 7 },
      // connect() RESOLVES — this is the wedged-but-listening gateway, the only
      // shape that populates `error`. See the stale-state-file tests below for
      // the case where connect() itself rejects.
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runStatus(["--json"]);

    const doc = parseStdout();
    expect(doc.running).toBe(false);
    expect(doc.pid).toBe(7);
    expect(doc.error).toBe("socket closed");
  });

  // ── stale state file: connect() itself rejects ────────────────────────────
  //
  // A state file left behind by a dead gateway points at a socket nothing is
  // listening on. `runStatus` connects BEFORE it builds any document and the
  // connect is outside `runStatusImpl`'s try/catch, so the rejection escapes the
  // command entirely — `index.ts`'s top-level handler prints it to stderr and
  // sets exit 1. There is no `running: false` document for this case, and these
  // two tests exist to keep the docs from claiming otherwise again.

  it("emits NO json at all and rejects when the state file is stale (connect fails)", async () => {
    const connectError = new Error("connect ENOENT \\\\.\\pipe\\nimbus-gateway");
    let called = false;
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 7 },
      ipcClient: {
        call: async (): Promise<never> => {
          called = true;
          throw new Error("unreachable: call() must never run after a failed connect");
        },
        connect: () => {
          throw connectError;
        },
        disconnect: () => {},
      },
    });

    await expect(runStatus(["--json"])).rejects.toThrow("connect ENOENT");
    expect(called).toBe(false);
    // Nothing on stdout — not a document, not a fragment, not a newline.
    expect(out.stdout).toBe("");
  });

  it("fails identically without --json when the state file is stale", async () => {
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 7 },
      ipcClient: {
        call: async (): Promise<never> => {
          throw new Error("unreachable");
        },
        connect: () => {
          throw new Error("connect ECONNREFUSED");
        },
        disconnect: () => {},
      },
    });

    await expect(runStatus([])).rejects.toThrow("connect ECONNREFUSED");
    expect(out.stdout).toBe("");
    // The human "state exists but IPC failed" line belongs to the ping-failure
    // case, NOT to a stale state file — it is not printed here.
    expect(out.stdout).not.toContain("state exists but IPC failed");
  });

  it("includes drift lines under --drift --json", async () => {
    const ipc = createMockIpcClient([
      { version: "2.0", uptime: 2000, drift: { lines: ["hint-a", "hint-b"] } },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 7 },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runStatus(["--drift", "--json"]);

    expect(ipc.calls[0]).toEqual({ method: "gateway.ping", params: { includeDrift: true } });
    expect(parseStdout().drift).toEqual({ lines: ["hint-a", "hint-b"] });
  });

  it("includes the diag snapshot under --verbose --json", async () => {
    const ipc = createMockIpcClient([
      { version: "2.0", uptime: 2000 },
      {
        connectorHealth: [{ connectorId: "slack", state: "healthy" }],
        index: { totalItems: 20, queryLatencyP95Ms: 8 },
      },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 7 },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runStatus(["--verbose", "--json"]);

    expect(ipc.calls[1]?.method).toBe("diag.snapshot");
    const doc = parseStdout();
    expect(doc.index).toEqual({ totalItems: 20, queryLatencyP95Ms: 8 });
    expect(doc.connectorHealth).toEqual([{ connectorId: "slack", state: "healthy" }]);
  });

  it("leaves the human rendering untouched without --json", async () => {
    const ipc = createMockIpcClient([{ version: "9.9", uptime: 1000 }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 42 },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runStatus([]);
    expect(out.stdout).toContain("Gateway: running (pid 42)");
    expect(() => JSON.parse(out.stdout)).toThrow();
  });
});
