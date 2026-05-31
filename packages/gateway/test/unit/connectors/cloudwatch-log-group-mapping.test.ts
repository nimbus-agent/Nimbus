import { describe, expect, test } from "bun:test";

import { mapCloudwatchLogGroupToItem } from "../../../src/connectors/cloudwatch-log-group-mapping.ts";

const SYNCED_AT = 1_700_000_900_000;

describe("mapCloudwatchLogGroupToItem", () => {
  test("maps a full log group to metadata-only item", () => {
    const item = mapCloudwatchLogGroupToItem(
      {
        logGroupName: "/aws/lambda/api",
        arn: "arn:aws:logs:us-east-1:1:log-group:/aws/lambda/api:*",
        retentionInDays: 30,
        storedBytes: 4096,
        metricFilterCount: 2,
        creationTime: 1_700_000_000_000,
      },
      { syncedAt: SYNCED_AT, streamCount: 5, lastEventTimestamp: 1_700_000_500_000 },
    );
    expect(item).not.toBeNull();
    if (item === null) {
      return;
    }
    expect(item.service).toBe("cloudwatch");
    expect(item.type).toBe("log_group");
    expect(item.externalId).toBe("arn:aws:logs:us-east-1:1:log-group:/aws/lambda/api:*");
    expect(item.title).toBe("/aws/lambda/api");
    // last-event timestamp wins for modifiedAt.
    expect(item.modifiedAt).toBe(1_700_000_500_000);
    expect(item.url).toBeNull();
    expect(item.canonicalUrl).toBeNull();
    expect(item.metadata).toMatchObject({
      logGroupName: "/aws/lambda/api",
      retentionInDays: 30,
      storedBytes: 4096,
      metricFilterCount: 2,
      streamCount: 5,
    });
    // No event/message data of any kind.
    const meta = JSON.stringify(item.metadata);
    expect(meta).not.toContain("message");
    expect(meta).not.toContain("events");
  });

  test("external_id falls back to logGroupName when arn absent", () => {
    const item = mapCloudwatchLogGroupToItem(
      { logGroupName: "/aws/ecs/web" },
      { syncedAt: SYNCED_AT },
    );
    expect(item?.externalId).toBe("/aws/ecs/web");
  });

  test("modifiedAt falls back to creationTime, then syncedAt", () => {
    const withCreation = mapCloudwatchLogGroupToItem(
      { logGroupName: "g", creationTime: 1_699_000_000_000 },
      { syncedAt: SYNCED_AT },
    );
    expect(withCreation?.modifiedAt).toBe(1_699_000_000_000);

    const bare = mapCloudwatchLogGroupToItem({ logGroupName: "g" }, { syncedAt: SYNCED_AT });
    expect(bare?.modifiedAt).toBe(SYNCED_AT);
  });

  test("returns null when logGroupName is missing or blank", () => {
    expect(mapCloudwatchLogGroupToItem({ arn: "x" }, { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapCloudwatchLogGroupToItem({ logGroupName: "" }, { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapCloudwatchLogGroupToItem(null, { syncedAt: SYNCED_AT })).toBeNull();
  });
});
