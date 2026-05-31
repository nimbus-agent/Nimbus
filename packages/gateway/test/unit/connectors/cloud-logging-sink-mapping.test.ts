import { describe, expect, test } from "bun:test";

import { mapCloudLoggingSinkToItem } from "../../../src/connectors/cloud-logging-sink-mapping.ts";

const SYNCED_AT = 1_700_000_900_000;
const PROJECT = "my-project";

describe("mapCloudLoggingSinkToItem", () => {
  test("maps a full sink to metadata-only item", () => {
    const item = mapCloudLoggingSinkToItem(
      {
        name: "bq-audit-sink",
        destination: "bigquery.googleapis.com/projects/p/datasets/audit",
        filter: 'logName:"cloudaudit.googleapis.com"',
        description: "routes audit logs to BigQuery",
        disabled: false,
        createTime: "2024-01-01T00:00:00Z",
        updateTime: "2024-06-15T12:00:00Z",
      },
      { project: PROJECT, syncedAt: SYNCED_AT },
    );
    expect(item).not.toBeNull();
    if (item === null) {
      return;
    }
    expect(item.service).toBe("cloud_logging");
    expect(item.type).toBe("sink");
    expect(item.externalId).toBe("my-project/bq-audit-sink");
    expect(item.title).toBe("bq-audit-sink");
    // updateTime wins for modifiedAt.
    expect(item.modifiedAt).toBe(Date.parse("2024-06-15T12:00:00Z"));
    expect(item.url).toBeNull();
    expect(item.canonicalUrl).toBeNull();
    expect(item.metadata).toMatchObject({
      project: PROJECT,
      sinkName: "bq-audit-sink",
      destination: "bigquery.googleapis.com/projects/p/datasets/audit",
      filter: 'logName:"cloudaudit.googleapis.com"',
      description: "routes audit logs to BigQuery",
      disabled: false,
    });
    // No log-entry / message / payload data of any kind.
    const meta = JSON.stringify(item.metadata);
    expect(meta).not.toContain("textPayload");
    expect(meta).not.toContain("jsonPayload");
    expect(meta).not.toContain("entries");
  });

  test("modifiedAt falls back to createTime, then syncedAt", () => {
    const withCreate = mapCloudLoggingSinkToItem(
      { name: "s", createTime: "2023-11-03T00:00:00Z" },
      { project: PROJECT, syncedAt: SYNCED_AT },
    );
    expect(withCreate?.modifiedAt).toBe(Date.parse("2023-11-03T00:00:00Z"));

    const bare = mapCloudLoggingSinkToItem(
      { name: "s" },
      { project: PROJECT, syncedAt: SYNCED_AT },
    );
    expect(bare?.modifiedAt).toBe(SYNCED_AT);
  });

  test("disabled flag is preserved when true", () => {
    const item = mapCloudLoggingSinkToItem(
      { name: "s", disabled: true },
      { project: PROJECT, syncedAt: SYNCED_AT },
    );
    expect(item?.metadata).toMatchObject({ disabled: true });
  });

  test("returns null when sink name is missing or blank", () => {
    expect(
      mapCloudLoggingSinkToItem({ destination: "x" }, { project: PROJECT, syncedAt: SYNCED_AT }),
    ).toBeNull();
    expect(
      mapCloudLoggingSinkToItem({ name: "" }, { project: PROJECT, syncedAt: SYNCED_AT }),
    ).toBeNull();
    expect(mapCloudLoggingSinkToItem(null, { project: PROJECT, syncedAt: SYNCED_AT })).toBeNull();
  });
});
