import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";

const deployMod = await import("./deploy.ts");
const { formatGapTag, formatVerdictTag, parseDeployPreflightArgs, runDeployCli, shouldUseColor } =
  deployMod;

describe("nimbus deploy preflight arg parser", () => {
  test("parses service + target-ref + json", () => {
    const out = parseDeployPreflightArgs([
      "--service",
      "payment-service",
      "--target-ref",
      "main",
      "--json",
    ]);
    expect(out.service).toBe("payment-service");
    expect(out.targetRef).toBe("main");
    expect(out.json).toBe(true);
    expect(out.mode).toBe("warn");
  });

  test("defaults mode to 'warn' and json to false", () => {
    const out = parseDeployPreflightArgs(["--service", "x", "--target-ref", "main"]);
    expect(out.mode).toBe("warn");
    expect(out.json).toBe(false);
  });

  test("accepts --mode block", () => {
    const out = parseDeployPreflightArgs([
      "--service",
      "x",
      "--target-ref",
      "main",
      "--mode",
      "block",
    ]);
    expect(out.mode).toBe("block");
  });

  test("accepts --mode off", () => {
    const out = parseDeployPreflightArgs([
      "--service",
      "x",
      "--target-ref",
      "main",
      "--mode",
      "off",
    ]);
    expect(out.mode).toBe("off");
  });

  test("rejects unknown --mode value", () => {
    expect(() =>
      parseDeployPreflightArgs(["--service", "x", "--target-ref", "main", "--mode", "explode"]),
    ).toThrow(/--mode/);
  });

  test("throws on missing --service", () => {
    expect(() => parseDeployPreflightArgs(["--target-ref", "main"])).toThrow(/--service/);
  });

  test("throws on missing --target-ref", () => {
    expect(() => parseDeployPreflightArgs(["--service", "x"])).toThrow(/--target-ref/);
  });

  test("throws on missing value for --service", () => {
    expect(() => parseDeployPreflightArgs(["--service"])).toThrow(/--service/);
  });

  test("throws on missing value for --target-ref", () => {
    expect(() => parseDeployPreflightArgs(["--service", "x", "--target-ref"])).toThrow(
      /--target-ref/,
    );
  });

  test("throws on missing value for --mode (undefined arg)", () => {
    expect(() =>
      parseDeployPreflightArgs(["--service", "x", "--target-ref", "main", "--mode"]),
    ).toThrow(/--mode/);
  });

  test("throws on whitespace-only --service value", () => {
    expect(() => parseDeployPreflightArgs(["--service", "   ", "--target-ref", "main"])).toThrow(
      /--service/,
    );
  });

  test("throws on whitespace-only --target-ref value", () => {
    expect(() => parseDeployPreflightArgs(["--service", "x", "--target-ref", "   "])).toThrow(
      /--target-ref/,
    );
  });
});

const {
  stdoutChunks,
  stderrChunks,
  install: installStreamCapture,
  restore: restoreStreams,
} = createStreamCapture({ captureExit: true });

afterAll(() => {
  restoreStreams();
});

describe("runDeployCli — dispatcher", () => {
  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    installStreamCapture();
  });
  afterEach(() => {
    clearFixture();
    restoreStreams();
  });

  it("prints usage and exits 1 when subcommand is unknown", async () => {
    await expect(runDeployCli(["unknown-sub"])).rejects.toThrow("process.exit(1)");
    expect(stderrChunks.join("")).toContain("Usage: nimbus deploy");
  });

  it("prints arg-parse error and exits 1 when --service missing", async () => {
    await expect(runDeployCli(["preflight", "--target-ref", "main"])).rejects.toThrow(
      "process.exit(1)",
    );
    expect(stderrChunks.join("")).toContain("--service");
  });

  it("exits 2 with 'Gateway is not running' when state is undefined", async () => {
    setFixture({});
    await expect(
      runDeployCli(["preflight", "--service", "svc", "--target-ref", "main"]),
    ).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("Gateway is not running");
  });

  it("renders pretty output for verdict=ok and returns 0", async () => {
    const envelope = {
      service: "svc",
      target_ref: "main",
      verdict: "ok" as const,
      computed_at: "2026-05-22T00:00:00Z",
      checks: {
        active_p1_incidents: { count: 0, findings: [], gap: null },
        failing_ci_runs: { count: 0, findings: [], gap: null },
        merge_conflicts: { count: 0, findings: [], gap: null },
      },
    };
    const mock = createMockIpcClient([envelope]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runDeployCli(["preflight", "--service", "svc", "--target-ref", "main"]);
    expect(stdoutChunks.join("")).toContain("Deploy preflight");
    expect(stdoutChunks.join("")).toContain("[ok]");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.method).toBe("deploy.preflight");
  });

  it("emits JSON envelope when --json is passed", async () => {
    const envelope = {
      service: "svc",
      target_ref: "main",
      verdict: "warn" as const,
      computed_at: "2026-05-22T00:00:00Z",
      checks: {
        active_p1_incidents: {
          count: 1,
          findings: [{ id: "i1", title: "p1 fire", url: "https://pd/incident/i1" }],
          gap: null,
        },
        failing_ci_runs: { count: 0, findings: [], gap: "no_data" },
        merge_conflicts: { count: 0, findings: [], gap: null },
      },
    };
    const mock = createMockIpcClient([envelope]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runDeployCli(["preflight", "--service", "svc", "--target-ref", "main", "--json"]);
    const out = stdoutChunks.join("");
    expect(out).toContain('"verdict": "warn"');
    expect(out).toContain('"service": "svc"');
  });

  // F24a, end to end: the exact shape the gateway now returns for a service that is not in
  // nimbus.toml — verdict `warn`, zero counts, `unknown_service` on all three checks — must
  // BLOCK. Before the fix this envelope carried `verdict: "ok"` and the gate exited 0, so a
  // typo'd or renamed service id let a deploy through silently. This is the assertion that
  // fails if the fail-open is ever reintroduced at either end.
  it("blocks on an unknown service: --mode block exits non-zero on an unknown_service warn", async () => {
    const envelope = {
      service: "totally-made-up",
      target_ref: "main",
      verdict: "warn" as const,
      computed_at: "2026-05-22T00:00:00Z",
      checks: {
        active_p1_incidents: { count: 0, findings: [], gap: "unknown_service" },
        failing_ci_runs: { count: 0, findings: [], gap: "unknown_service" },
        merge_conflicts: { count: 0, findings: [], gap: "unknown_service" },
      },
    };
    const mock = createMockIpcClient([envelope]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await expect(
      runDeployCli([
        "preflight",
        "--service",
        "totally-made-up",
        "--target-ref",
        "main",
        "--mode",
        "block",
      ]),
    ).rejects.toThrow(/process\.exit/);
    const out = stdoutChunks.join("");
    expect(out).toContain("[warn]");
    expect(out).toContain("unknown_service");
  });

  it("triggers the block-exit branch when --mode block AND verdict warn", async () => {
    const envelope = {
      service: "svc",
      target_ref: "main",
      verdict: "warn" as const,
      computed_at: "2026-05-22T00:00:00Z",
      checks: {
        active_p1_incidents: { count: 1, findings: [], gap: null },
        failing_ci_runs: { count: 0, findings: [], gap: null },
        merge_conflicts: { count: 0, findings: [], gap: null },
      },
    };
    const mock = createMockIpcClient([envelope]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await expect(
      runDeployCli(["preflight", "--service", "svc", "--target-ref", "main", "--mode", "block"]),
    ).rejects.toThrow(/process\.exit/);
    expect(stdoutChunks.join("")).toContain("[warn]");
  });

  it("does NOT exit when --mode off AND verdict warn", async () => {
    const envelope = {
      service: "svc",
      target_ref: "main",
      verdict: "warn" as const,
      computed_at: "2026-05-22T00:00:00Z",
      checks: {
        active_p1_incidents: { count: 1, findings: [], gap: null },
        failing_ci_runs: { count: 0, findings: [], gap: null },
        merge_conflicts: { count: 0, findings: [], gap: null },
      },
    };
    const mock = createMockIpcClient([envelope]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runDeployCli(["preflight", "--service", "svc", "--target-ref", "main", "--mode", "off"]);
    expect(stdoutChunks.join("")).toContain("[warn]");
  });

  it("exits 2 on malformed envelope", async () => {
    const mock = createMockIpcClient([{ not: "an envelope" }]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await expect(
      runDeployCli(["preflight", "--service", "svc", "--target-ref", "main"]),
    ).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("malformed envelope");
  });

  it("exits 2 on IPC error", async () => {
    const mock = createMockIpcClient([new Error("ipc broke")]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await expect(
      runDeployCli(["preflight", "--service", "svc", "--target-ref", "main"]),
    ).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("ipc broke");
  });

  it("routes 'annotate' sub-arg through runDeployAnnotate (exit 2 on missing --service)", async () => {
    await expect(runDeployCli(["annotate"])).rejects.toThrow("process.exit(2)");
  });

  it("renders pretty output with findings that have URLs (covers urlPart non-empty branch)", async () => {
    const envelope = {
      service: "svc",
      target_ref: "main",
      verdict: "warn" as const,
      computed_at: new Date().toISOString(),
      checks: {
        active_p1_incidents: {
          count: 2,
          findings: [
            { id: "f1", title: "P1 outage", url: "https://pagerduty.example.com/incident/1" },
            { id: "f2", title: "Silent failure", url: null },
          ],
          gap: null,
        },
        failing_ci_runs: { count: 0, findings: [], gap: "no_data" },
        merge_conflicts: { count: 0, findings: [], gap: null },
      },
    };
    const mock = createMockIpcClient([envelope]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runDeployCli(["preflight", "--service", "svc", "--target-ref", "main"]);
    const out = stdoutChunks.join("");
    expect(out).toContain("P1 outage");
    expect(out).toContain("https://pagerduty.example.com/incident/1");
    expect(out).toContain("Silent failure");
    expect(out).toContain("[warn]");
  });

  it("renders pretty output with a non-null gap tag (covers formatGapTag non-null branch)", async () => {
    const envelope = {
      service: "svc",
      target_ref: "main",
      verdict: "ok" as const,
      computed_at: new Date().toISOString(),
      checks: {
        active_p1_incidents: { count: 0, findings: [], gap: "no_data" },
        failing_ci_runs: { count: 0, findings: [], gap: "stale" },
        merge_conflicts: { count: 0, findings: [], gap: null },
      },
    };
    const mock = createMockIpcClient([envelope]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runDeployCli(["preflight", "--service", "svc", "--target-ref", "main"]);
    const out = stdoutChunks.join("");
    expect(out).toContain("[no_data]");
    expect(out).toContain("[stale]");
    expect(out).toContain("[ok]");
  });

  it("renders pretty output when a known check key is missing from checks (m === undefined continue)", async () => {
    const envelope = {
      service: "svc",
      target_ref: "main",
      verdict: "ok" as const,
      computed_at: new Date().toISOString(),
      checks: {
        // only two of three known keys present — merge_conflicts absent
        active_p1_incidents: { count: 0, findings: [], gap: null },
        failing_ci_runs: { count: 0, findings: [], gap: null },
      },
    };
    const mock = createMockIpcClient([envelope]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runDeployCli(["preflight", "--service", "svc", "--target-ref", "main"]);
    const out = stdoutChunks.join("");
    expect(out).toContain("Deploy preflight");
    expect(out).toContain("[ok]");
  });

  it("exits 2 on null envelope response (isEnvelope null guard)", async () => {
    const mock = createMockIpcClient([null]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await expect(
      runDeployCli(["preflight", "--service", "svc", "--target-ref", "main"]),
    ).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("malformed envelope");
  });

  it("exits 2 on string envelope response (isEnvelope typeof guard)", async () => {
    const mock = createMockIpcClient(["unexpected"]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await expect(
      runDeployCli(["preflight", "--service", "svc", "--target-ref", "main"]),
    ).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("malformed envelope");
  });

  it("exits 2 on envelope with checks=null (isEnvelope checks-null guard)", async () => {
    const mock = createMockIpcClient([
      { service: "svc", target_ref: "main", verdict: "ok", checks: null },
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await expect(
      runDeployCli(["preflight", "--service", "svc", "--target-ref", "main"]),
    ).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("malformed envelope");
  });

  // Color branches are tested as PURE functions — no global process.stdout.isTTY /
  // process.env.NO_COLOR mutation (that leaks across files in the combined run).
  it("shouldUseColor / formatVerdictTag / formatGapTag cover the color branches (pure)", () => {
    // shouldUseColor: a non-empty NO_COLOR suppresses; otherwise follow isTTY.
    expect(shouldUseColor("1", true)).toBe(false);
    expect(shouldUseColor("anything", false)).toBe(false);
    expect(shouldUseColor(undefined, true)).toBe(true);
    expect(shouldUseColor("", true)).toBe(true); // empty NO_COLOR is ignored
    expect(shouldUseColor(undefined, false)).toBe(false);
    expect(shouldUseColor(undefined, undefined)).toBe(false);

    // formatVerdictTag: colored vs plain for each verdict.
    expect(formatVerdictTag("ok", true)).toBe("\x1b[32m[ok]\x1b[0m");
    expect(formatVerdictTag("ok", false)).toBe("[ok]");
    expect(formatVerdictTag("warn", true)).toBe("\x1b[33m[warn]\x1b[0m");
    expect(formatVerdictTag("warn", false)).toBe("[warn]");

    // formatGapTag: null → empty; colored vs plain otherwise.
    expect(formatGapTag(null, true)).toBe("");
    expect(formatGapTag(null, false)).toBe("");
    expect(formatGapTag("stale", true)).toBe("\x1b[2m[stale]\x1b[0m");
    expect(formatGapTag("stale", false)).toBe("[stale]");
  });
});
