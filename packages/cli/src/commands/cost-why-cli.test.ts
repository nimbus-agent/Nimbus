import { describe, expect, test } from "bun:test";

import { costRunner } from "./cost.ts";
import { type CostWhyIpc, parseCostWhyArgs, runCostWhyWith } from "./cost-why-cli.ts";

function fake(r: unknown): CostWhyIpc & { calls: [string, unknown][] } {
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

const SPIKE_MS = Date.UTC(2026, 10, 25, 14, 3);

const WHY = {
  empty: false,
  target: { kind: "product", name: "checkout" },
  range: { fromDay: "2026-11-13", toDay: "2026-11-26", label: "last 14 days" },
  previous: { fromDay: "2026-10-30", toDay: "2026-11-12", label: "the 14 days before" },
  byCurrency: {
    EUR: {
      current: 9,
      previous: 0,
      change: 9,
      changePct: null,
      spikeDay: null,
      movers: [],
      moversTruncated: 0,
    },
    USD: {
      current: 290,
      previous: 210,
      change: 80,
      changePct: 38.0952,
      spikeDay: "2026-11-25",
      movers: [
        {
          service: "payment-service",
          part: "Amazon EC2",
          provider: "aws",
          current: 220,
          previous: 140,
          change: 80,
        },
        {
          service: null,
          part: `x${"y".repeat(300)}\u001b[31m`,
          provider: "aws",
          current: 1,
          previous: 2,
          change: -1,
        },
      ],
      moversTruncated: 2,
    },
  },
  services: ["payment-service", "orders-service"],
  provisionalFrom: "2026-11-24",
  freshness: [{ source: "focus", lastDay: "2026-11-26", provisionalFrom: "2026-11-24" }],
  excludedSources: [],
  notes: [],
  context: [
    {
      serviceId: "payment-service",
      configured: true,
      deploys: [
        {
          sha: "4f1c2a9e8b7d6c5b4a39",
          environment: "prod",
          startedAtMs: SPIKE_MS - 600_000,
          finishedAtMs: SPIKE_MS,
          conclusion: "success",
          url: null,
          runId: "7412",
          nearSpike: true,
          pr: {
            repo: "acme/payments",
            number: 412,
            title: "Raise the pool",
            url: null,
            author: "Dana Diaz",
          },
        },
        {
          sha: "abc",
          environment: "prod",
          startedAtMs: SPIKE_MS - 9 * 86_400_000,
          finishedAtMs: null,
          conclusion: "failure",
          url: null,
          runId: null,
          nearSpike: false,
          pr: null,
        },
      ],
      deploysTruncated: 1,
      owners: [{ label: "Dana Diaz", share: 0.6, resolved: true }],
      gaps: [],
    },
    {
      serviceId: "orders-service",
      configured: false,
      deploys: [],
      deploysTruncated: 0,
      owners: [],
      gaps: ["service orders-service is not configured ([ci.service.orders-service])"],
    },
  ],
};

describe("parseCostWhyArgs", () => {
  test("a target, an optional period and --json", () => {
    expect(parseCostWhyArgs(["checkout"])).toEqual({
      target: "checkout",
      period: "14d",
      json: false,
    });
    expect(parseCostWhyArgs(["checkout", "--period", "month", "--json"])).toEqual({
      target: "checkout",
      period: "month",
      json: true,
    });
  });

  test("usage errors", () => {
    for (const argv of [
      [],
      ["--json"],
      ["a", "b"],
      ["a", "--period"],
      ["a", "--period", "9y"],
      ["a", "--csv"],
    ]) {
      expect(parseCostWhyArgs(argv)).toBeUndefined();
    }
  });

  test("routed from nimbus cost why", () => {
    expect(costRunner(["why", "checkout"], sink().sink)).toBeFunction();
    expect(costRunner(["why"], sink().sink)).toBeUndefined();
  });
});

describe("runCostWhyWith", () => {
  test("renders the comparison, the spike, the movers, the deploys, the owners and the gaps", async () => {
    const ipc = fake(WHY);
    const { s, sink: k } = sink();
    expect(await runCostWhyWith(ipc, { target: "checkout", period: "14d", json: false }, k)).toBe(
      0,
    );
    expect(ipc.calls).toEqual([["cost.why", { target: "checkout", period: "14d" }]]);
    const o = s.out;
    expect(o).toContain(
      "Why the cost of product checkout changed: 2026-11-13 to 2026-11-26 (last 14 days)",
    );
    expect(o).toContain("compared with 2026-10-30 to 2026-11-12 (the 14 days before)");
    expect(o).toContain(
      "Several currencies: each is compared on its own; they are never added together.",
    );
    expect(o).toContain("EUR  9.00 vs 0.00  +9.00 (new)");
    expect(o).toContain("USD  290.00 vs 210.00  +80.00 (+38.1%)");
    expect(o).toContain("Spike day: 2026-11-25");
    expect(o).toMatch(/payment-service {2}Amazon EC2 \(aws\)\s+220\.00 vs 140\.00\s+\+80\.00/);
    expect(o).toContain("... and 2 more");
    expect(o).not.toContain("\u001b");
    expect(o).not.toContain("y".repeat(201));
    expect(o).toContain("payment-service");
    expect(o).toContain(
      "2026-11-25 14:03 UTC  prod  success  4f1c2a9e8b7d  run 7412  near the spike",
    );
    expect(o).toContain("acme/payments#412 Raise the pool (Dana Diaz)");
    expect(o).toContain("failure  abc");
    expect(o).toContain("... and 1 more deploy");
    expect(o).toContain("Owners (from git blame, who wrote it): Dana Diaz 60%");
    expect(o).toContain(
      "Gap: service orders-service is not configured ([ci.service.orders-service])",
    );
    expect(o).toContain("The days from 2026-11-24 are provisional");
    expect(o).toContain("Source focus: data up to 2026-11-26");
  });

  test("--json prints the result as is", async () => {
    const { s, sink: k } = sink();
    expect(
      await runCostWhyWith(fake(WHY), { target: "checkout", period: "14d", json: true }, k),
    ).toBe(0);
    expect(JSON.parse(s.out)).toEqual(WHY);
  });

  test("no cost data imported exits 1", async () => {
    const empty = { empty: true, range: WHY.range, previous: WHY.previous, context: [] };
    const { s, sink: k } = sink();
    expect(
      await runCostWhyWith(fake(empty), { target: "checkout", period: "14d", json: false }, k),
    ).toBe(1);
    expect(s.err).toContain("No cost data imported");
    const j = sink();
    expect(
      await runCostWhyWith(fake(empty), { target: "checkout", period: "14d", json: true }, j.sink),
    ).toBe(1);
  });

  test("an unknown target (an IPC error naming the known names) exits 1", async () => {
    const { s, sink: k } = sink();
    const e = new Error(
      'cost.why: no product or service named "nope" (products: checkout; services: none)',
    );
    expect(await runCostWhyWith(fake(e), { target: "nope", period: "14d", json: false }, k)).toBe(
      1,
    );
    expect(s.err).toContain("products: checkout");
  });
});
