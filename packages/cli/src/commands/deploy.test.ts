import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";

import "../../test/helpers/cli-mocks.ts";
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const deployMod = await import("./deploy.ts");
const { parseDeployPreflightArgs, runDeployCli } = deployMod;

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
});

const stdoutChunks: string[] = [];
const stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
const origExit = process.exit.bind(process);

function installStreamCapture(): void {
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number): never => {
    throw new Error(`process.exit(${code ?? ""})`);
  }) as typeof process.exit;
}

function restoreStreams(): void {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  process.exit = origExit;
}

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
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
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
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
    await runDeployCli(["preflight", "--service", "svc", "--target-ref", "main", "--json"]);
    const out = stdoutChunks.join("");
    expect(out).toContain('"verdict": "warn"');
    expect(out).toContain('"service": "svc"');
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
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
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
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
    await runDeployCli(["preflight", "--service", "svc", "--target-ref", "main", "--mode", "off"]);
    expect(stdoutChunks.join("")).toContain("[warn]");
  });

  it("exits 2 on malformed envelope", async () => {
    const mock = createMockIpcClient([{ not: "an envelope" }]);
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
    await expect(
      runDeployCli(["preflight", "--service", "svc", "--target-ref", "main"]),
    ).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("malformed envelope");
  });

  it("exits 2 on IPC error", async () => {
    const mock = createMockIpcClient([new Error("ipc broke")]);
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
    await expect(
      runDeployCli(["preflight", "--service", "svc", "--target-ref", "main"]),
    ).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("ipc broke");
  });

  it("routes 'annotate' sub-arg through runDeployAnnotate (exit 2 on missing --service)", async () => {
    await expect(runDeployCli(["annotate"])).rejects.toThrow("process.exit(2)");
  });
});
