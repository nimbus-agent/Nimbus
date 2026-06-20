import { describe, expect, test } from "bun:test";
import { parseSinceDurationToMs } from "../lib/parse-since.ts";
import { resolvePruneBeforeTs, runEgressReport, runEgressVerify } from "./prove.ts";

type Call = { method: string; params: unknown };

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
});

describe("runEgressReport", () => {
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
    expect((c.calls[0]?.params as { sign?: boolean }).sign).toBe(true);
  });

  test("a degraded (unverifiable) chain prints indeterminate and exits non-zero", async () => {
    process.exitCode = 0;
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
    process.exitCode = 0;
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
  test("passing BOTH --before and --older-than is rejected", () => {
    expect(() => resolvePruneBeforeTs(["--before", "1700", "--older-than", "30d"], NOW)).toThrow(
      /not both/,
    );
  });
  test("neither form present is rejected", () => {
    expect(() => resolvePruneBeforeTs([], NOW)).toThrow(/--before|--older-than/);
  });
});
