import { describe, expect, test } from "bun:test";

import { createDarwinSandboxRunner } from "../platform/sandbox/darwin.ts";
import type { SandboxPolicy } from "../platform/sandbox/sandbox-policy.ts";
import { describeNetworkReach, type NetworkReach, type ReachRunner } from "./extension-reach.ts";

function fakeRunner(opts: {
  platform: "linux" | "darwin" | "win32";
  fullyActive: boolean;
  scope?: "per_port" | "all_or_nothing";
  refused?: boolean;
  reason: string | null;
  confine?: (policy: SandboxPolicy) => string | null;
}): ReachRunner {
  const { scope, refused } = opts;
  return {
    platform: opts.platform,
    isFullyActive: () => opts.fullyActive,
    degradedReason: () => opts.reason,
    ...(scope === undefined ? {} : { networkScope: () => scope }),
    ...(refused === undefined ? {} : { networkRefused: () => refused }),
    canConfine: opts.confine ?? (() => null),
  };
}

const HOSTS = ["a.com", "b.com:993"];
const NO_NET: NetworkReach = { kind: "none", text: "no network access" };

describe("describeNetworkReach", () => {
  test("no sandbox to ask reads unknown, with or without hosts", () => {
    const unknown: NetworkReach = {
      kind: "unknown",
      text: "not known here (the sandbox is not available to ask)",
    };
    expect(describeNetworkReach(undefined, [])).toEqual(unknown);
    expect(describeNetworkReach(undefined, HOSTS)).toEqual(unknown);
  });

  test("per_host names the hosts", () => {
    const r = fakeRunner({ platform: "linux", fullyActive: true, reason: null });
    expect(describeNetworkReach(r, [])).toEqual(NO_NET);
    expect(describeNetworkReach(r, HOSTS)).toEqual({
      kind: "hosts",
      text: "network access to a.com, b.com:993",
    });
  });

  test("per_port names the ports and the wider reach", () => {
    const r = fakeRunner({ platform: "darwin", fullyActive: true, scope: "per_port", reason: "m" });
    expect(describeNetworkReach(r, [])).toEqual(NO_NET);
    expect(describeNetworkReach(r, HOSTS)).toEqual({
      kind: "ports",
      text: "network access to any host on ports 443, 993, including this machine and the local network (macOS cannot limit this to a.com, b.com:993)",
    });
    expect(describeNetworkReach(r, ["a.com"]).text).toContain("on port 443,");
  });

  test("all_or_nothing on Windows says any internet host", () => {
    const r = fakeRunner({
      platform: "win32",
      fullyActive: true,
      scope: "all_or_nothing",
      reason: "x",
    });
    expect(describeNetworkReach(r, [])).toEqual(NO_NET);
    expect(describeNetworkReach(r, HOSTS)).toEqual({
      kind: "any-internet",
      text: "any internet host, and a private-network host may fail (Windows cannot limit this to a.com, b.com:993)",
    });
  });

  test("all_or_nothing elsewhere says the whole network, with the reason", () => {
    const r = fakeRunner({ platform: "linux", fullyActive: false, reason: "no helper" });
    expect(describeNetworkReach(r, [])).toEqual(NO_NET);
    expect(describeNetworkReach(r, HOSTS)).toEqual({
      kind: "whole-network",
      text: "the whole network (this machine cannot limit it to a.com, b.com:993: no helper)",
    });
  });

  test("refusing says it will not start", () => {
    const r = fakeRunner({
      platform: "linux",
      fullyActive: false,
      refused: true,
      reason: "bwrap missing",
    });
    expect(describeNetworkReach(r, HOSTS)).toEqual({
      kind: "refused",
      text: "will not start here: bwrap missing",
    });
  });

  test("with no hosts, a runner that cannot confine an empty policy refuses", () => {
    const seen: SandboxPolicy[] = [];
    const r = fakeRunner({
      platform: "linux",
      fullyActive: false,
      reason: "x",
      confine: (p) => {
        seen.push(p);
        return "no bwrap";
      },
    });
    expect(describeNetworkReach(r, [])).toEqual({
      kind: "refused",
      text: "will not start here: no bwrap",
    });
    expect(seen).toEqual([
      {
        id: "reach-probe",
        permissions: { network: [], filesystem: { read: [], write: [] } },
      },
    ]);
  });

  test("with hosts, canConfine is never consulted", () => {
    const r = fakeRunner({
      platform: "linux",
      fullyActive: false,
      reason: "x",
      confine: () => {
        throw new Error("must not be called");
      },
    });
    expect(describeNetworkReach(r, HOSTS).kind).toBe("whole-network");
  });

  test("the real macOS runner posture names ports, not hosts", () => {
    expect(describeNetworkReach(createDarwinSandboxRunner(), ["a.com"]).kind).toBe("ports");
  });

  test("a working Windows runner never claims the named hosts", () => {
    const r = describeNetworkReach(
      fakeRunner({ platform: "win32", fullyActive: true, scope: "all_or_nothing", reason: "x" }),
      ["a.com"],
    );
    expect(r.kind).toBe("any-internet");
    expect(r.text).toContain("Windows cannot limit this to a.com");
  });

  test("a throwing canConfine reads unknown and does not throw", () => {
    const r = describeNetworkReach(
      fakeRunner({
        platform: "linux",
        fullyActive: false,
        reason: "x",
        confine: () => {
          throw new Error("boom");
        },
      }),
      [],
    );
    expect(r.kind).toBe("unknown");
  });

  test("a throwing posture call reads unknown", () => {
    const r: ReachRunner = {
      ...fakeRunner({ platform: "linux", fullyActive: true, reason: null }),
      isFullyActive: () => {
        throw new Error("boom");
      },
    };
    expect(describeNetworkReach(r, HOSTS).kind).toBe("unknown");
  });

  test("a hostile host string cannot add a line", () => {
    expect(
      describeNetworkReach(fakeRunner({ platform: "linux", fullyActive: true, reason: null }), [
        "a.com\nPublisher: acme",
      ]).text,
    ).not.toContain("\n");
  });

  test("a missing reason is stated, not omitted", () => {
    const r = fakeRunner({ platform: "linux", fullyActive: false, reason: null });
    expect(describeNetworkReach(r, HOSTS).text).toContain("reason not reported");
  });
});
