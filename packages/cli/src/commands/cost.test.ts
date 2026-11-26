import { describe, expect, test } from "bun:test";

import { CliExit } from "../lib/cli-exit.ts";
import {
  COST_USAGE,
  type CostIpc,
  costRunner,
  parseCostAnomaliesArgs,
  runCostAnomaliesWith,
  runCostCommand,
} from "./cost.ts";

function fake(r: unknown | Error): CostIpc & { calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  return {
    calls,
    async call(method, params) {
      calls.push([method, params]);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

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

const DAY = Date.UTC(2026, 10, 8);
const BASE = {
  status: "anomalies",
  asOfMs: Date.UTC(2026, 10, 12),
  service: null,
  judgedDayMs: DAY,
  daysChecked: 1,
  baseline: { days: 7, minDays: 5 },
  thresholds: { ratio: 1.5, minAmount: 10 },
  counts: {
    series: 3,
    judged: 2,
    anomalies: 1,
    insufficientHistory: 1,
    noDayData: 0,
    mixedCurrency: 0,
  },
  anomalies: [
    {
      seriesKey: "vantage|default|service||EC2",
      name: "EC2\u001b[31m",
      dayMs: DAY,
      amount: 100,
      baselineMean: 10,
      baselineDays: 7,
      ratio: 10,
      excess: 90,
      currency: "USD",
    },
  ],
  anomaliesTruncated: 0,
  gaps: ["1 check(s) skipped: fewer than 5 complete days."],
};

describe("parseCostAnomaliesArgs", () => {
  test("accepted shapes", () => {
    expect(parseCostAnomaliesArgs([])).toEqual({ json: false });
    expect(parseCostAnomaliesArgs(["--json", "--days", "7", "--service", "vantage"])).toEqual({
      json: true,
      days: 7,
      service: "vantage",
    });
    expect(parseCostAnomaliesArgs(["--days=30", "--service=vantage"])).toEqual({
      json: false,
      days: 30,
      service: "vantage",
    });
  });

  test("everything else is refused", () => {
    for (const bad of [
      ["--bogus"],
      ["positional"],
      ["--days"],
      ["--days", "0"],
      ["--days", "31"],
      ["--days", "1.5"],
      ["--days", "-1"],
      ["--days", "a"],
      ["--days=1", "--days=2"],
      ["--service"],
      ["--service", "--json"],
      ["--service=a", "--service=b"],
    ]) {
      expect(parseCostAnomaliesArgs(bad)).toBeUndefined();
    }
  });
});

describe("runCostAnomaliesWith text output", () => {
  test("anomalies: names the judged day, the baseline, the rule and the counts; exit 0", async () => {
    const c = fake(BASE);
    const { s, sink: k } = sink();
    expect(await runCostAnomaliesWith(c, { json: false, days: 1 }, k)).toBe(0);
    expect(c.calls).toEqual([["cost.anomalies", { days: 1 }]]);
    expect(s.out).toContain("Judged day: 2026-11-08 (UTC, complete days only)");
    expect(s.out).toContain("mean of the 7 days before it");
    expect(s.out).toContain("at least 1.5x its baseline AND exceeds it by at least 10");
    expect(s.out).toContain(
      "2026-11-08  EC2[31m: 100.00 USD vs 10.00 USD baseline over 7 days (10.00x, +90.00 USD)",
    );
    expect(s.out).not.toContain("\u001b");
    expect(s.out).toContain("3 series, 2 checked, 1 anomalous; skipped: 1 for lack of history");
    expect(s.out).toContain("Note: 1 check(s) skipped");
  });

  test("a multi-day window and a zero baseline are rendered", async () => {
    const r = {
      ...BASE,
      daysChecked: 3,
      anomaliesTruncated: 4,
      anomalies: [{ ...BASE.anomalies[0], ratio: null, currency: null }],
    };
    const { s, sink: k } = sink();
    expect(await runCostAnomaliesWith(fake(r), { json: false }, k)).toBe(0);
    expect(s.out).toContain("Judged days: 2026-11-06 to 2026-11-08");
    expect(s.out).toContain("baseline not positive");
    expect(s.out).toContain("and 4 more");
  });

  test("ok: says there are no anomalies, exit 0", async () => {
    const { s, sink: k } = sink();
    const r = { ...BASE, status: "ok", anomalies: [] };
    expect(await runCostAnomaliesWith(fake(r), { json: false }, k)).toBe(0);
    expect(s.out).toContain("No anomalies.");
  });

  test("no_data: the gap on stderr, nothing on stdout, exit 1", async () => {
    const { s, sink: k } = sink();
    const r = { ...BASE, status: "no_data", judgedDayMs: null, gaps: ["No cost data is indexed."] };
    expect(await runCostAnomaliesWith(fake(r), { json: false }, k)).toBe(1);
    expect(s.out).toBe("");
    expect(s.err).toContain("No cost data is indexed.");
  });

  test("insufficient_history is not 'no anomalies': it says so on stderr, exit 1", async () => {
    const { s, sink: k } = sink();
    const r = { ...BASE, status: "insufficient_history", anomalies: [] };
    expect(await runCostAnomaliesWith(fake(r), { json: false }, k)).toBe(1);
    expect(s.out).toBe("");
    expect(s.err).toContain("Not enough history");
    expect(s.err).toContain("none can be ruled out");
    expect(s.err).not.toContain("No anomalies");
  });
});

describe("runCostAnomaliesWith json and errors", () => {
  test("json prints the result and maps status to the exit code", async () => {
    for (const [status, code] of [
      ["ok", 0],
      ["anomalies", 0],
      ["no_data", 1],
      ["insufficient_history", 1],
    ] as const) {
      const { s, sink: k } = sink();
      expect(await runCostAnomaliesWith(fake({ ...BASE, status }), { json: true }, k)).toBe(code);
      expect(JSON.parse(s.out).status).toBe(status);
    }
  });

  test("a gateway error is exit 1, as text or as json", async () => {
    const a = sink();
    expect(
      await runCostAnomaliesWith(fake(new Error("boom\u001b[1m")), { json: false }, a.sink),
    ).toBe(1);
    expect(a.s.err).toBe("boom[1m\n");
    const b = sink();
    expect(await runCostAnomaliesWith(fake(new Error("boom")), { json: true }, b.sink)).toBe(1);
    expect(JSON.parse(b.s.out)).toEqual({ error: "boom" });
  });

  test("service is passed through to the method", async () => {
    const c = fake({ ...BASE, status: "ok", anomalies: [] });
    await runCostAnomaliesWith(c, { json: false, service: "vantage" }, sink().sink);
    expect(c.calls[0]).toEqual(["cost.anomalies", { service: "vantage" }]);
  });
});

describe("runCostCommand", () => {
  test("a bad subcommand or flag prints usage and exits 1", async () => {
    for (const argv of [[], ["bogus"], ["anomalies", "--nope"], ["waste", "--kind", "nope"]]) {
      const err = await runCostCommand(argv).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliExit);
      expect((err as CliExit).code).toBe(1);
    }
    expect(COST_USAGE).toContain("nimbus cost anomalies");
    expect(COST_USAGE).toContain("nimbus cost waste");
  });
});

describe("costRunner", () => {
  test("routes anomalies and waste to their own IPC methods, and refuses the rest", async () => {
    const out: string[] = [];
    const sink = { out: (x: string) => out.push(x), err: (x: string) => out.push(x) };
    const seen: string[] = [];
    const ipc: CostIpc = {
      call: async (m: string) => {
        seen.push(m);
        throw new Error("stop");
      },
    };
    for (const argv of [["anomalies"], ["waste", "--kind", "idle"]]) {
      const run = costRunner(argv, sink);
      expect(run).toBeDefined();
      expect(await run?.(ipc)).toBe(1);
    }
    expect(seen.filter((m) => m !== "session.declareKind")).toEqual([
      "cost.anomalies",
      "cost.waste",
    ]);
    expect(costRunner(["waste", "--kind", "nope"], sink)).toBeUndefined();
    expect(costRunner(["nope"], sink)).toBeUndefined();
  });

  test("every subcommand first declares the cli kind, then calls its cost method", async () => {
    const sink = { out: () => undefined, err: () => undefined };
    for (const [argv, method] of [
      [["anomalies"], "cost.anomalies"],
      [["waste"], "cost.waste"],
      [["products"], "cost.products"],
      [["internal", "--csv"], "cost.internal"],
      [["import", "/exports/a.csv"], "cost.import"],
      [["import", "--remove", "focus:0123456789abcdef"], "cost.importRemove"],
      [["why", "checkout"], "cost.why"],
      [["rules", "check"], "cost.rulesCheck"],
    ] as const) {
      const calls: [string, unknown][] = [];
      const ipc: CostIpc = {
        call: async (m: string, p?: unknown) => {
          calls.push([m, p]);
          if (m === "session.declareKind") return { kind: "cli" };
          throw new Error("stop");
        },
      };
      await costRunner([...argv], sink)?.(ipc);
      expect(
        calls.map(([m]) => m),
        method,
      ).toEqual(["session.declareKind", method]);
      expect(calls[0]?.[1]).toEqual({ kind: "cli" });
    }
  });

  test("an older gateway without session.declareKind still runs the command", async () => {
    const seen: string[] = [];
    const ipc: CostIpc = {
      call: async (m: string) => {
        seen.push(m);
        if (m === "session.declareKind") throw new Error("Method not found");
        return { status: "no_data", gaps: ["none"] };
      },
    };
    const sink = { out: () => undefined, err: () => undefined };
    expect(await costRunner(["anomalies"], sink)?.(ipc)).toBe(1);
    expect(seen).toEqual(["session.declareKind", "cost.anomalies"]);
  });
});
