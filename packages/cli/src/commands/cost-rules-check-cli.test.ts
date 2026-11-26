import { describe, expect, test } from "bun:test";

import { costRunner } from "./cost.ts";
import { parseCostRulesCheckArgs, runCostRulesCheckWith } from "./cost-rules-check-cli.ts";

function sink() {
  const s = { out: "", err: "" };
  return {
    s,
    sink: {
      out: (x: string) => {
        s.out += x;
      },
      err: (x: string) => {
        s.err += x;
      },
    },
  };
}

const fake = (r: unknown) => {
  const calls: [string, unknown][] = [];
  return {
    calls,
    async call(method: string, params?: unknown) {
      calls.push([method, params]);
      if (r instanceof Error) throw r;
      return r;
    },
  };
};

const CHECK = {
  empty: false,
  range: { fromDay: "2026-10-28", toDay: "2026-11-26", label: "last 30 days" },
  configError: null,
  byCurrency: {
    EUR: { total: 5, unassigned: 5, unassignedPct: 100 },
    USD: { total: 25, unassigned: 9, unassignedPct: 36 },
  },
  rules: [
    { index: 1, lines: 2, amountByCurrency: { USD: 14 }, unassignedLines: 1 },
    { index: 2, lines: 0, amountByCurrency: {}, unassignedLines: 0 },
  ],
  unusedRules: [2],
  topUnassigned: [
    {
      provider: "aws",
      service: "Amazon EC2",
      subAccount: "acct-1",
      tagKeys: ["owner", "team"],
      lines: 2,
      amountByCurrency: { USD: 5 },
      reason: "no rule matched",
    },
    {
      provider: "azure",
      service: "Azure VM",
      subAccount: null,
      tagKeys: [],
      lines: 1,
      amountByCurrency: { EUR: 5 },
      reason: "no rule matched",
    },
  ],
  topUnassignedTruncated: 4,
  freshness: [{ source: "focus", lastDay: "2026-11-26", provisionalFrom: "2026-11-24" }],
};

describe("parseCostRulesCheckArgs", () => {
  test("nimbus cost rules check [--period] [--json]", () => {
    expect(parseCostRulesCheckArgs(["check"])).toEqual({ period: "30d", json: false });
    expect(parseCostRulesCheckArgs(["check", "--period", "7d", "--json"])).toEqual({
      period: "7d",
      json: true,
    });
    for (const argv of [
      [],
      ["list"],
      ["check", "--period"],
      ["check", "--period", "x"],
      ["check", "extra"],
    ]) {
      expect(parseCostRulesCheckArgs(argv)).toBeUndefined();
    }
    expect(costRunner(["rules", "check"], sink().sink)).toBeFunction();
    expect(costRunner(["rules"], sink().sink)).toBeUndefined();
  });
});

describe("runCostRulesCheckWith", () => {
  test("renders the unassigned share, the rule counts, unused rules and the largest groups", async () => {
    const ipc = fake(CHECK);
    const { s, sink: k } = sink();
    expect(await runCostRulesCheckWith(ipc, { period: "30d", json: false }, k)).toBe(0);
    expect(ipc.calls).toEqual([["cost.rulesCheck", { period: "30d" }]]);
    const o = s.out;
    expect(o).toContain("Cost rules check, 2026-10-28 to 2026-11-26 (last 30 days)");
    expect(o).toContain("EUR  5.00 of 5.00 unassigned (100.0%)");
    expect(o).toContain("USD  9.00 of 25.00 unassigned (36.0%)");
    expect(o).toContain("rule 1: 2 lines (USD 14.00), 1 matched but its value was refused");
    expect(o).toContain("rule 2: matched nothing");
    expect(o).toContain(
      "aws Amazon EC2, sub-account acct-1, tags owner, team: 2 lines (USD 5.00): no rule matched",
    );
    expect(o).toContain("azure Azure VM, no tags: 1 line (EUR 5.00): no rule matched");
    expect(o).toContain("... and 4 more groups");
    expect(o).toContain("Source focus: data up to 2026-11-26 (provisional from 2026-11-24)");
  });

  test("a refused config, no data and an error exit 1; --json prints the result", async () => {
    const refused = sink();
    expect(
      await runCostRulesCheckWith(
        fake({ ...CHECK, configError: "bad key" }),
        { period: "30d", json: false },
        refused.sink,
      ),
    ).toBe(1);
    expect(refused.s.err).toContain("bad key");
    const empty = sink();
    expect(
      await runCostRulesCheckWith(
        fake({ ...CHECK, empty: true }),
        { period: "30d", json: false },
        empty.sink,
      ),
    ).toBe(1);
    expect(empty.s.err).toContain("No cost data imported");
    const err = sink();
    expect(
      await runCostRulesCheckWith(
        fake(new Error("boom")),
        { period: "30d", json: false },
        err.sink,
      ),
    ).toBe(1);
    const j = sink();
    expect(await runCostRulesCheckWith(fake(CHECK), { period: "30d", json: true }, j.sink)).toBe(0);
    expect(JSON.parse(j.s.out)).toEqual(CHECK);
  });
});

describe("runCostRulesCheckWith: the quiet and the failing cases", () => {
  const QUIET = {
    ...CHECK,
    byCurrency: { USD: { total: 0, unassigned: 0, unassignedPct: null } },
    rules: [{ index: 1, lines: 3, amountByCurrency: { USD: 0 }, unassignedLines: 0 }],
    unusedRules: [],
    topUnassigned: [
      {
        provider: "gcp",
        service: "Compute Engine",
        subAccount: null,
        tagKeys: [],
        lines: 1,
        amountByCurrency: { USD: 0 },
        reason: "no rule matched",
      },
    ],
    topUnassignedTruncated: 0,
    freshness: [{ source: "focus", lastDay: null, provisionalFrom: null }],
  };

  test("no share for a zero total, no refusal note, no more-groups line, no data day", async () => {
    const { s, sink: k } = sink();
    expect(await runCostRulesCheckWith(fake(QUIET), { period: "30d", json: false }, k)).toBe(0);
    expect(s.out).toContain("USD  0.00 of 0.00 unassigned\n");
    expect(s.out).toContain("  rule 1: 3 lines (USD 0.00)\n");
    expect(s.out).not.toContain("refused");
    expect(s.out).toContain("Largest unassigned groups:\n");
    expect(s.out).not.toContain("more group");
    expect(s.out).toContain("Source focus: data up to none\n");
    expect(s.out).not.toContain("provisional");
  });

  test("with no unassigned group the groups heading is not printed", async () => {
    const { s, sink: k } = sink();
    const none = { ...QUIET, topUnassigned: [] };
    expect(await runCostRulesCheckWith(fake(none), { period: "30d", json: false }, k)).toBe(0);
    expect(s.out).not.toContain("Largest unassigned groups");
  });

  test("--json exits 1 for no data and for a refused config", async () => {
    for (const r of [
      { ...QUIET, empty: true },
      { ...QUIET, configError: "rule 1: unknown match key" },
    ]) {
      const { s, sink: k } = sink();
      expect(await runCostRulesCheckWith(fake(r), { period: "30d", json: true }, k)).toBe(1);
      expect(JSON.parse(s.out)).toEqual(r);
    }
  });

  test("a non-Error rejection is still reported and exits 1", async () => {
    const { s, sink: k } = sink();
    const ipc = { call: (): Promise<unknown> => Promise.reject("socket closed") };
    expect(await runCostRulesCheckWith(ipc, { period: "30d", json: false }, k)).toBe(1);
    expect(s.err).toBe("nimbus cost rules check: socket closed\n");
  });
});
