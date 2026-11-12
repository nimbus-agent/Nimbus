// What the vendor's published OpenAPI file and the connector's documentation-shaped fixtures say
// (nimbus-mcp-servers connectors/vantage/test/fixtures.ts, read 2026-11-12), recorded for FO2 Task 0:
// - R2: the groupable fields are top-level keys of a cost row; where the value of a `tag:<key>`
//   grouping lands is NOT documented, so the sync refuses a `tag:` entry in `vantage.group_by`.
// - R5 (Cost schema): `amount` is a STRING ("100.0"), `accrued_at` is a date ("2023-06-05").
// - R3: `start_date`/`end_date` are plain ISO 8601 strings; the connector sends YYYY-MM-DD.
// Every fixture below is documentation-shaped, never a live recording and never a real token.
import { describe, expect, test } from "bun:test";
import {
  COST_ALLOCATION_TYPE,
  COST_RECOMMENDATION_TYPE,
  type CostAllocationMetadata,
  DAY_MS,
  seriesHashOf,
  seriesKeyOf,
} from "../finops/cost-item-contract.ts";
import {
  costAllocationItem,
  mapVantageCostRow,
  mapVantageRecommendationToItem,
} from "./vantage-cost-mapping.ts";

const DOC_ROW = {
  accrued_at: "2023-06-05",
  amount: "100.0",
  currency: "USD",
  provider: "aws",
  account_id: "mock_56789",
  service: "AmazonSNS",
} as const;

const CTX = { scopeId: "default", groupBy: [] as readonly string[] };

describe("mapVantageCostRow", () => {
  test("the documented example row maps to the contract keys", () => {
    const p = mapVantageCostRow(DOC_ROW, CTX);
    expect(p).not.toBeNull();
    expect(p?.dayMs).toBe(Date.UTC(2023, 5, 5));
    expect(p?.amount).toBe(100);
    expect(p?.currency).toBe("USD");
    expect(p?.provider).toBe("aws");
    expect(p?.cloudService).toBe("AmazonSNS");
    // No group_by: dimension fields sorted by name, the FIRST one picks kind and key.
    expect(p?.groupings).toEqual(["account_id", "provider", "service"]);
    expect(p?.dimensionKind).toBe("account");
    expect(p?.dimensionKey).toBeNull();
    expect(p?.dimensionValue).toBe("mock_56789 / aws / AmazonSNS");
    expect(p?.seriesHash).toBe(seriesHashOf("account", null, "mock_56789 / aws / AmazonSNS"));
    expect(p?.seriesKey).toBe(
      seriesKeyOf("vantage", "default", "account", null, "mock_56789 / aws / AmazonSNS"),
    );
  });

  test("the group_by order wins over name order", () => {
    const p = mapVantageCostRow(DOC_ROW, { scopeId: "default", groupBy: ["service", "provider"] });
    expect(p?.groupings).toEqual(["service", "provider", "account_id"]);
    expect(p?.dimensionKind).toBe("service");
    expect(p?.dimensionValue).toBe("AmazonSNS / aws / mock_56789");
  });

  test("numeric string amounts are accepted, anything else drops the row", () => {
    expect(mapVantageCostRow({ ...DOC_ROW, amount: 12.5 }, CTX)?.amount).toBe(12.5);
    expect(mapVantageCostRow({ ...DOC_ROW, amount: " -3.25 " }, CTX)?.amount).toBe(-3.25);
    for (const bad of [
      "abc",
      "",
      "NaN",
      "Infinity",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      null,
      {},
    ]) {
      expect(mapVantageCostRow({ ...DOC_ROW, amount: bad }, CTX)).toBeNull();
    }
    const { amount: _omit, ...noAmount } = DOC_ROW;
    expect(mapVantageCostRow(noAmount, CTX)).toBeNull();
  });

  test("accrued_at as a date and as a datetime floor to the UTC day; garbage drops the row", () => {
    const day = Date.UTC(2026, 10, 3);
    expect(mapVantageCostRow({ ...DOC_ROW, accrued_at: "2026-11-03" }, CTX)?.dayMs).toBe(day);
    expect(mapVantageCostRow({ ...DOC_ROW, accrued_at: "2026-11-03T23:59:59Z" }, CTX)?.dayMs).toBe(
      day,
    );
    expect(mapVantageCostRow({ ...DOC_ROW, accrued_at: "not a date" }, CTX)).toBeNull();
    expect(mapVantageCostRow({ ...DOC_ROW, accrued_at: 5 }, CTX)).toBeNull();
  });

  test("the dimension rule: kinds for known names, other for unknown, tag for tag:<k>", () => {
    const kind = (row: Record<string, unknown>) => mapVantageCostRow({ ...base(), ...row }, CTX);
    function base() {
      return { accrued_at: "2026-11-03", amount: "1", currency: "USD" };
    }
    expect(kind({ service: "EC2" })?.dimensionKind).toBe("service");
    expect(kind({ provider: "gcp" })?.dimensionKind).toBe("provider");
    expect(kind({ billing_account_id: "b1" })?.dimensionKind).toBe("account");
    expect(kind({ cost_category: "prod" })?.dimensionKind).toBe("cost_category");
    expect(kind({ cost_subcategory: "x" })?.dimensionKind).toBe("cost_category");
    expect(kind({ region: "us-east-1" })?.dimensionKind).toBe("other");
    const tag = kind({ "tag:team": "core" });
    expect(tag?.dimensionKind).toBe("tag");
    expect(tag?.dimensionKey).toBe("team");
    expect(tag?.dimensionValue).toBe("core");
  });

  test("metric siblings and non-string fields are not dimensions", () => {
    const p = mapVantageCostRow(
      {
        ...DOC_ROW,
        total_cost: "5",
        usage_amount: "2",
        tags: [{ key: "a", value: "b" }],
        count: 3,
      },
      CTX,
    );
    expect(p?.groupings).toEqual(["account_id", "provider", "service"]);
  });

  test("a row with no dimension is one series named total", () => {
    const p = mapVantageCostRow({ accrued_at: "2026-11-03", amount: "9" }, CTX);
    expect(p?.dimensionKind).toBe("other");
    expect(p?.dimensionValue).toBe("total");
    expect(p?.groupings).toEqual([]);
    expect(p?.currency).toBeNull();
    expect(p?.provider).toBeNull();
    expect(p?.cloudService).toBeNull();
  });

  test("a slash inside a value is written %2F and a percent %25", () => {
    const p = mapVantageCostRow(
      { ...DOC_ROW, provider: undefined, account_id: undefined, service: "a/b%c" },
      CTX,
    );
    expect(p?.dimensionValue).toBe("a%2Fb%25c");
  });

  test("a 300-character value is truncated with an ellipsis and a hash so two truncations differ", () => {
    const long = (tail: string) => `${"x".repeat(299)}${tail}`;
    const a = mapVantageCostRow(
      { ...DOC_ROW, provider: undefined, account_id: undefined, service: long("a") },
      CTX,
    );
    const b = mapVantageCostRow(
      { ...DOC_ROW, provider: undefined, account_id: undefined, service: long("b") },
      CTX,
    );
    expect(a?.dimensionValue.length).toBe(200);
    expect(a?.dimensionValue).toContain("…");
    expect(a?.dimensionValue).not.toBe(b?.dimensionValue);
    expect(a?.seriesHash).not.toBe(b?.seriesHash);
  });

  test("rows that are not objects are skipped", () => {
    for (const bad of [null, undefined, "x", 5, [1]]) {
      expect(mapVantageCostRow(bad, CTX)).toBeNull();
    }
  });

  test("a currency that is not three letters is null", () => {
    expect(mapVantageCostRow({ ...DOC_ROW, currency: "dollars" }, CTX)?.currency).toBeNull();
    expect(mapVantageCostRow({ ...DOC_ROW, currency: 4 }, CTX)?.currency).toBeNull();
  });
});

describe("costAllocationItem", () => {
  test("builds the index row: title, preview, capped modifiedAt, metadata", () => {
    const point = mapVantageCostRow(
      { ...DOC_ROW, provider: undefined, account_id: undefined },
      CTX,
    );
    expect(point).not.toBeNull();
    const syncedAt = Date.UTC(2023, 5, 5, 12);
    const rolled = {
      externalId: `default:${point?.seriesHash}:2023-06-05`,
      dayMs: point?.dayMs ?? 0,
      metadata: {
        seriesKey: point?.seriesKey ?? "",
        seriesHash: point?.seriesHash ?? "",
        scopeSeries: "default~x",
        scopeId: "default",
        dimensionKind: "service" as const,
        dimensionKey: null,
        dimensionValue: "AmazonSNS",
        groupings: ["service"],
        periodStartMs: point?.dayMs ?? 0,
        periodEndMs: (point?.dayMs ?? 0) + DAY_MS,
        granularity: "day" as const,
        amount: 100,
        currency: "USD",
        costKind: "unknown" as const,
        unit: "currency" as const,
        finalized: false,
        provider: null,
        cloudService: null,
        rowCount: 1,
      },
    };
    const item = costAllocationItem(rolled, syncedAt);
    expect(item.service).toBe("vantage");
    expect(item.type).toBe("cost_allocation");
    expect(item.type).toBe(COST_ALLOCATION_TYPE);
    expect(Object.keys(item.metadata).sort()).toEqual(Object.keys(rolled.metadata).sort());
    expect(item.externalId).toBe(rolled.externalId);
    expect(item.title).toBe("AmazonSNS 2023-06-05 100 USD");
    expect(item.bodyPreview).toBe(item.title);
    expect(item.url).toBeNull();
    expect(item.modifiedAt).toBe(syncedAt);
    expect(item.metadata["seriesKey"]).toBe(rolled.metadata.seriesKey);
    expect(item.syncedAt).toBe(syncedAt);
  });

  test("the title is truncated to 200 characters and a null currency is omitted", () => {
    const long = "y".repeat(400);
    const item = costAllocationItem(
      {
        externalId: "d:h:2023-06-05",
        dayMs: Date.UTC(2023, 5, 5),
        metadata: {
          seriesKey: "k",
          seriesHash: "h",
          scopeSeries: "default~h",
          scopeId: "default",
          dimensionKind: "other",
          dimensionKey: null,
          dimensionValue: long,
          groupings: [],
          periodStartMs: Date.UTC(2023, 5, 5),
          periodEndMs: Date.UTC(2023, 5, 6),
          granularity: "day",
          amount: 1.5,
          currency: null,
          costKind: "unknown",
          unit: "currency",
          finalized: true,
          provider: null,
          cloudService: null,
          rowCount: 1,
        },
      },
      Date.UTC(2024, 0, 1),
    );
    expect(item.title).toHaveLength(200);
    const short = costAllocationItem(
      {
        externalId: "d:h:2023-06-05",
        dayMs: Date.UTC(2023, 5, 5),
        metadata: { ...(item.metadata as unknown as CostAllocationMetadata), dimensionValue: "v" },
      },
      Date.UTC(2024, 0, 1),
    );
    expect(short.title).toBe("v 2023-06-05 1.5");
    expect(short.modifiedAt).toBe(Date.UTC(2023, 5, 6));
  });
});

describe("mapVantageRecommendationToItem", () => {
  const REC = {
    token: "rec_example_1",
    type: "aws:ec2:co-rightsizing",
    category: "ec2_compute_optimizer_recommender",
    workspace_token: "wrkspc_example",
    provider: "aws",
    provider_account_id: "123456789012",
    service: "Amazon EC2",
    description: "Rightsize an over-provisioned EC2 instance",
    documentation_url: "https://handbook.vantage.sh/aws/services/ec2-pricing/",
    potential_savings: "100.00",
    resources_affected_count: 3,
    currency_code: "USD",
    currency_symbol: "$",
    created_at: "2026-11-01T00:00:00Z",
  };

  test("maps the field list of the Recommendation schema", () => {
    const syncedAt = Date.UTC(2026, 10, 12);
    const item = mapVantageRecommendationToItem(REC, { syncedAt });
    expect(item?.service).toBe("vantage");
    expect(item?.type).toBe("cost_recommendation");
    expect(item?.type).toBe(COST_RECOMMENDATION_TYPE);
    expect(item?.externalId).toBe("rec_example_1");
    expect(item?.title).toBe("Rightsize an over-provisioned EC2 instance");
    expect(item?.url).toBeNull();
    expect(item?.modifiedAt).toBe(Date.UTC(2026, 10, 1));
    expect(item?.metadata).toEqual({
      recommendationType: "aws:ec2:co-rightsizing",
      category: "ec2_compute_optimizer_recommender",
      provider: "aws",
      cloudService: "Amazon EC2",
      providerAccountId: "123456789012",
      estimatedMonthlySavings: 100,
      currency: "USD",
      resourcesAffected: 3,
      createdAtMs: Date.UTC(2026, 10, 1),
      documentationUrl: "https://handbook.vantage.sh/aws/services/ec2-pricing/",
    });
  });

  test("a sparse recommendation still maps, with nulls, and falls back to the type for a title", () => {
    const item = mapVantageRecommendationToItem(
      { token: "r2", type: "aws:s3:tiering", potential_savings: "oops", documentation_url: 7 },
      { syncedAt: 5 },
    );
    expect(item?.title).toBe("aws:s3:tiering");
    expect(item?.modifiedAt).toBe(5);
    expect(item?.metadata["estimatedMonthlySavings"]).toBeNull();
    expect(item?.metadata["documentationUrl"]).toBeNull();
    expect(item?.metadata["resourcesAffected"]).toBeNull();
  });

  test("a numeric savings value is accepted and a missing token or non-object is skipped", () => {
    expect(
      mapVantageRecommendationToItem({ token: "r3", potential_savings: 7.5 }, { syncedAt: 1 })
        ?.metadata["estimatedMonthlySavings"],
    ).toBe(7.5);
    expect(mapVantageRecommendationToItem({ type: "x" }, { syncedAt: 1 })).toBeNull();
    expect(mapVantageRecommendationToItem({ token: "" }, { syncedAt: 1 })).toBeNull();
    expect(mapVantageRecommendationToItem("x", { syncedAt: 1 })).toBeNull();
    expect(mapVantageRecommendationToItem({ token: "r4" }, { syncedAt: 1 })?.title).toBe(
      "Vantage recommendation",
    );
  });
});
