import { describe, expect, test } from "bun:test";
import { parseCostWasteArgs, runCostWasteWith } from "./cost-waste.ts";

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, s: { out: (x: string) => out.push(x), err: (x: string) => err.push(x) } };
}

const WASTE = {
  status: "waste",
  kind: null,
  lastSyncedMs: Date.UTC(2026, 10, 18, 6),
  counts: { recommendations: 3, waste: 2, notWaste: 1, noEstimate: 1 },
  byKind: [
    {
      kind: "unattached",
      count: 1,
      noEstimate: 0,
      totals: [{ currency: "USD", monthlySavings: 40, count: 1 }],
    },
    { kind: "idle", count: 1, noEstimate: 1, totals: [] },
  ],
  totals: [{ currency: "USD", monthlySavings: 40, count: 1 }],
  candidates: [
    {
      itemId: "i1",
      kind: "unattached",
      title: "Unattached volume ‮evil\u001B[31m",
      provider: "aws",
      cloudService: "EBS",
      accountId: "123",
      resourcesAffected: 2,
      estimatedMonthlySavings: 40,
      currency: "USD",
      documentationUrl: "https://example.com/doc",
    },
    {
      itemId: "i2",
      kind: "idle",
      title: "Idle instance",
      provider: null,
      cloudService: null,
      accountId: null,
      resourcesAffected: null,
      estimatedMonthlySavings: null,
      currency: null,
      documentationUrl: null,
    },
  ],
  candidatesTruncated: 4,
  gaps: ["heuristic"],
};

describe("parseCostWasteArgs", () => {
  test("accepts the flags in both forms", () => {
    expect(parseCostWasteArgs([])).toEqual({ json: false });
    expect(parseCostWasteArgs(["--json", "--service", "vantage", "--kind=idle"])).toEqual({
      json: true,
      service: "vantage",
      kind: "idle",
    });
  });

  test.each([
    [["--kind", "rightsizing"]],
    [["--kind"]],
    [["--service", "--json"]],
    [["--service", "a", "--service", "b"]],
    [["--days", "3"]],
    [["extra"]],
  ])("refuses %p", (argv) => {
    expect(parseCostWasteArgs(argv)).toBeUndefined();
  });
});

describe("runCostWasteWith", () => {
  test("renders waste with control characters stripped and exits 0", async () => {
    const k = sink();
    let seen: unknown;
    const code = await runCostWasteWith(
      {
        call: async (m, p) => {
          seen = [m, p];
          return WASTE;
        },
      },
      { json: false, service: "vantage", kind: "unattached" },
      k.s,
    );
    expect(code).toBe(0);
    expect(seen).toEqual(["cost.waste", { service: "vantage", kind: "unattached" }]);
    const text = k.out.join("");
    expect(text).toContain("3 recommendation(s) read: 2 waste, 1 other");
    expect(text).toContain("Estimated savings: 40.00 USD/month, plus 1 with no estimate.");
    expect(text).toContain("idle: 1 (1 with no estimate)");
    expect(text).toContain("unattached: 1 (40.00 USD/month)");
    expect(text).toContain("40.00 USD/month, 2 resource(s) (aws, EBS, account 123)");
    expect(text).toContain("docs: https://example.com/doc");
    expect(text).toContain("id: i1");
    expect(text).toContain("Candidates (by currency, largest saving first):");
    expect(text).toContain("[idle] Idle instance: no estimate");
    expect(text).toContain("... and 4 more");
    expect(text).toContain("Nothing was deleted or queued");
    expect(text).not.toContain("‮");
    expect(text).not.toContain("\u001B");
  });

  test("no_waste_found and a kind say so, and exit 0", async () => {
    const k = sink();
    const r = {
      ...WASTE,
      status: "no_waste_found",
      kind: "idle",
      candidates: [],
      byKind: [],
      totals: [],
    };
    expect(await runCostWasteWith({ call: async () => r }, { json: false }, k.s)).toBe(0);
    expect(k.out.join("")).toContain("No idle candidates among the vendor's recommendations.");
    const k2 = sink();
    await runCostWasteWith({ call: async () => ({ ...r, kind: null }) }, { json: false }, k2.s);
    expect(k2.out.join("")).toContain("No waste candidates among");
  });

  test("an over-long vendor string is cut", async () => {
    const k = sink();
    const long = "x".repeat(500);
    const r = { ...WASTE, candidates: [{ ...WASTE.candidates[1], title: long }] };
    await runCostWasteWith({ call: async () => r }, { json: false }, k.s);
    const text = k.out.join("");
    expect(text).toContain(`${"x".repeat(200)}...`);
    expect(text).not.toContain("x".repeat(201));
  });

  test("no_data goes to stderr and exits 1, in text and json", async () => {
    const r = { ...WASTE, status: "no_data", gaps: ["No cost recommendations are indexed."] };
    const k = sink();
    expect(await runCostWasteWith({ call: async () => r }, { json: false }, k.s)).toBe(1);
    expect(k.err.join("")).toContain("No cost recommendations are indexed.");
    const k2 = sink();
    expect(await runCostWasteWith({ call: async () => r }, { json: true }, k2.s)).toBe(1);
    expect(JSON.parse(k2.out.join("")).status).toBe("no_data");
  });

  test("json waste exits 0, and an error exits 1 in both modes", async () => {
    const k = sink();
    expect(await runCostWasteWith({ call: async () => WASTE }, { json: true }, k.s)).toBe(0);
    const fail = {
      call: async () => {
        throw new Error("gateway down");
      },
    };
    const k2 = sink();
    expect(await runCostWasteWith(fail, { json: true }, k2.s)).toBe(1);
    expect(JSON.parse(k2.out.join(""))).toEqual({ error: "gateway down" });
    const k3 = sink();
    expect(await runCostWasteWith(fail, { json: false }, k3.s)).toBe(1);
    expect(k3.err.join("")).toContain("gateway down");
  });

  test("a missing currency is named", async () => {
    const k = sink();
    const r = { ...WASTE, totals: [{ currency: null, monthlySavings: 5, count: 1 }] };
    await runCostWasteWith({ call: async () => r }, { json: false }, k.s);
    expect(k.out.join("")).toContain("5.00 (no currency)/month");
  });
});
