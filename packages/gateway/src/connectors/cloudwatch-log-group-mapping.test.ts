import { describe, expect, test } from "bun:test";

import {
  type CloudwatchMappingContext,
  mapCloudwatchLogGroupToItem,
} from "./cloudwatch-log-group-mapping.ts";

const ctx = (overrides: Partial<CloudwatchMappingContext> = {}): CloudwatchMappingContext => ({
  syncedAt: 999,
  ...overrides,
});

describe("mapCloudwatchLogGroupToItem", () => {
  test("maps a basic log-group entry to a cloudwatch:log_group row", () => {
    const row = mapCloudwatchLogGroupToItem(
      {
        logGroupName: "/aws/lambda/my-fn",
        arn: "arn:aws:logs:us-east-1:123:log-group:/aws/lambda/my-fn",
        retentionInDays: 30,
        storedBytes: 4096,
        metricFilterCount: 2,
        creationTime: 1_700_000_000_000,
      },
      ctx(),
    );
    expect(row).not.toBeNull();
    expect(row?.service).toBe("cloudwatch");
    expect(row?.type).toBe("log_group");
    expect(row?.externalId).toBe("arn:aws:logs:us-east-1:123:log-group:/aws/lambda/my-fn");
    expect(row?.title).toBe("/aws/lambda/my-fn");
    expect(row?.bodyPreview).toBe("retention:30d, storedBytes:4096, metricFilters:2");
    expect(row?.url).toBeNull();
    expect(row?.canonicalUrl).toBeNull();
    expect(row?.modifiedAt).toBe(1_700_000_000_000);
    expect(row?.syncedAt).toBe(999);
    expect(row?.metadata).toMatchObject({
      logGroupName: "/aws/lambda/my-fn",
      retentionInDays: 30,
      storedBytes: 4096,
      metricFilterCount: 2,
      creationTime: 1_700_000_000_000,
    });
  });

  test("returns null when raw is not a record", () => {
    expect(mapCloudwatchLogGroupToItem(null, ctx())).toBeNull();
    expect(mapCloudwatchLogGroupToItem([1, 2, 3], ctx())).toBeNull();
    expect(mapCloudwatchLogGroupToItem("nope", ctx())).toBeNull();
  });

  test("returns null when logGroupName is missing or empty", () => {
    expect(mapCloudwatchLogGroupToItem({}, ctx())).toBeNull();
    expect(mapCloudwatchLogGroupToItem({ logGroupName: "" }, ctx())).toBeNull();
  });

  test("falls back to logGroupName as externalId when arn is absent", () => {
    const row = mapCloudwatchLogGroupToItem({ logGroupName: "groupA" }, ctx());
    expect(row?.externalId).toBe("groupA");
    // no metadata keys for the absent optional fields
    expect(row?.metadata).toEqual({ logGroupName: "groupA" });
    // body falls back to the name when there are no body parts
    expect(row?.bodyPreview).toBe("groupA");
    // modifiedAt falls back to syncedAt when no timestamps available
    expect(row?.modifiedAt).toBe(999);
  });

  test("parses a numeric-string creationTime (digit-regex branch, millis)", () => {
    const row = mapCloudwatchLogGroupToItem(
      { logGroupName: "g", creationTime: "1700000000000" },
      ctx(),
    );
    expect(row?.metadata).toMatchObject({ creationTime: 1_700_000_000_000 });
    expect(row?.modifiedAt).toBe(1_700_000_000_000);
  });

  test("parses a numeric-string creationTime in seconds (< 1e12 → ×1000)", () => {
    const row = mapCloudwatchLogGroupToItem(
      { logGroupName: "g", creationTime: "1700000000" },
      ctx(),
    );
    expect(row?.metadata).toMatchObject({ creationTime: 1_700_000_000_000 });
  });

  test("parses a decimal numeric-string creationTime", () => {
    const row = mapCloudwatchLogGroupToItem(
      { logGroupName: "g", creationTime: "1700000000.5" },
      ctx(),
    );
    expect(row?.metadata).toMatchObject({ creationTime: 1_700_000_000_500 });
  });

  test("parses an ISO date-string creationTime (Date.parse branch)", () => {
    const expected = Date.parse("2023-11-14T22:13:20.000Z");
    const row = mapCloudwatchLogGroupToItem(
      { logGroupName: "g", creationTime: "2023-11-14T22:13:20.000Z" },
      ctx(),
    );
    expect(row?.metadata).toMatchObject({ creationTime: expected });
    expect(row?.modifiedAt).toBe(expected);
  });

  test("drops an unparseable date-string creationTime (Date.parse → NaN)", () => {
    const row = mapCloudwatchLogGroupToItem(
      { logGroupName: "g", creationTime: "not-a-date" },
      ctx(),
    );
    expect(row?.metadata).not.toHaveProperty("creationTime");
    expect(row?.modifiedAt).toBe(999);
  });

  test("ignores a blank-string creationTime", () => {
    const row = mapCloudwatchLogGroupToItem({ logGroupName: "g", creationTime: "   " }, ctx());
    expect(row?.metadata).not.toHaveProperty("creationTime");
  });

  test("ignores a non-string/non-number creationTime", () => {
    const row = mapCloudwatchLogGroupToItem({ logGroupName: "g", creationTime: {} }, ctx());
    expect(row?.metadata).not.toHaveProperty("creationTime");
  });

  test("includes streamCount and lastEventTimestamp from context", () => {
    const row = mapCloudwatchLogGroupToItem(
      { logGroupName: "g", creationTime: 1_000_000_000_000 },
      ctx({ streamCount: 7, lastEventTimestamp: 1_800_000_000_000 }),
    );
    expect(row?.metadata).toMatchObject({
      streamCount: 7,
      lastEventTimestamp: 1_800_000_000_000,
    });
    // lastEventTimestamp wins over creationTime for modifiedAt
    expect(row?.modifiedAt).toBe(1_800_000_000_000);
  });

  test("drops a non-finite context lastEventTimestamp", () => {
    const row = mapCloudwatchLogGroupToItem(
      { logGroupName: "g" },
      ctx({ lastEventTimestamp: Number.POSITIVE_INFINITY }),
    );
    expect(row?.metadata).not.toHaveProperty("lastEventTimestamp");
    expect(row?.modifiedAt).toBe(999);
  });

  test("clamps an over-long title with an ellipsis", () => {
    const longName = "x".repeat(300);
    const row = mapCloudwatchLogGroupToItem({ logGroupName: longName }, ctx());
    expect(row?.title.endsWith("…")).toBe(true);
    expect(row?.title.length).toBe(257);
  });
});
