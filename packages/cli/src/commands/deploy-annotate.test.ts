import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";

import "../../test/helpers/cli-mocks.ts";
import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const mod = await import("./deploy-annotate.ts");
const { ArgParseError, parseDeployAnnotateArgs, runDeployAnnotate } = mod;

const REQUIRED = [
  "--service",
  "payment-service",
  "--sha",
  "abc1234",
  "--target-ref",
  "refs/heads/main",
  "--env",
  "prod",
  "--status",
  "success",
  "--started-at",
  "1747142400000",
];

describe("parseDeployAnnotateArgs", () => {
  test("parses the minimal required flag set with defaults", () => {
    const parsed = parseDeployAnnotateArgs(REQUIRED);
    expect(parsed.service).toBe("payment-service");
    expect(parsed.sha).toBe("abc1234");
    expect(parsed.targetRef).toBe("refs/heads/main");
    expect(parsed.env).toBe("prod");
    expect(parsed.status).toBe("success");
    expect(parsed.startedAtMs).toBe(1747142400000);
    expect(parsed.provider).toBe("other");
    expect(parsed.json).toBe(false);
    expect(parsed.finishedAtMs).toBeUndefined();
    expect(parsed.workflowUrl).toBeUndefined();
    expect(parsed.runId).toBeUndefined();
    expect(parsed.jobId).toBeUndefined();
  });

  test("parses all optional flags including --json", () => {
    const parsed = parseDeployAnnotateArgs([
      ...REQUIRED,
      "--finished-at",
      "1747142500000",
      "--workflow-url",
      "https://github.com/o/r/actions/runs/1",
      "--provider",
      "github-actions",
      "--run-id",
      "run-42",
      "--job-id",
      "job-7",
      "--json",
    ]);
    expect(parsed.finishedAtMs).toBe(1747142500000);
    expect(parsed.workflowUrl).toBe("https://github.com/o/r/actions/runs/1");
    expect(parsed.provider).toBe("github-actions");
    expect(parsed.runId).toBe("run-42");
    expect(parsed.jobId).toBe("job-7");
    expect(parsed.json).toBe(true);
  });

  function omitFlag(flag: string): string[] {
    const idx = REQUIRED.indexOf(flag);
    if (idx === -1) return [...REQUIRED];
    return [...REQUIRED.slice(0, idx), ...REQUIRED.slice(idx + 2)];
  }

  test("rejects missing --sha with a clear error", () => {
    const args = omitFlag("--sha");
    expect(() => parseDeployAnnotateArgs(args)).toThrow(ArgParseError);
    expect(() => parseDeployAnnotateArgs(args)).toThrow(/--sha is required/);
  });

  test("rejects missing --target-ref with a clear error", () => {
    const args = omitFlag("--target-ref");
    expect(() => parseDeployAnnotateArgs(args)).toThrow(/--target-ref is required/);
  });

  test("rejects unknown --status value", () => {
    const args = [...REQUIRED];
    args[args.indexOf("--status") + 1] = "bogus";
    expect(() => parseDeployAnnotateArgs(args)).toThrow(/--status must be/);
  });

  test("rejects unknown --provider value", () => {
    expect(() => parseDeployAnnotateArgs([...REQUIRED, "--provider", "weirdci"])).toThrow(
      /--provider must be/,
    );
  });

  test("rejects malformed --sha (not lowercase hex / too short)", () => {
    const args = [...REQUIRED];
    args[args.indexOf("--sha") + 1] = "XYZ";
    expect(() => parseDeployAnnotateArgs(args)).toThrow(/--sha must be/);
  });

  test("rejects malformed --service (uppercase)", () => {
    const args = [...REQUIRED];
    args[args.indexOf("--service") + 1] = "Payment-Service";
    expect(() => parseDeployAnnotateArgs(args)).toThrow(/--service must be/);
  });

  test("rejects non-integer --started-at", () => {
    const args = [...REQUIRED];
    args[args.indexOf("--started-at") + 1] = "not-a-number";
    expect(() => parseDeployAnnotateArgs(args)).toThrow(/--started-at must be an integer/);
  });

  test("rejects unknown flag (--bogus)", () => {
    expect(() => parseDeployAnnotateArgs([...REQUIRED, "--bogus"])).toThrow(/unknown flag/);
  });

  test("rejects missing --env", () => {
    const idx = REQUIRED.indexOf("--env");
    const args = [...REQUIRED.slice(0, idx), ...REQUIRED.slice(idx + 2)];
    expect(() => parseDeployAnnotateArgs(args)).toThrow(/--env is required/);
  });

  test("rejects missing --status", () => {
    const idx = REQUIRED.indexOf("--status");
    const args = [...REQUIRED.slice(0, idx), ...REQUIRED.slice(idx + 2)];
    expect(() => parseDeployAnnotateArgs(args)).toThrow(/--status is required/);
  });

  test("rejects missing --started-at", () => {
    const idx = REQUIRED.indexOf("--started-at");
    const args = [...REQUIRED.slice(0, idx), ...REQUIRED.slice(idx + 2)];
    expect(() => parseDeployAnnotateArgs(args)).toThrow(/--started-at is required/);
  });

  test("rejects malformed --env (uppercase)", () => {
    const args = [...REQUIRED];
    args[args.indexOf("--env") + 1] = "PROD";
    expect(() => parseDeployAnnotateArgs(args)).toThrow(/--env must be/);
  });
});

const stdoutChunks: string[] = [];
const stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

function installStreamCapture(): void {
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
}

function restoreStreams(): void {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
}

afterAll(() => {
  restoreStreams();
});

const VALID_ARGV = [
  "--service",
  "payment-service",
  "--sha",
  "abc1234",
  "--target-ref",
  "refs/heads/main",
  "--env",
  "prod",
  "--status",
  "success",
  "--started-at",
  "1747142400000",
];

describe("runDeployAnnotate", () => {
  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    installStreamCapture();
  });
  afterEach(() => {
    clearFixture();
    restoreStreams();
  });

  it("returns 2 with arg-parse error printed to stderr", async () => {
    const exit = await runDeployAnnotate(["--service", "x"]);
    expect(exit).toBe(2);
    expect(stderrChunks.join("")).toMatch(/is required|must be/);
  });

  it("returns 1 with 'Gateway is not running' when state is undefined", async () => {
    setFixture({});
    const exit = await runDeployAnnotate(VALID_ARGV);
    expect(exit).toBe(1);
    expect(stderrChunks.join("")).toContain("Gateway is not running");
  });

  it("returns 0 + pretty output on success", async () => {
    const response = {
      external_id: "github-actions:abc1234:prod",
      service: "payment-service",
      stored_at_ms: 1_747_142_500_000,
      is_new: true,
      dora_eligible: true,
    };
    const mock = createMockIpcClient([response]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    const exit = await runDeployAnnotate(VALID_ARGV);
    expect(exit).toBe(0);
    expect(stdoutChunks.join("")).toContain("Deployment recorded");
    expect(stdoutChunks.join("")).toContain("github-actions:abc1234:prod");
    expect(stdoutChunks.join("")).toContain("DORA-eligible");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.method).toBe("deployment.annotate");
    const params = mock.calls[0]?.params as Record<string, unknown>;
    expect(params["service"]).toBe("payment-service");
    expect(params["sha"]).toBe("abc1234");
    expect(params["status"]).toBe("success");
    expect(params["started_at_ms"]).toBe(1747142400000);
  });

  it("emits JSON payload when --json is passed", async () => {
    const response = {
      external_id: "github-actions:abc1234:prod",
      service: "payment-service",
      stored_at_ms: 1_747_142_500_000,
      is_new: false,
      dora_eligible: false,
    };
    const mock = createMockIpcClient([response]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    const exit = await runDeployAnnotate([...VALID_ARGV, "--json"]);
    expect(exit).toBe(0);
    expect(stdoutChunks.join("")).toContain('"external_id"');
    expect(stdoutChunks.join("")).toContain('"is_new": false');
  });

  it("forwards optional flags into the IPC payload", async () => {
    const response = {
      external_id: "github-actions:abc1234:prod",
      service: "payment-service",
      stored_at_ms: 1_747_142_500_000,
      is_new: true,
      dora_eligible: true,
    };
    const mock = createMockIpcClient([response]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runDeployAnnotate([
      ...VALID_ARGV,
      "--finished-at",
      "1747142500000",
      "--workflow-url",
      "https://gh/run/1",
      "--provider",
      "github-actions",
      "--run-id",
      "r1",
      "--job-id",
      "j1",
    ]);
    const params = mock.calls[0]?.params as Record<string, unknown>;
    expect(params["finished_at_ms"]).toBe(1747142500000);
    expect(params["workflow_url"]).toBe("https://gh/run/1");
    expect(params["provider"]).toBe("github-actions");
    expect(params["run_id"]).toBe("r1");
    expect(params["job_id"]).toBe("j1");
  });

  it("returns 1 on malformed envelope from gateway", async () => {
    const mock = createMockIpcClient([{ not: "an envelope" }]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    const exit = await runDeployAnnotate(VALID_ARGV);
    expect(exit).toBe(1);
    expect(stderrChunks.join("")).toContain("malformed envelope");
  });

  it("returns 1 on IPC error", async () => {
    const mock = createMockIpcClient([new Error("connection refused")]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    const exit = await runDeployAnnotate(VALID_ARGV);
    expect(exit).toBe(1);
    expect(stderrChunks.join("")).toContain("connection refused");
  });
});
