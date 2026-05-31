import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";

import "../../test/helpers/cli-mocks.ts";
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const mod = await import("./security.ts");
const { formatScanPretty, parseSecurityArgs, runSecurity } = mod;

const RESULT_FIXTURE = {
  scanned_at_ms: 1_747_000_000_000,
  items_scanned: 12,
  items_skipped_depth: 3,
  findings_count: 2,
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
    },
  ],
  skipped_connectors: [{ service: "gmail", depth: "metadata_only" as const }],
};

describe("parseSecurityArgs", () => {
  test("scan with no flags", () => {
    const parsed = parseSecurityArgs(["scan"]);
    expect(parsed.subcommand).toBe("scan");
    expect(parsed.json).toBe(false);
  });

  test("scan --json", () => {
    const parsed = parseSecurityArgs(["scan", "--json"]);
    expect(parsed.subcommand).toBe("scan");
    expect(parsed.json).toBe(true);
  });

  test("help subcommand", () => {
    const parsed = parseSecurityArgs(["help"]);
    expect(parsed.subcommand).toBe("help");
  });

  test("unknown subcommand throws", () => {
    expect(() => parseSecurityArgs(["bogus"])).toThrow();
  });

  test("missing subcommand throws", () => {
    expect(() => parseSecurityArgs([])).toThrow();
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
    expect(out).toContain("anthropic_api_key");
    expect(out).toContain("filesystem:src/config.ts");
  });

  test("no findings, no skipped — prints clean message", () => {
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

  test("emits ANSI color codes when tty=true AND noColor=false", () => {
    const out = formatScanPretty(RESULT_FIXTURE, { tty: true, noColor: false });
    expect(out.includes("\x1b[33m")).toBe(true);
    expect(out.includes("\x1b[31m")).toBe(true);
  });

  test("clean message includes 'v1 pattern set' branding", () => {
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
    expect(out).toContain("v1 pattern set");
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

  it("exits 1 on unknown subcommand", async () => {
    await expect(runSecurity(["bogus"])).rejects.toThrow("process.exit(1)");
    expect(stderrChunks.join("")).toContain("Unknown security subcommand");
  });

  it("prints help text and returns when subcommand is 'help'", async () => {
    await runSecurity(["help"]);
    expect(stdoutChunks.join("")).toContain("nimbus security");
    expect(stdoutChunks.join("")).toContain("scan");
  });

  it("exits 1 when gateway state is undefined", async () => {
    setFixture({});
    await expect(runSecurity(["scan"])).rejects.toThrow("process.exit(1)");
    expect(stderrChunks.join("")).toContain("Gateway is not running");
  });

  it("renders pretty output on success", async () => {
    const mock = createMockIpcClient([RESULT_FIXTURE]);
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
    await runSecurity(["scan"]);
    expect(mock.calls[0]?.method).toBe("security.scan");
    expect(stdoutChunks.join("")).toContain("Nimbus security scan");
    expect(stdoutChunks.join("")).toContain("aws_access_key");
  });

  it("emits JSON envelope when --json is passed", async () => {
    const mock = createMockIpcClient([RESULT_FIXTURE]);
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
    await runSecurity(["scan", "--json"]);
    expect(stdoutChunks.join("")).toContain('"findings_count"');
    expect(stdoutChunks.join("")).toContain('"pattern_name": "aws_access_key"');
  });

  it("exits 2 on malformed envelope", async () => {
    const mock = createMockIpcClient([{ not: "a scan result" }]);
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
    await expect(runSecurity(["scan"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("Malformed");
  });

  it("exits 2 on IPC error", async () => {
    const mock = createMockIpcClient([new Error("scan failed")]);
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
    await expect(runSecurity(["scan"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("scan failed");
  });
});
