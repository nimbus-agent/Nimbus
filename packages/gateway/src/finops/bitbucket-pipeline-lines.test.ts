import { describe, expect, test } from "bun:test";

import { bitbucketPipelineLines } from "./bitbucket-pipeline-lines.ts";
import { tagOf } from "./cost-line.ts";
import type { CostRates } from "./cost-rate-price.ts";

const NO_RATE: CostRates = { ratePerMinute: null, currency: "USD", keyedRates: [] };
const CENT: CostRates = { ratePerMinute: 0.01, currency: "USD", keyedRates: [] };

/** A documentation-shaped pipeline (`GET /2.0/repositories/{workspace}/{repo}/pipelines`). */
const pipe = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  uuid: "{p-1}",
  build_number: 1,
  state: { name: "COMPLETED" },
  created_on: "2026-11-02T09:00:00.000000+00:00",
  completed_on: "2026-11-02T10:00:00.000000+00:00",
  build_seconds_used: 120,
  ...over,
});
const repo = (pipelines: unknown[], over: Record<string, string> = {}) => ({
  repoUuid: "{r-1}",
  fullName: "acme/web",
  pipelines,
  ...over,
});

describe("bitbucketPipelineLines", () => {
  test("two pipelines on one day are summed into one line, with the repository identity and the minutes", () => {
    const r = bitbucketPipelineLines(
      "acme",
      "2026-11",
      [repo([pipe(), pipe({ uuid: "{p-2}", build_seconds_used: 60 })])],
      CENT,
    );
    expect(r.pipelines).toBe(2);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({
      source: "bitbucket_billing",
      provider: "bitbucket",
      billingAccountId: "acme",
      subAccountId: "{r-1}",
      subAccountName: "acme/web",
      repo: "acme/web",
      serviceName: "Bitbucket Pipelines",
      skuId: "pipeline_minutes",
      consumedUnit: "minute",
      consumedQuantity: 3,
      chargeDay: "2026-11-02",
      billedCost: 0.03,
      priced: true,
    });
    expect(tagOf(r.lines[0]?.tags ?? {}, "rate_key")).toBe("default");
  });

  test("a repeated uuid (the same pipeline on two pages, or two repositories) counts once", () => {
    const r = bitbucketPipelineLines(
      "acme",
      "2026-11",
      [repo([pipe(), pipe()]), repo([pipe()], { repoUuid: "{r-2}", fullName: "acme/api" })],
      CENT,
    );
    expect(r.pipelines).toBe(1);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]?.consumedQuantity).toBe(2);
  });

  test("each drop reason is counted, never thrown", () => {
    const r = bitbucketPipelineLines(
      "acme",
      "2026-11",
      [
        repo([
          pipe({ uuid: "{a}", completed_on: null }),
          pipe({ uuid: "{b}", build_seconds_used: -1 }),
          pipe({ uuid: "{c}", build_seconds_used: Number.NaN }),
          pipe({ uuid: "{d}", build_seconds_used: "9" }),
          pipe({ uuid: "{e}", completed_on: "2026-10-31T23:59:00+00:00" }),
          pipe({ uuid: "{f}", completed_on: "2026-11-20T10:00:00+00:00" }),
          pipe({ uuid: "{g}" }),
          "not an object",
          pipe({ uuid: undefined }),
        ]),
      ],
      CENT,
      "2026-11-10",
    );
    expect(r.dropped).toEqual({
      unfinished: 1,
      bad_seconds: 5,
      outside_month: 2,
      self_hosted: 0,
    });
    expect(r.pipelines).toBe(1);
  });

  test("the day is the UTC day of completed_on, whatever the offset", () => {
    const r = bitbucketPipelineLines(
      "acme",
      "2026-11",
      [repo([pipe({ completed_on: "2026-11-02T23:30:00-02:00" })])],
      CENT,
    );
    expect(r.lines[0]?.chargeDay).toBe("2026-11-03");
  });

  test("no rate is an unpriced line with the minutes and no cost", () => {
    const r = bitbucketPipelineLines("acme", "2026-11", [repo([pipe()])], NO_RATE);
    expect(r.lines[0]).toMatchObject({
      billedCost: 0,
      effectiveCost: null,
      priced: false,
      consumedQuantity: 2,
    });
  });

  test("a size the listing carries keys the line and prices at its size rate; others stay default", () => {
    const rates: CostRates = { ...CENT, keyedRates: [["size:4x", 0.04]] };
    const r = bitbucketPipelineLines(
      "acme",
      "2026-11",
      [repo([pipe({ size: "4x" }), pipe({ uuid: "{p-2}", size: "bogus" })])],
      rates,
    );
    const byKey = Object.fromEntries(
      r.lines.map((l) => [tagOf(l.tags, "rate_key"), l.billedCost] as const),
    );
    expect(byKey).toEqual({ "size:4x": 0.08, default: 0.02 });
  });

  test("a size key with no rate listed keeps its key and prices at the default", () => {
    const r = bitbucketPipelineLines("acme", "2026-11", [repo([pipe({ size: "2x" })])], CENT);
    expect(tagOf(r.lines[0]?.tags ?? {}, "rate_key")).toBe("size:2x");
    expect(r.lines[0]?.billedCost).toBe(0.02);
  });
});
