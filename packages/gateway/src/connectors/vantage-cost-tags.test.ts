// A REDACTED copy of one live Vantage `GET /v2/costs` reply (2026-11-25; `date_bin=day`, groupings
// `provider,service,tag:owner,tag:repo`, and a `tag:team` grouping no row carried). Key names and
// nesting are the vendor's; every id, tag value and amount is a placeholder.
import { describe, expect, test } from "bun:test";
import { mapVantageCostRow } from "./vantage-cost-mapping.ts";
import { VANTAGE_UNTAGGED, vantageTagDimensions } from "./vantage-cost-tags.ts";

const LIVE_SHAPE_COSTS_REPLY = {
  links: {
    self: "https://api.vantage.sh/v2/costs?cost_report_token=rprt_placeholder",
    first: "https://api.vantage.sh/v2/costs?cost_report_token=rprt_placeholder&page=1",
    next: null,
    last: null,
    prev: null,
  },
  total_cost: { amount: "30.0", currency: "USD" },
  costs: [
    {
      accrued_at: "2026-11-23",
      amount: "12.5",
      currency: "USD",
      provider: "github",
      service: "Actions",
      tag: "example-org",
      tags: ["owner:example-org", "repo:repo-a"],
    },
    {
      accrued_at: "2026-11-23",
      amount: "17.5",
      currency: "USD",
      provider: "github",
      service: "Actions",
      tag: "example-org",
      tags: ["owner:example-org", "repo:repo-b"],
    },
  ],
} as const;

/** A row of the same reply grouped by a tag no cost carries: `"<key>:"`, and no `tag` field. */
const UNTAGGED_ROW = {
  accrued_at: "2026-11-23",
  amount: "4.0",
  currency: "USD",
  provider: "github",
  service: "Actions",
  tags: ["team:"],
} as const;

const GROUP_BY = ["provider", "service", "tag:owner", "tag:repo"] as const;

describe("vantageTagDimensions", () => {
  test("each requested key is read from its own `<key>:` entry of tags", () => {
    const [a] = LIVE_SHAPE_COSTS_REPLY.costs;
    expect(vantageTagDimensions(a, GROUP_BY)).toEqual({
      dims: { "tag:owner": "example-org", "tag:repo": "repo-a" },
      consumed: true,
    });
  });

  test("an empty value, and a requested tag the row does not list, are both untagged", () => {
    expect(vantageTagDimensions(UNTAGGED_ROW, ["tag:team", "tag:env"]).dims).toEqual({
      "tag:team": VANTAGE_UNTAGGED,
      "tag:env": VANTAGE_UNTAGGED,
    });
  });

  test("a key holding a colon is matched by prefix, never split at the first colon", () => {
    const row = { tags: ["aws:cloudformation:stack-name:web-stack"] };
    expect(vantageTagDimensions(row, ["tag:aws:cloudformation:stack-name"]).dims).toEqual({
      "tag:aws:cloudformation:stack-name": "web-stack",
    });
  });

  test("entries out of order are still matched by prefix", () => {
    const row = { tags: ["repo:repo-a", "owner:example-org"] };
    expect(vantageTagDimensions(row, ["tag:owner", "tag:repo"]).dims).toEqual({
      "tag:owner": "example-org",
      "tag:repo": "repo-a",
    });
  });

  test("an entry no requested key claims (a saved report's grouping) splits at its first colon", () => {
    const row = { tags: ["env:prod", "nocolon", ":novalue"] };
    expect(vantageTagDimensions(row, []).dims).toEqual({ "tag:env": "prod" });
  });

  test("without tags, the deprecated `tag` string is the first requested key's value", () => {
    expect(vantageTagDimensions({ tag: "example-org" }, ["tag:owner", "tag:repo"]).dims).toEqual({
      "tag:owner": "example-org",
      "tag:repo": VANTAGE_UNTAGGED,
    });
  });

  test("no tag grouping and no tags array consumes nothing", () => {
    expect(vantageTagDimensions({ tag: "x" }, ["service"])).toEqual({ dims: {}, consumed: false });
  });
});

describe("mapVantageCostRow with tag groupings", () => {
  const ctx = { scopeId: "rprt_placeholder", groupBy: GROUP_BY };

  test("the live shape maps to one series per tag value, in group_by order, with no `tag` dimension", () => {
    const [a, b] = LIVE_SHAPE_COSTS_REPLY.costs.map((row) => mapVantageCostRow(row, ctx));
    expect(a?.groupings).toEqual(["provider", "service", "tag:owner", "tag:repo"]);
    expect(a?.dimensionKind).toBe("provider");
    expect(a?.dimensionValue).toBe("github / Actions / example-org / repo-a");
    expect(b?.dimensionValue).toBe("github / Actions / example-org / repo-b");
    expect(a?.seriesHash).not.toBe(b?.seriesHash);
    expect(a?.amount).toBe(12.5);
  });

  test("a tag grouping first gives the tag kind and key", () => {
    const p = mapVantageCostRow(LIVE_SHAPE_COSTS_REPLY.costs[0], {
      scopeId: "default",
      groupBy: ["tag:repo", "service"],
    });
    expect(p?.dimensionKind).toBe("tag");
    expect(p?.dimensionKey).toBe("repo");
    // `provider` was not requested; unrequested string fields follow in name order.
    expect(p?.groupings).toEqual(["tag:repo", "service", "provider", "tag:owner"]);
  });

  test("untagged spend is kept as its own series, never dropped or merged", () => {
    const p = mapVantageCostRow(UNTAGGED_ROW, {
      scopeId: "default",
      groupBy: ["provider", "service", "tag:team"],
    });
    expect(p?.dimensionValue).toBe(`github / Actions / ${VANTAGE_UNTAGGED}`);
    expect(p?.amount).toBe(4);
  });

  test("a slash in a tag value is escaped like any other value", () => {
    const p = mapVantageCostRow(
      { accrued_at: "2026-11-23", amount: "1", tags: ["path:a/b"] },
      { scopeId: "default", groupBy: ["tag:path"] },
    );
    expect(p?.dimensionValue).toBe("a%2Fb");
  });
});
