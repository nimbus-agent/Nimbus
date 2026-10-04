import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createMockIpcClient, type MockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";

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

  test("--help and -h aliases resolve to the help subcommand", () => {
    expect(parseSecurityArgs(["--help"]).subcommand).toBe("help");
    expect(parseSecurityArgs(["-h"]).subcommand).toBe("help");
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

  test("muted_count absent → no muted line (covers the ?? 0 fallback)", () => {
    const { muted_count: _drop, ...noMuted } = RESULT_FIXTURE;
    const out = formatScanPretty(noMuted, { tty: false, noColor: true });
    expect(out).not.toContain("muted by");
    // header + findings still render
    expect(out).toContain("Nimbus security scan");
  });

  test("emits ANSI color when tty && !noColor (covers yellow/red/dim colored side)", () => {
    const out = formatScanPretty(
      { ...RESULT_FIXTURE, muted_count: 2 },
      { tty: true, noColor: false },
    );
    // red() wraps the pattern name in the findings table
    expect(out).toContain(`\x1b[31m`);
    // yellow() wraps the skipped-connectors line
    expect(out).toContain(`\x1b[33m`);
    // dim() wraps the muted line + blame + fingerprint
    expect(out).toContain(`\x1b[2m`);
    expect(out).toContain(`\x1b[0m`);
    expect(out).toContain("introduced by ada@x.dev");
  });

  test("colored output: no findings → clean message without ANSI table rows", () => {
    const out = formatScanPretty(
      {
        ...RESULT_FIXTURE,
        items_skipped_depth: 0,
        findings_count: 0,
        findings: [],
        skipped_connectors: [],
        muted_count: 0,
      },
      { tty: true, noColor: false },
    );
    expect(out).toContain("0 findings. Index appears clean");
    // No yellow skipped line and no red finding rows when nothing to report.
    expect(out).not.toContain(`\x1b[33m`);
    expect(out).not.toContain(`\x1b[31m`);
  });

  test("colored: blame with null author_email/name and null author_time_ms falls back", () => {
    const out = formatScanPretty(
      {
        ...RESULT_FIXTURE,
        findings_count: 1,
        items_skipped_depth: 0,
        skipped_connectors: [],
        findings: [
          (() => {
            const { fingerprint: _drop, ...base } = RESULT_FIXTURE.findings[0]!;
            return {
              ...base,
              blame: {
                commit_sha: "deadbeefcafe99",
                author_name: null,
                author_email: null,
                author_time_ms: null,
              },
            };
          })(),
        ],
      },
      { tty: true, noColor: false },
    );
    // author falls back to "unknown", time to "?"
    expect(out).toContain("introduced by unknown @ ?");
    expect(out).toContain("deadbeefcafe");
    // dim wrapping present (colored side)
    expect(out).toContain(`\x1b[2m`);
  });

  test("colored: code_symbol finding without blame triggers backfill hint (dim)", () => {
    const out = formatScanPretty(
      {
        ...RESULT_FIXTURE,
        findings_count: 1,
        items_skipped_depth: 0,
        skipped_connectors: [],
        findings: [
          (() => {
            const { fingerprint: _drop, ...base } = RESULT_FIXTURE.findings[0]!;
            return { ...base, blame: null };
          })(),
        ],
      },
      { tty: true, noColor: false },
    );
    expect(out).toContain("nimbus connector sync filesystem");
    expect(out).toContain(`\x1b[2m`);
  });
});

const {
  stdoutChunks,
  stderrChunks,
  install: installStreamCapture,
  restore: restoreStreams,
} = createStreamCapture({ captureExit: true });

/**
 * Wire a mock whose security.scan call returns {jobId} and emits the scan's events -- by default on
 * a later turn, AFTER the reply. `"before-reply"` is the order the real gateway produces: it runs
 * the scan synchronously inside the request (`LongRunningJobRegistry.start` over the synchronous
 * `runSecurityScan`), so progress and `scanDone` reach the wire ahead of the response naming the job.
 */
function emittingFixture(
  mock: MockIpcClient,
  onScan: (jobId: string) => void,
  when: "after-reply" | "before-reply" = "after-reply",
): void {
  const base = mock.client as unknown as { call: (m: string, p: unknown) => Promise<unknown> };
  setFixture({
    gatewayState: { socketPath: FAKE_SOCKET_PATH },
    ipcClient: {
      call: async (m: string, p: unknown): Promise<unknown> => {
        const r = (await base.call(m, p)) as { jobId?: string };
        if (m === "security.scan" && typeof r.jobId === "string") {
          const id = r.jobId;
          if (when === "before-reply") onScan(id);
          else setTimeout(() => onScan(id), 0);
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

  it("reports progress for ITS OWN job on stderr, and ignores another job's events entirely", async () => {
    const clean = { ...RESULT_FIXTURE, findings: [], findings_count: 0 };
    const mock = createMockIpcClient([{ jobId: "job-mine" }]);
    emittingFixture(mock, (jobId) => {
      mock.emit("security.scanProgress", { jobId, scanned: 3, total: 12 });
      // A concurrent scan from another client shares the broadcast: none of it may leak in.
      mock.emit("security.scanProgress", { jobId: "job-other", scanned: 99, total: 99 });
      mock.emit("security.scanError", { jobId: "job-other", message: "not my failure" });
      mock.emit("security.scanDone", { jobId: "job-other", ...RESULT_FIXTURE });
      mock.emit("security.scanDone", { jobId, ...clean });
    });
    await runSecurity(["scan"]);
    expect(stderrChunks.join("")).toBe("scanning 3/12\r");
    expect(stdoutChunks.join("")).toContain("0 findings. Index appears clean");
    expect(stdoutChunks.join("")).not.toContain("aws_access_key");
  });

  /** Yield whole macrotask turns until `isSettled()` -- bounded by turns, never by wall time. */
  async function settleWithin(turns: number, isSettled: () => boolean): Promise<void> {
    for (let i = 0; i < turns && !isSettled(); i++) {
      await new Promise((r) => setImmediate(r));
    }
  }

  it("finishes when the scan's events reach it BEFORE the reply naming the job (the real wire order)", async () => {
    const clean = { ...RESULT_FIXTURE, findings: [], findings_count: 0 };
    const mock = createMockIpcClient([{ jobId: "job-early" }]);
    emittingFixture(
      mock,
      (jobId) => {
        // Another client's scan shares the broadcast: held back with ours, it must still be dropped.
        mock.emit("security.scanDone", { jobId: "job-other", ...RESULT_FIXTURE });
        mock.emit("security.scanProgress", { jobId, scanned: 12, total: 12 });
        mock.emit("security.scanDone", { jobId, ...clean });
      },
      "before-reply",
    );
    let settled = false;
    const run = runSecurity(["scan"]).finally(() => {
      settled = true;
    });
    // A scanDone dropped for arriving early never settles the run at all.
    await settleWithin(20, () => settled);
    expect(settled).toBe(true);
    await run;
    expect(stderrChunks.join("")).toBe("scanning 12/12\r");
    expect(stdoutChunks.join("")).toContain("0 findings. Index appears clean");
    expect(stdoutChunks.join("")).not.toContain("aws_access_key");
  });

  it("an error that reaches it BEFORE the reply still fails the scan, exit 2", async () => {
    const mock = createMockIpcClient([{ jobId: "job-early-err" }]);
    emittingFixture(
      mock,
      (jobId) => mock.emit("security.scanError", { jobId, message: "index locked" }),
      "before-reply",
    );
    let outcome: unknown = "pending";
    const run = runSecurity(["scan"]).then(
      () => {
        outcome = "resolved";
      },
      (e: unknown) => {
        outcome = e;
      },
    );
    await settleWithin(20, () => outcome !== "pending");
    expect(String(outcome)).toContain("process.exit(2)");
    await run;
    expect(stderrChunks.join("")).toBe("index locked\n");
  });

  it("--json keeps stderr free of progress lines", async () => {
    const mock = createMockIpcClient([{ jobId: "job-q" }]);
    emittingFixture(mock, (jobId) => {
      mock.emit("security.scanProgress", { jobId, scanned: 1, total: 2 });
      mock.emit("security.scanDone", { jobId, ...RESULT_FIXTURE });
    });
    await runSecurity(["scan", "--json"]);
    expect(stderrChunks).toEqual([]);
    expect(JSON.parse(stdoutChunks.join("")).findings_count).toBe(2);
  });

  it("exits 2 on a malformed scanDone payload rather than rendering it", async () => {
    const mock = createMockIpcClient([{ jobId: "job-m" }]);
    emittingFixture(mock, (jobId) =>
      mock.emit("security.scanDone", { jobId, items_scanned: "twelve", findings: [] }),
    );
    await expect(runSecurity(["scan"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toBe("Malformed security.scanDone payload\n");
    expect(stdoutChunks).toEqual([]);
  });

  it("connects before it asks for the scan, and disconnects after the result", async () => {
    // The mock client's connect is a no-op, so no other test here would notice a scan sent down a
    // client that was never connected -- which is a failed command against a real gateway.
    const lifecycle: string[] = [];
    const mock = createMockIpcClient([{ jobId: "job-l" }]);
    emittingFixture(mock, (jobId) => mock.emit("security.scanDone", { jobId, ...RESULT_FIXTURE }));
    const fixture = globalThis.__nimbusCliFixture;
    if (fixture?.ipcClient === undefined) throw new Error("emittingFixture installed no client");
    const scanCall = fixture.ipcClient.call as (m: string, p: unknown) => Promise<unknown>;
    fixture.ipcClient.connect = async (): Promise<void> => {
      lifecycle.push("connect");
    };
    fixture.ipcClient.call = (m: string, p: unknown): Promise<unknown> => {
      lifecycle.push(`call ${m}`);
      return scanCall(m, p);
    };
    fixture.ipcClient.disconnect = async (): Promise<void> => {
      lifecycle.push("disconnect");
    };
    await runSecurity(["scan"]);
    expect(lifecycle).toEqual(["connect", "call security.scan", "disconnect"]);
    expect(stdoutChunks.join("")).toContain("Nimbus security scan");
  });

  it("a disconnect that fails AFTER a successful scan does not turn it into a failure", async () => {
    const mock = createMockIpcClient([{ jobId: "job-d" }]);
    emittingFixture(mock, (jobId) => mock.emit("security.scanDone", { jobId, ...RESULT_FIXTURE }));
    const fixture = globalThis.__nimbusCliFixture;
    if (fixture?.ipcClient === undefined) throw new Error("emittingFixture installed no client");
    fixture.ipcClient.disconnect = async (): Promise<void> => {
      throw new Error("socket already closed");
    };
    await runSecurity(["scan"]);
    expect(stdoutChunks.join("")).toContain("Nimbus security scan");
    expect(stderrChunks.join("")).not.toContain("socket already closed");
  });

  it("a non-Error rejection of the scan call is still reported verbatim, exit 2", async () => {
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (): Promise<unknown> => {
          throw "connection reset";
        },
        connect: async (): Promise<void> => {},
        disconnect: async (): Promise<void> => {},
        onNotification: (): void => {},
      },
    });
    await expect(runSecurity(["scan"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toBe("connection reset\n");
  });
});

describe("runSecurity -- colour follows NO_COLOR on a TTY", () => {
  let savedNoColor: string | undefined;
  let savedIsTty: PropertyDescriptor | undefined;

  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    savedNoColor = process.env["NO_COLOR"];
    savedIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    // A TTY, so the only thing left to decide colour is NO_COLOR itself.
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });
    installStreamCapture();
  });
  afterEach(() => {
    restoreStreams();
    if (savedIsTty === undefined) Reflect.deleteProperty(process.stdout, "isTTY");
    else Object.defineProperty(process.stdout, "isTTY", savedIsTty);
    if (savedNoColor === undefined) delete process.env["NO_COLOR"];
    else process.env["NO_COLOR"] = savedNoColor;
    clearFixture();
  });

  async function scanPretty(): Promise<string> {
    const mock = createMockIpcClient([{ jobId: "job-c" }]);
    emittingFixture(mock, (jobId) => mock.emit("security.scanDone", { jobId, ...RESULT_FIXTURE }));
    await runSecurity(["scan"]);
    return stdoutChunks.join("");
  }

  it("a non-empty NO_COLOR turns colour off", async () => {
    process.env["NO_COLOR"] = "1";
    const out = await scanPretty();
    expect(out).toContain("aws_access_key");
    expect(out).not.toContain("\x1b[");
  });

  it("an EMPTY NO_COLOR does not -- the convention is 'present and non-empty'", async () => {
    process.env["NO_COLOR"] = "";
    const out = await scanPretty();
    expect(out).toContain("\x1b[31m");
  });
});
