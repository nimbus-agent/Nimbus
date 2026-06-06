import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createMockIpcClient, type MockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const mod = await import("./security.ts");
const { decideExitCode, formatScanPretty, parseSecurityArgs, runSecurity } = mod;

const RESULT_FIXTURE = {
  scanned_at_ms: 1_747_000_000_000,
  items_scanned: 12,
  items_skipped_depth: 3,
  findings_count: 2,
  muted_count: 0,
  findings: [
    {
      item_id: "filesystem:src/config.ts",
      service: "filesystem",
      type: "code_symbol",
      title: "config.ts",
      pattern_name: "aws_access_key",
      pattern_category: "api_key" as const,
      match_redacted: "AKIA****MPLE",
      match_offset: 12,
      context_snippet: "k='[REDACTED]'",
      modified_at_ms: 1_746_000_000_000,
      url: null,
      fingerprint: "a".repeat(64),
      external_id: "src/config.ts",
      blame: {
        commit_sha: "cafef00dba11",
        author_name: "Ada",
        author_email: "ada@x.dev",
        author_time_ms: 1_745_500_000_000,
      },
    },
    {
      item_id: "obsidian:Drafts/onboarding.md",
      service: "obsidian",
      type: "obsidian_note",
      title: "onboarding.md",
      pattern_name: "anthropic_api_key",
      pattern_category: "api_key" as const,
      match_redacted: "sk-a****1234",
      match_offset: 200,
      context_snippet: "API key: [REDACTED] used by",
      modified_at_ms: 1_745_000_000_000,
      url: null,
      fingerprint: "b".repeat(64),
      external_id: "Drafts/onboarding.md",
      blame: null,
    },
  ],
  skipped_connectors: [{ service: "gmail", depth: "metadata_only" as const }],
};

describe("parseSecurityArgs", () => {
  test("scan with no flags", () => {
    const parsed = parseSecurityArgs(["scan"]);
    expect(parsed.subcommand).toBe("scan");
    expect(parsed.json).toBe(false);
    expect(parsed.failOnFinding).toBe(false);
    expect(parsed.extended).toBe(false);
    expect(parsed.service).toBeUndefined();
  });

  test("scan with all flags", () => {
    const parsed = parseSecurityArgs([
      "scan",
      "--json",
      "--fail-on-finding",
      "--extended",
      "--service",
      "filesystem",
    ]);
    expect(parsed.json).toBe(true);
    expect(parsed.failOnFinding).toBe(true);
    expect(parsed.extended).toBe(true);
    expect(parsed.service).toBe("filesystem");
  });

  test("help subcommand", () => {
    expect(parseSecurityArgs(["help"]).subcommand).toBe("help");
  });

  test("unknown subcommand throws", () => {
    expect(() => parseSecurityArgs(["bogus"])).toThrow();
  });

  test("missing subcommand throws", () => {
    expect(() => parseSecurityArgs([])).toThrow();
  });
});

describe("decideExitCode", () => {
  test("0 when fail-on-finding off, regardless of findings", () => {
    expect(decideExitCode(5, false)).toBe(0);
  });
  test("1 when fail-on-finding on and findings > 0", () => {
    expect(decideExitCode(1, true)).toBe(1);
  });
  test("0 when fail-on-finding on but zero findings", () => {
    expect(decideExitCode(0, true)).toBe(0);
  });
});

describe("formatScanPretty", () => {
  test("renders header + finding table + skipped connectors", () => {
    const out = formatScanPretty(RESULT_FIXTURE, { tty: false, noColor: true });
    expect(out).toContain("Scanned 12 items");
    expect(out).toContain("Skipped 3 items");
    expect(out).toContain("gmail");
    expect(out).toContain("aws_access_key");
    expect(out).toContain("AKIA****MPLE");
    expect(out).toContain("filesystem:src/config.ts");
  });

  test("renders blame attribution and fingerprint", () => {
    const out = formatScanPretty(RESULT_FIXTURE, { tty: false, noColor: true });
    expect(out).toContain("introduced by ada@x.dev");
    expect(out).toContain("cafef00dba11");
    expect(out).toContain(`fingerprint: ${"a".repeat(64)}`);
  });

  test("prints the backfill hint when a code_symbol finding lacks blame", () => {
    const noBlame = {
      ...RESULT_FIXTURE,
      findings: [{ ...RESULT_FIXTURE.findings[0]!, blame: null }],
      findings_count: 1,
    };
    const out = formatScanPretty(noBlame, { tty: false, noColor: true });
    expect(out).toContain("nimbus connector sync filesystem");
  });

  test("no findings — prints clean message", () => {
    const out = formatScanPretty(
      {
        ...RESULT_FIXTURE,
        items_skipped_depth: 0,
        findings_count: 0,
        findings: [],
        skipped_connectors: [],
      },
      { tty: false, noColor: true },
    );
    expect(out).toContain("0 findings");
    expect(out).not.toContain("Skipped");
  });

  test("renders without ANSI when noColor is true", () => {
    const out = formatScanPretty(RESULT_FIXTURE, { tty: true, noColor: true });
    expect(out.includes("\x1b[")).toBe(false);
  });

  test("does NOT leak the full secret in pretty output", () => {
    const out = formatScanPretty(RESULT_FIXTURE, { tty: false, noColor: true });
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("shows muted count when > 0", () => {
    const out = formatScanPretty(
      { ...RESULT_FIXTURE, muted_count: 2 },
      { tty: false, noColor: true },
    );
    expect(out).toContain("2 finding(s) muted");
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

/** Wire a mock whose security.scan call returns {jobId} then asynchronously emits a done/error event. */
function emittingFixture(mock: MockIpcClient, onScan: (jobId: string) => void): void {
  const base = mock.client as unknown as { call: (m: string, p: unknown) => Promise<unknown> };
  setFixture({
    gatewayState: { socketPath: FAKE_SOCKET_PATH },
    ipcClient: {
      call: async (m: string, p: unknown): Promise<unknown> => {
        const r = (await base.call(m, p)) as { jobId?: string };
        if (m === "security.scan" && typeof r.jobId === "string") {
          const id = r.jobId;
          setTimeout(() => onScan(id), 0);
        }
        return r;
      },
      connect: async (): Promise<void> => {},
      disconnect: async (): Promise<void> => {},
      onNotification: (e: string, h: (params: unknown) => void): void => {
        (
          mock.client as unknown as { onNotification: (e: string, h: (p: unknown) => void) => void }
        ).onNotification(e, h);
      },
    },
  });
}

afterAll(() => {
  restoreStreams();
});

describe("runSecurity", () => {
  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    installStreamCapture();
  });
  afterEach(() => {
    clearFixture();
    restoreStreams();
  });

  it("exits 1 on missing subcommand", async () => {
    await expect(runSecurity([])).rejects.toThrow("process.exit(1)");
    expect(stderrChunks.join("")).toContain("Usage:");
  });

  it("prints help text when subcommand is 'help'", async () => {
    await runSecurity(["help"]);
    expect(stdoutChunks.join("")).toContain("nimbus security");
    expect(stdoutChunks.join("")).toContain("--fail-on-finding");
  });

  it("exits 1 when gateway state is undefined", async () => {
    setFixture({});
    await expect(runSecurity(["scan"])).rejects.toThrow("process.exit(1)");
    expect(stderrChunks.join("")).toContain("Gateway is not running");
  });

  it("renders pretty output on success (job → scanDone)", async () => {
    const mock = createMockIpcClient([{ jobId: "job-s1" }]);
    emittingFixture(mock, (jobId) => mock.emit("security.scanDone", { jobId, ...RESULT_FIXTURE }));
    await runSecurity(["scan"]);
    expect(mock.calls[0]?.method).toBe("security.scan");
    expect(stdoutChunks.join("")).toContain("Nimbus security scan");
    expect(stdoutChunks.join("")).toContain("aws_access_key");
  });

  it("emits JSON when --json is passed", async () => {
    const mock = createMockIpcClient([{ jobId: "job-j1" }]);
    emittingFixture(mock, (jobId) => mock.emit("security.scanDone", { jobId, ...RESULT_FIXTURE }));
    await runSecurity(["scan", "--json"]);
    expect(stdoutChunks.join("")).toContain('"findings_count"');
    expect(stdoutChunks.join("")).toContain('"pattern_name": "aws_access_key"');
  });

  it("exits 1 with --fail-on-finding when findings remain", async () => {
    const mock = createMockIpcClient([{ jobId: "job-f1" }]);
    emittingFixture(mock, (jobId) => mock.emit("security.scanDone", { jobId, ...RESULT_FIXTURE }));
    await expect(runSecurity(["scan", "--fail-on-finding"])).rejects.toThrow("process.exit(1)");
  });

  it("exits 0 with --fail-on-finding when clean", async () => {
    const clean = { ...RESULT_FIXTURE, findings: [], findings_count: 0 };
    const mock = createMockIpcClient([{ jobId: "job-f0" }]);
    emittingFixture(mock, (jobId) => mock.emit("security.scanDone", { jobId, ...clean }));
    await runSecurity(["scan", "--fail-on-finding"]); // resolves, no throw
    expect(stdoutChunks.join("")).toContain("0 findings");
  });

  it("passes --service and --extended through to the scan params", async () => {
    const mock = createMockIpcClient([{ jobId: "job-p1" }]);
    const clean = { ...RESULT_FIXTURE, findings: [], findings_count: 0 };
    emittingFixture(mock, (jobId) => mock.emit("security.scanDone", { jobId, ...clean }));
    await runSecurity(["scan", "--service", "filesystem", "--extended"]);
    expect(mock.calls[0]?.params).toEqual({ service: "filesystem", extended: true });
  });

  it("exits 2 on a scanError event", async () => {
    const mock = createMockIpcClient([{ jobId: "job-e1" }]);
    emittingFixture(mock, (jobId) =>
      mock.emit("security.scanError", { jobId, code: -32603, message: "scan blew up" }),
    );
    await expect(runSecurity(["scan"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("scan blew up");
  });
});
