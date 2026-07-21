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
        completeness: { tier: "authorized-actions", outboundEgressEvents: 0 },
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
        completeness: { tier: "authorized-actions", outboundEgressEvents: 0 },
        verify: { ok: false, brokenAt: 4 },
      },
      // biome-ignore lint/suspicious/noExplicitAny: fake client
    }) as any;
    await runEgressReport(c, { json: false });
    expect(process.exitCode).toBe(1);
    expect(out.stdout).toContain("indeterminate");
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
      completeness: { tier: "authorized-actions", outboundEgressEvents: 1 },
      verify: { ok: true },
    };
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const c = fakeClient({ "egress.proveWindow": payload }) as any;
    await runEgressReport(c, { json: true });
    expect(out.stdout).toContain('"tier": "authorized-actions"');
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
        completeness: { tier: "authorized-actions", outboundEgressEvents: 1 },
        verify: { ok: true },
        receipt: { sigB64: "AAAABBBBCCCCDDDDEEEE", pubkeyB64: "pk", digest: "deadbeef" },
      },
      // biome-ignore lint/suspicious/noExplicitAny: fake client
    }) as any;
    await runEgressReport(c, { json: false, since: 123 });
    expect((c.calls[0]?.params as { since?: number } | undefined)?.since).toBe(123);
    expect(out.stdout).toContain("outbound egress events: 1");
    expect(out.stdout).toContain("email.send");
    expect(out.stdout).toContain("receipt: digest=deadbeef");
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

  it("prints '0 ✓' when the head does not advance during the query", async () => {
    const ipc = createMockIpcClient([
      { head: "h", count: 5 }, // egress.head (before)
      {}, // agent.invoke
      { head: "h", count: 5 }, // egress.head (after)
    ]);
    wiredGateway(ipc.client.call);
    await runProve(["what time is it"]);
    expect(out.stdout).toContain("outbound egress events during this query: 0 ✓");
    expect(ipc.calls.map((c) => c.method)).toEqual(["egress.head", "agent.invoke", "egress.head"]);
  });

  it("skips agent.invoke when no query is given (flags only)", async () => {
    const ipc = createMockIpcClient([
      { head: "h", count: 2 }, // egress.head (before)
      { head: "h", count: 2 }, // egress.head (after)
    ]);
    wiredGateway(ipc.client.call);
    await runProve(["--receipt"]);
    expect(ipc.calls.map((c) => c.method)).toEqual(["egress.head", "egress.head"]);
    expect(out.stdout).toContain("0 ✓");
  });

  it("reports the egress window when the head advances", async () => {
    const ipc = createMockIpcClient([
      { head: "h0", count: 5 }, // egress.head (before)
      {}, // agent.invoke
      { head: "h1", count: 6 }, // egress.head (after)
      {
        rows: [
          {
            timestamp: 1700000000000,
            destination: "email",
            method: "email.send",
            resultStatus: "authorized",
          },
        ],
        completeness: { tier: "authorized-actions", outboundEgressEvents: 1 },
        verify: { ok: true },
      },
    ]);
    wiredGateway(ipc.client.call);
    await runProve(["send the email"]);
    expect(out.stdout).toContain("outbound egress events during this query: 1");
    expect(ipc.calls.map((c) => c.method)).toContain("egress.proveWindow");
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
        completeness: { tier: "authorized-actions", outboundEgressEvents: 0 },
        verify: { ok: true },
      },
    ]);
    wiredGateway(ipc.client.call);
    await runEgress(["--since", "24h", "--json"]);
    expect(ipc.calls[0]?.method).toBe("egress.proveWindow");
    const params = ipc.calls[0]?.params as { since?: number };
    expect(typeof params.since).toBe("number");
    expect(out.stdout).toContain('"tier": "authorized-actions"');
  });

  it("ignores --since when immediately followed by another flag", async () => {
    const ipc = createMockIpcClient([
      {
        rows: [],
        completeness: { tier: "authorized-actions", outboundEgressEvents: 0 },
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
        completeness: { tier: "authorized-actions", outboundEgressEvents: 0 },
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
