import { describe, expect, test } from "bun:test";

import type { IPCClient } from "../ipc-client/index.ts";
import { doctorTrustLines } from "./extension-doctor-format.ts";
import {
  formatTrustRefresh,
  formatTrustStatus,
  runTrust,
  type TrustCmdDeps,
  type TrustStatusView,
} from "./trust-cmd.ts";

const COUNTS = { revocations: 2, takedowns: 1, rotations: 0, verifiedPublishers: 3 };

const configured: TrustStatusView = {
  configured: true,
  url: "https://trust.example/",
  rootFingerprint: "ab".repeat(16),
  sequence: 12,
  lastFetchedAt: Date.UTC(2026, 9, 26),
  lastAttemptedAt: Date.UTC(2026, 9, 26),
  ageDays: 1,
  intervalHours: 1,
  counts: COUNTS,
};

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function harness(answers: Record<string, unknown>, maintainCode = 0) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  const maintained: string[][] = [];
  const client = {
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    call: (method: string) => {
      calls.push(method);
      return Promise.resolve(answers[method]);
    },
  } as unknown as IPCClient;
  const deps: TrustCmdDeps = {
    withGateway: (fn) => fn(client),
    maintain: (args) => {
      maintained.push(args);
      return Promise.resolve(maintainCode);
    },
    stdout: (s) => void out.push(s),
    stderr: (s) => void err.push(s),
    exit: (code) => {
      throw new Exit(code);
    },
  };
  return { deps, out, err, calls, maintained };
}

describe("runTrust maintain", () => {
  test("hands maintain's args over without touching the gateway; a failing code exits with it", async () => {
    const ok = harness({});
    await runTrust(["maintain", "plan", "./feed"], ok.deps);
    expect(ok.maintained).toEqual([["plan", "./feed"]]);
    expect(ok.calls).toEqual([]);
    const bad = harness({}, 2);
    await expect(runTrust(["maintain"], bad.deps)).rejects.toMatchObject({ code: 2 });
  });
});

describe("formatTrustStatus", () => {
  test("no feed configured says so and still reports stored statements", () => {
    const text = formatTrustStatus({
      ...configured,
      configured: false,
      url: null,
      rootFingerprint: null,
      sequence: null,
    });
    expect(text).toContain("No trust feed is configured in this build.");
    expect(text).toContain("revocations 2, takedowns 1");
  });

  test("a configured feed shows url, fingerprint, sequence and age", () => {
    const text = formatTrustStatus(configured);
    expect(text).toContain("Trust feed: https://trust.example/");
    expect(text).toContain(`Root fingerprint: ${"ab".repeat(16)}`);
    expect(text).toContain("Sequence: 12");
    expect(text).toContain("(1 day ago)");
    expect(text).toContain("verified publishers 3");
  });

  test("unknown fields read as '?', plural ages, and no sequence yet", () => {
    const text = formatTrustStatus({
      ...configured,
      url: null,
      rootFingerprint: null,
      sequence: null,
      lastFetchedAt: null,
      ageDays: 3,
      intervalHours: null,
    });
    expect(text).toContain("Trust feed: ?");
    expect(text).toContain("Root fingerprint: ?");
    expect(text).toContain("Sequence: none accepted yet");
    expect(text).toContain("Last updated: never (3 days ago)");
    expect(text).toContain("Checked every: ?");
    const noAge = formatTrustStatus({ ...configured, ageDays: null });
    expect(noAge).not.toContain("ago");
  });
});

describe("formatTrustRefresh", () => {
  test("each outcome reads plainly", () => {
    expect(formatTrustRefresh({ status: "accepted", sequence: 4, verified: 1 })).toContain(
      "updated to sequence 4",
    );
    expect(formatTrustRefresh({ status: "unchanged", sequence: 4 })).toContain("unchanged");
    expect(formatTrustRefresh({ status: "not_configured" })).toContain("No trust feed");
    expect(
      formatTrustRefresh({ status: "refused", code: "ERR_TRUST_FEED_ROLLBACK", detail: "older" }),
    ).toContain("ERR_TRUST_FEED_ROLLBACK: older");
  });
});

describe("runTrust", () => {
  test("status calls trust.status and prints it; --json prints JSON", async () => {
    const h = harness({ "trust.status": configured });
    await runTrust(["status"], h.deps);
    expect(h.calls).toEqual(["trust.status"]);
    expect(h.out.join("")).toContain("Sequence: 12");
    const j = harness({ "trust.status": configured });
    await runTrust(["status", "--json"], j.deps);
    expect(JSON.parse(j.out.join(""))).toEqual(configured);
  });

  test("a refused refresh exits 1", async () => {
    const h = harness({ "trust.refresh": { status: "refused", code: "X", detail: "y" } });
    await expect(runTrust(["refresh"], h.deps)).rejects.toEqual(new Exit(1));
  });

  test("refresh --json prints the result as JSON", async () => {
    const r = { status: "accepted", sequence: 5, verified: 0 };
    const h = harness({ "trust.refresh": r });
    await runTrust(["refresh", "--json"], h.deps);
    expect(JSON.parse(h.out.join(""))).toEqual(r);
  });

  test("an unchanged refresh exits 0", async () => {
    const h = harness({ "trust.refresh": { status: "unchanged", sequence: 2 } });
    await runTrust(["refresh"], h.deps);
    expect(h.out.join("")).toContain("unchanged");
  });

  test("an unknown subcommand or flag prints usage and exits 2 without a gateway", async () => {
    for (const args of [[], ["nope"], ["status", "--yes"]]) {
      const h = harness({});
      await expect(runTrust(args, h.deps)).rejects.toEqual(new Exit(2));
      expect(h.err.join("")).toContain("nimbus trust status");
      expect(h.calls).toEqual([]);
    }
  });

  test("a gateway error propagates", async () => {
    const h = harness({});
    const deps: TrustCmdDeps = {
      ...h.deps,
      withGateway: () => Promise.reject(new Error("gateway is not running")),
    };
    await expect(runTrust(["status"], deps)).rejects.toThrow("gateway is not running");
  });
});

describe("doctorTrustLines", () => {
  test("silent with no feed configured, or a fresh one", () => {
    expect(doctorTrustLines({ configured: false, ageDays: null })).toEqual({ lines: [], exit: 0 });
    expect(doctorTrustLines({ configured: true, ageDays: 7 })).toEqual({ lines: [], exit: 0 });
  });

  test("warns past 7 days, and when a configured feed was attempted but never fetched", () => {
    const stale = doctorTrustLines({ configured: true, ageDays: 8 });
    expect(stale.exit).toBe(1);
    expect(stale.lines[0]).toContain("last updated 8 days ago");
    const never = doctorTrustLines({ configured: true, ageDays: null, lastAttemptedAt: 1_000 });
    expect(never.exit).toBe(1);
    expect(never.lines[0]).toContain("never fetched");
  });

  test("a feed not attempted yet (a gateway that just started) is informational, not a warning", () => {
    const fresh = doctorTrustLines({ configured: true, ageDays: null, lastAttemptedAt: null });
    expect(fresh.exit).toBe(0);
    expect(fresh.lines[0]).toStartWith("[info] Trust feed: not fetched yet");
  });

  test("garbage is silent rather than a crash", () => {
    expect(doctorTrustLines("x")).toEqual({ lines: [], exit: 0 });
  });
});
