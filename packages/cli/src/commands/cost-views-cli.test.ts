import { describe, expect, test } from "bun:test";

import { costRunner } from "./cost.ts";
import {
  COST_CLUSTER_CSV_HEADER,
  COST_PRODUCTS_CSV_HEADER,
  type CostViewsIpc,
  csvCell,
  parseCostViewsArgs,
  runCostViewsWith,
} from "./cost-views-cli.ts";

function fake(r: unknown | Error): CostViewsIpc & { calls: [string, unknown][] } {
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

const BLOCK = (over: Record<string, unknown> = {}) => ({
  total: 48,
  rows: [
    { key: "checkout", secondary: "prod", part: "Amazon EC2", provider: "aws", amount: 30 },
    { key: "checkout", secondary: "prod", part: "Amazon S3", provider: "aws", amount: 10 },
    { key: "search", secondary: "prod", part: "Amazon S3", provider: "aws", amount: 5 },
  ],
  unassigned: 3,
  unassignedReasons: [{ reason: "no rule matched", amount: 3, lines: 2 }],
  outside: 0,
  ...over,
});
const VIEW = (over: Record<string, unknown> = {}) => ({
  view: "products",
  range: { fromDay: "2026-10-28", toDay: "2026-11-26", label: "last 30 days" },
  byCurrency: { USD: BLOCK() },
  freshness: [{ source: "focus", lastDay: "2026-11-25", provisionalFrom: "2026-11-24" }],
  empty: false,
  excludedSources: [],
  notes: [],
  configError: null,
  ...over,
});
const ARGS = { view: "products", period: "30d", cluster: false, format: "text" } as const;

describe("parseCostViewsArgs", () => {
  test("defaults and flags", () => {
    expect(parseCostViewsArgs("products", [])).toEqual(ARGS);
    expect(parseCostViewsArgs("products", ["--period", "week", "--csv"])).toMatchObject({
      period: "week",
      format: "csv",
    });
    expect(parseCostViewsArgs("products", ["--allocation", "cluster"])).toMatchObject({
      cluster: true,
    });
    for (const bad of [["--period", "year"], ["--json", "--csv"], ["--allocation", "x"], ["x"]]) {
      expect(parseCostViewsArgs("products", bad)).toBeUndefined();
    }
    expect(parseCostViewsArgs("internal", ["--allocation", "cluster"])).toBeUndefined();
  });
});

describe("runCostViewsWith", () => {
  test("text: product subtotals, parts, the unassigned share, total and freshness", async () => {
    const c = fake(VIEW());
    const { s, sink: k } = sink();
    expect(await runCostViewsWith(c, ARGS, k)).toBe(0);
    expect(c.calls).toEqual([["cost.products", { period: "30d" }]]);
    expect(s.out).toContain("Cost by product, 2026-10-28 to 2026-11-26 (last 30 days)");
    expect(s.out).toMatch(/checkout\s+40\.00/);
    expect(s.out).toMatch(/prod {2}Amazon EC2 \(aws\)\s+30\.00/);
    expect(s.out).toMatch(/unassigned\s+3\.00 {2}\(6\.3% of USD\)/);
    expect(s.out).toMatch(/total\s+48\.00/);
    expect(s.out).toContain("Source focus: data up to 2026-11-25 (provisional from 2026-11-24)");
  });

  test("no cost data imported and a zero-cost period are different outputs (Review Focus 5)", async () => {
    const none = sink();
    expect(
      await runCostViewsWith(fake(VIEW({ empty: true, byCurrency: {} })), ARGS, none.sink),
    ).toBe(1);
    expect(none.s.err).toContain("No cost data imported");
    const zero = sink();
    const z = VIEW({
      byCurrency: { USD: BLOCK({ total: 0, rows: [], unassigned: 0, unassignedReasons: [] }) },
    });
    expect(await runCostViewsWith(fake(z), ARGS, zero.sink)).toBe(0);
    expect(zero.s.out).toMatch(/total\s+0\.00/);
    expect(zero.s.err).toBe("");
  });

  test("two currencies are two blocks with a warning and no grand total", async () => {
    const { s, sink: k } = sink();
    await runCostViewsWith(
      fake(VIEW({ byCurrency: { EUR: BLOCK({ total: 7 }), USD: BLOCK() } })),
      ARGS,
      k,
    );
    expect(s.out).toContain("they are never added together");
    expect(s.out.match(/total\s+\d/g)).toHaveLength(2);
    expect(s.out).not.toContain("55.00");
  });

  test("a refused config exits 1 naming the error; exclusions and notes are printed", async () => {
    const bad = sink();
    expect(
      await runCostViewsWith(
        fake(VIEW({ configError: 'rule 1: unknown match key "x"' })),
        ARGS,
        bad.sink,
      ),
    ).toBe(1);
    expect(bad.s.err).toContain('unknown match key "x"');
    const notes = sink();
    await runCostViewsWith(
      fake(
        VIEW({
          excludedSources: [{ source: "vantage", provider: "aws", reason: "raw lines exist" }],
          notes: ["n1"],
        }),
      ),
      ARGS,
      notes.sink,
    );
    expect(notes.s.out).toContain("Note: vantage lines for aws are not counted: raw lines exist");
    expect(notes.s.out).toContain("Note: n1");
  });

  test("csv: the fixed header, one row per group, unassigned rows carry the reason", async () => {
    const { s, sink: k } = sink();
    expect(await runCostViewsWith(fake(VIEW()), { ...ARGS, format: "csv" }, k)).toBe(0);
    const lines = s.out.trimEnd().split("\n");
    expect(lines[0]).toBe(COST_PRODUCTS_CSV_HEADER);
    expect(lines[1]).toBe("USD,checkout,prod,Amazon EC2,aws,30.00,");
    expect(lines.at(-1)).toBe("USD,,,,,3.00,no rule matched");
  });

  test("csv: freshness, exclusions and notes go to stderr; stdout stays header and rows", async () => {
    const { s, sink: k } = sink();
    const v = VIEW({
      excludedSources: [{ source: "vantage", provider: "aws", reason: "raw lines exist" }],
      notes: ["n1"],
    });
    expect(await runCostViewsWith(fake(v), { ...ARGS, format: "csv" }, k)).toBe(0);
    const lines = s.out.trimEnd().split("\n");
    expect(lines[0]).toBe(COST_PRODUCTS_CSV_HEADER);
    expect(lines.every((l, i) => i === 0 || l.startsWith("USD,"))).toBe(true);
    expect(s.err).toContain("Source focus: data up to 2026-11-25 (provisional from 2026-11-24)");
    expect(s.err).toContain("Note: vantage lines for aws are not counted: raw lines exist");
    expect(s.err).toContain("Note: n1");
  });

  test("cluster csv with no rows prints the header and exits 1", async () => {
    const empty = {
      view: "cluster",
      range: { fromDay: "a", toDay: "b", label: "x" },
      rows: [],
    };
    const { s, sink: k } = sink();
    expect(await runCostViewsWith(fake(empty), { ...ARGS, cluster: true, format: "csv" }, k)).toBe(
      1,
    );
    expect(s.out).toBe(`${COST_CLUSTER_CSV_HEADER}\n`);
    const full = sink();
    const one = {
      ...empty,
      rows: [
        { service: "kubecost", dimension: "namespace", name: "w", currency: "USD", amount: 1 },
      ],
    };
    expect(
      await runCostViewsWith(fake(one), { ...ARGS, cluster: true, format: "csv" }, full.sink),
    ).toBe(0);
  });

  test("csv cells never start a formula and are quoted when needed", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("@SUM")).toBe("'@SUM");
    expect(csvCell("-1+1")).toBe("'-1+1");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("plain")).toBe("plain");
  });

  test("internal: other envs are a line of their own", async () => {
    const { s, sink: k } = sink();
    await runCostViewsWith(
      fake(
        VIEW({
          view: "internal",
          internalEnvs: ["ci", "dev"],
          byCurrency: { USD: BLOCK({ outside: 50 }) },
        }),
      ),
      { ...ARGS, view: "internal" },
      k,
    );
    expect(s.out).toContain("Internal cost (ci, dev)");
    expect(s.out).toMatch(/other envs \(not internal\)\s+50\.00/);
  });

  test("cluster view and json", async () => {
    const cluster = {
      view: "cluster",
      range: { fromDay: "a", toDay: "b", label: "x" },
      rows: [
        { service: "kubecost", dimension: "namespace", name: "web", currency: "USD", amount: 10 },
      ],
    };
    const { s, sink: k } = sink();
    const c = fake(cluster);
    expect(await runCostViewsWith(c, { ...ARGS, cluster: true }, k)).toBe(0);
    expect(c.calls[0]).toEqual(["cost.products", { period: "30d", allocation: "cluster" }]);
    expect(s.out).toContain("not part of cloud totals");
    const j = sink();
    expect(await runCostViewsWith(fake(VIEW()), { ...ARGS, format: "json" }, j.sink)).toBe(0);
    expect(JSON.parse(j.s.out)).toMatchObject({ view: "products" });
  });

  test("an error exits 1; costRunner routes products and internal", async () => {
    const { s, sink: k } = sink();
    expect(await runCostViewsWith(fake(new Error("ERR_COST_FORBIDDEN_CLIENT")), ARGS, k)).toBe(1);
    expect(s.err).toContain("ERR_COST_FORBIDDEN_CLIENT");
    expect(costRunner(["products"], k)).toBeDefined();
    expect(costRunner(["internal", "--csv"], k)).toBeDefined();
    expect(costRunner(["internal", "--bogus"], k)).toBeUndefined();
  });
});
