import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import { parseSinceDurationToMs } from "../lib/parse-since.ts";

// Imported AFTER cli-mocks installs the gateway-process / ipc-client module mocks (mirrors
// audit.test.ts) so the withIpc/withConsentIpc paths resolve the fake gateway state + IPC client.
const proveMod = await import("./prove.ts");
const { resolvePruneBeforeTs, runEgress, runEgressReport, runEgressVerify, runProve } = proveMod;

type Call = { method: string; params: unknown };

// Matches EgressCompleteness from Task 4: task is observed per-call, everything else is
// unobserved in this phase. A correctly-booted gateway with an intact chain looks like this.
const COVERED_COMPLETENESS = {
  coverage: { task: "per-call", session: "none", sync: "none", model: "none", peer: "none" },
  indeterminate: false,
};

// Direct fake client for the functions that take an IPCClient argument (no withIpc round-trip).
function fakeClient(responses: Record<string, unknown>): {
  calls: Call[];
  call: <T>(method: string, params: unknown) => Promise<T>;
} {
  const calls: Call[] = [];
  return {
    calls,
    call: async <T>(method: string, params: unknown): Promise<T> => {
      calls.push({ method, params });
      return responses[method] as T;
    },
  };
}

const wiredGateway = (call: unknown): void => {
  setFixture({
    gatewayState: { socketPath: FAKE_SOCKET_PATH },
    ipcClient: { call, connect: () => {}, disconnect: () => {} },
  });
};

const out = captureOutput();
afterAll(() => {
  out.restore();
});

describe("runEgressVerify", () => {
  test("exit code 0 on a clean chain", async () => {
    process.exitCode = 0;
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const c = fakeClient({ "egress.verify": { ok: true, verifiedRows: 3 } }) as any;
    await runEgressVerify(c);
    expect(process.exitCode).toBe(0);
  });
  test("exit code 1 on a tampered chain", async () => {
    process.exitCode = 0;
    const c = fakeClient({
      "egress.verify": { ok: false, brokenAt: 7, reason: "row_hash mismatch at id 7" },
      // biome-ignore lint/suspicious/noExplicitAny: fake client
    }) as any;
    await runEgressVerify(c);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
  test("falls back to 'unknown' reason when omitted on a break", async () => {
    process.exitCode = 0;
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const c = fakeClient({ "egress.verify": { ok: false, brokenAt: 2 } }) as any;
    await runEgressVerify(c);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

describe("runEgressReport", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = 0;
  });

  test("calls egress.proveWindow with sign when --sign is passed", async () => {
    const c = fakeClient({
      "egress.proveWindow": {
        rows: [],
        completeness: { ...COVERED_COMPLETENESS, outboundEgressEvents: 0 },
        verify: { ok: true },
      },
      // biome-ignore lint/suspicious/noExplicitAny: fake client
    }) as any;
    await runEgressReport(c, { json: false, sign: true });
    expect(c.calls[0]?.method).toBe("egress.proveWindow");
    expect((c.calls[0]?.params as { sign?: boolean } | undefined)?.sign).toBe(true);
  });

  test("a degraded (unverifiable) chain prints indeterminate and exits non-zero", async () => {
    const c = fakeClient({
      "egress.proveWindow": {
        rows: [],
        completeness: { ...COVERED_COMPLETENESS, outboundEgressEvents: 0 },
        verify: { ok: false, brokenAt: 4 },
      },
      // biome-ignore lint/suspicious/noExplicitAny: fake client
    }) as any;
    await runEgressReport(c, { json: false });
    expect(process.exitCode).toBe(1);
    expect(out.stdout).toContain("indeterminate");
  });

  // Fix round 1: an intact chain (verify.ok === true) with no boot marker covering the window
  // (completeness.indeterminate === true) must still exit non-zero — an unprovable window is not
  // a clean report. Previously exitCode was only set inside the `!out.verify.ok` branch, so this
  // combination fell through to the default exitCode (0) despite printing "indeterminate".
  test("an intact chain with no covering boot marker (indeterminate) prints indeterminate and exits non-zero", async () => {
    const c = fakeClient({
      "egress.proveWindow": {
        rows: [],
        completeness: {
          coverage: { task: "none", session: "none", sync: "none", model: "none", peer: "none" },
          outboundEgressEvents: 0,
          indeterminate: true,
        },
        verify: { ok: true },
      },
      // biome-ignore lint/suspicious/noExplicitAny: fake client
    }) as any;
    await runEgressReport(c, { json: false });
    expect(out.stdout).toContain("indeterminate");
    expect(process.exitCode).toBe(1);
  });

  test("--json prints the raw proveWindow payload and returns early", async () => {
    const payload = {
      rows: [
        {
          timestamp: 1700000000000,
          destination: "email",
          method: "email.send",
          resultStatus: "authorized",
        },
      ],
      completeness: { ...COVERED_COMPLETENESS, outboundEgressEvents: 1 },
      verify: { ok: true },
    };
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const c = fakeClient({ "egress.proveWindow": payload }) as any;
    await runEgressReport(c, { json: true });
    expect(out.stdout).toContain('"indeterminate": false');
    expect(out.stdout).toContain('"outboundEgressEvents": 1');
  });

  test("prints the row table + receipt line, and forwards --since", async () => {
    const c = fakeClient({
      "egress.proveWindow": {
        rows: [
          {
            timestamp: 1700000000000,
            destination: "email",
            method: "email.send",
            resultStatus: "authorized",
          },
        ],
        completeness: { ...COVERED_COMPLETENESS, outboundEgressEvents: 1 },
        verify: { ok: true },
        receipt: { sigB64: "AAAABBBBCCCCDDDDEEEE", pubkeyB64: "pk", digest: "deadbeef" },
      },
      // biome-ignore lint/suspicious/noExplicitAny: fake client
    }) as any;
    await runEgressReport(c, { json: false, since: 123 });
    expect((c.calls[0]?.params as { since?: number } | undefined)?.since).toBe(123);
    // `runEgressReport` is the `nimbus egress`/`--since` whole-window (or --since-windowed) total,
    // never a per-query delta — it must be labeled "in this window", NOT "during this query" (the
    // label `runProve` uses for its own, different, head-count-diff number). Pinned so the two
    // call sites cannot regress back to sharing an identical, scope-lying label.
    expect(out.stdout).toContain("outbound egress events in this window: 1");
    expect(out.stdout).not.toContain("during this query");
    expect(out.stdout).toContain("email.send");
    expect(out.stdout).toContain("receipt: digest=deadbeef");
  });

  // Fix wave: pins the runEgressReport scope label so it cannot regress to the query-scoped
  // wording — this is the surface `formatProveResult`'s unit tests alone cannot cover, since both
  // existing queued fixtures happened to return a delta of 1 either way.
  test("labels the count 'in this window', never 'during this query'", async () => {
    const c = fakeClient({
      "egress.proveWindow": {
        rows: [],
        completeness: { ...COVERED_COMPLETENESS, outboundEgressEvents: 0 },
        verify: { ok: true },
      },
      // biome-ignore lint/suspicious/noExplicitAny: fake client
    }) as any;
    await runEgressReport(c, { json: false });
    expect(out.stdout).toContain("outbound egress events in this window: 0");
    expect(out.stdout).not.toContain("during this query");
  });
});

describe("resolvePruneBeforeTs", () => {
  const NOW = 1_000_000_000_000;

  test("--older-than 30d resolves to now - parseSinceDurationToMs('30d')", () => {
    expect(resolvePruneBeforeTs(["--older-than", "30d"], NOW)).toBe(
      NOW - parseSinceDurationToMs("30d"),
    );
  });
  test("--before <epoch> still works (absolute form preserved)", () => {
    expect(resolvePruneBeforeTs(["--before", "1700"], NOW)).toBe(1700);
  });
  test("--before <ISO> parses an ISO date", () => {
    expect(resolvePruneBeforeTs(["--before", "2023-11-14T22:13:20.000Z"], NOW)).toBe(
      Date.parse("2023-11-14T22:13:20.000Z"),
    );
  });
  test("--before with an unparseable value is rejected", () => {
    expect(() => resolvePruneBeforeTs(["--before", "not-a-date"], NOW)).toThrow(/Invalid --before/);
  });
  test("passing BOTH --before and --older-than is rejected", () => {
    expect(() => resolvePruneBeforeTs(["--before", "1700", "--older-than", "30d"], NOW)).toThrow(
      /not both/,
    );
  });
  test("neither form present is rejected", () => {
    expect(() => resolvePruneBeforeTs([], NOW)).toThrow(/--before|--older-than/);
  });
});

describe("runProve (dispatcher through withConsentIpc)", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  // The defect being fixed: a zero-delta window used to print a bare "outbound egress events
  // during this query: 0 ✓" from a head-count diff alone, with no chain verify and no coverage
  // check. runProve now ALWAYS consults egress.proveWindow, and the zero case must name its scope
  // (and list what wasn't observed) instead of asserting a clean checkmark.
  it("names the scope for a zero-delta window — never prints a bare '0 ✓'", async () => {
    const ipc = createMockIpcClient([
      { head: "h", count: 5 }, // egress.head (before)
      {}, // agent.invoke
      { head: "h", count: 5 }, // egress.head (after)
      {
        rows: [],
        completeness: { ...COVERED_COMPLETENESS, outboundEgressEvents: 0 },
        verify: { ok: true },
      }, // egress.proveWindow
    ]);
    wiredGateway(ipc.client.call);
    await runProve(["what time is it"]);
    expect(out.stdout).toContain(
      "outbound egress events during this query: 0 (scope: gated connector actions)",
    );
    expect(out.stdout).toContain("not observed: model, peer, session, sync");
    expect(out.stdout).not.toContain("0 ✓");
    expect(ipc.calls.map((c) => c.method)).toEqual([
      "egress.head",
      "agent.invoke",
      "egress.head",
      "egress.proveWindow",
    ]);
  });

  it("skips agent.invoke when no query is given (flags only), still consults proveWindow", async () => {
    const ipc = createMockIpcClient([
      { head: "h", count: 2 }, // egress.head (before)
      { head: "h", count: 2 }, // egress.head (after)
      {
        rows: [],
        completeness: { ...COVERED_COMPLETENESS, outboundEgressEvents: 0 },
        verify: { ok: true },
      }, // egress.proveWindow
    ]);
    wiredGateway(ipc.client.call);
    await runProve(["--receipt"]);
    expect(ipc.calls.map((c) => c.method)).toEqual([
      "egress.head",
      "egress.head",
      "egress.proveWindow",
    ]);
    expect(out.stdout).toContain("scope: gated connector actions");
    expect(out.stdout).not.toContain("0 ✓");
  });

  it("reports the egress window when the head advances", async () => {
    const ipc = createMockIpcClient([
      { head: "h0", count: 5 }, // egress.head (before)
      {}, // agent.invoke
      { head: "h1", count: 6 }, // egress.head (after)
      {
        rows: [],
        completeness: { ...COVERED_COMPLETENESS, outboundEgressEvents: 1 },
        verify: { ok: true },
      }, // egress.proveWindow (runProve's own window check)
      {
        rows: [
          {
            timestamp: 1700000000000,
            destination: "email",
            method: "email.send",
            resultStatus: "authorized",
          },
        ],
        completeness: { ...COVERED_COMPLETENESS, outboundEgressEvents: 1 },
        verify: { ok: true },
      }, // egress.proveWindow (via runEgressReport, since delta !== 0)
    ]);
    wiredGateway(ipc.client.call);
    await runProve(["send the email"]);
    expect(out.stdout).toContain("outbound egress events during this query: 1");
    expect(out.stdout).toContain("email.send");
    expect(ipc.calls.map((c) => c.method)).toContain("egress.proveWindow");
  });

  it("reports indeterminate and exits 1 when no boot marker covers the window", async () => {
    const ipc = createMockIpcClient([
      { head: "h", count: 5 }, // egress.head (before)
      {}, // agent.invoke
      { head: "h", count: 5 }, // egress.head (after)
      {
        rows: [],
        completeness: {
          coverage: { task: "none", session: "none", sync: "none", model: "none", peer: "none" },
          outboundEgressEvents: 0,
          indeterminate: true,
        },
        verify: { ok: true },
      }, // egress.proveWindow
    ]);
    wiredGateway(ipc.client.call);
    await runProve(["what time is it"]);
    expect(out.stdout).toContain("indeterminate");
    expect(out.stdout).not.toContain("0 ✓");
    expect(process.exitCode).toBe(1);
  });
});

describe("runEgress (dispatcher)", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  it("dispatches 'verify' through withIpc", async () => {
    const ipc = createMockIpcClient([{ ok: true, verifiedRows: 9 }]);
    wiredGateway(ipc.client.call);
    await runEgress(["verify"]);
    expect(ipc.calls[0]?.method).toBe("egress.verify");
    expect(out.stdout).toContain("9 rows verified");
  });

  it("dispatches 'prune' and prints the approved result", async () => {
    const ipc = createMockIpcClient([{ approved: true, prunedCount: 4 }]);
    wiredGateway(ipc.client.call);
    await runEgress(["prune", "--older-than", "30d"]);
    expect(ipc.calls[0]?.method).toBe("egress.prune");
    expect(out.stdout).toContain("pruned 4 egress rows");
  });

  it("prints the denied message when prune approval is refused", async () => {
    const ipc = createMockIpcClient([{ approved: false, prunedCount: 0 }]);
    wiredGateway(ipc.client.call);
    await runEgress(["prune", "--before", "1700"]);
    expect(out.stdout).toContain("[denied] prune not approved");
  });

  it("takes the default report path with --since/--json", async () => {
    const ipc = createMockIpcClient([
      {
        rows: [],
        completeness: { ...COVERED_COMPLETENESS, outboundEgressEvents: 0 },
        verify: { ok: true },
      },
    ]);
    wiredGateway(ipc.client.call);
    await runEgress(["--since", "24h", "--json"]);
    expect(ipc.calls[0]?.method).toBe("egress.proveWindow");
    const params = ipc.calls[0]?.params as { since?: number };
    expect(typeof params.since).toBe("number");
    expect(out.stdout).toContain('"indeterminate": false');
  });

  it("ignores --since when immediately followed by another flag", async () => {
    const ipc = createMockIpcClient([
      {
        rows: [],
        completeness: { ...COVERED_COMPLETENESS, outboundEgressEvents: 0 },
        verify: { ok: true },
      },
    ]);
    wiredGateway(ipc.client.call);
    await runEgress(["--since", "--json"]);
    const params = ipc.calls[0]?.params as { since?: number };
    expect(params.since).toBeUndefined();
  });

  it("ignores a dangling --since with no value", async () => {
    const ipc = createMockIpcClient([
      {
        rows: [],
        completeness: { ...COVERED_COMPLETENESS, outboundEgressEvents: 0 },
        verify: { ok: true },
      },
    ]);
    wiredGateway(ipc.client.call);
    await runEgress(["--since"]);
    const params = ipc.calls[0]?.params as { since?: number };
    expect(params.since).toBeUndefined();
  });

  it("throws the gateway-not-running error when no gateway state exists", async () => {
    setFixture({});
    await expect(runEgress(["verify"])).rejects.toThrow(
      "Gateway is not running. Start with: nimbus start",
    );
  });
});
