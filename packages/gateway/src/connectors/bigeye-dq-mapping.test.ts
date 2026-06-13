import { describe, expect, test } from "bun:test";

import { mapBigeyeIssueToItem } from "./bigeye-dq-mapping.ts";

const CTX = { syncedAt: 1_700_000_000_000 };

describe("mapBigeyeIssueToItem", () => {
  test("returns null when issueId is missing", () => {
    expect(mapBigeyeIssueToItem({}, CTX)).toBeNull();
    expect(mapBigeyeIssueToItem({ slaStatus: "breached" }, CTX)).toBeNull();
  });

  test("returns null when issueId is empty string", () => {
    expect(mapBigeyeIssueToItem({ issueId: "" }, CTX)).toBeNull();
  });

  test("returns null for non-object input", () => {
    expect(mapBigeyeIssueToItem(null, CTX)).toBeNull();
    expect(mapBigeyeIssueToItem("string", CTX)).toBeNull();
    expect(mapBigeyeIssueToItem(42, CTX)).toBeNull();
  });

  test("maps a full issue to a data_quality_test item", () => {
    const raw = {
      issueId: "7",
      monitoredTable: "ANALYTICS.PUBLIC.ORDERS",
      slaStatus: "breached",
    };
    const item = mapBigeyeIssueToItem(raw, CTX);
    expect(item).not.toBeNull();
    expect(item?.service).toBe("bigeye");
    expect(item?.type).toBe("data_quality_test");
    expect(item?.externalId).toBe("bigeye:7");
  });

  test("normalizes monitoredTable into monitoredDataModelKeys", () => {
    const raw = {
      issueId: "7",
      monitoredTable: "ANALYTICS.PUBLIC.ORDERS",
      slaStatus: "breached",
    };
    const item = mapBigeyeIssueToItem(raw, CTX);
    expect(item?.metadata["monitoredDataModelKeys"]).toEqual(["analytics.public.orders"]);
  });

  test("monitoredDataModelKeys is empty when monitoredTable is absent", () => {
    const raw = { issueId: "99", slaStatus: "ok" };
    const item = mapBigeyeIssueToItem(raw, CTX);
    expect(item?.metadata["monitoredDataModelKeys"]).toEqual([]);
  });

  test("stores slaStatus and anomaly in metadata", () => {
    const raw = {
      issueId: "7",
      slaStatus: "breached",
      anomaly: "null_rate_spike",
    };
    const item = mapBigeyeIssueToItem(raw, CTX);
    expect(item?.metadata["slaStatus"]).toBe("breached");
    expect(item?.metadata["anomaly"]).toBe("null_rate_spike");
  });

  test("metadata fields are null when absent", () => {
    const raw = { issueId: "5" };
    const item = mapBigeyeIssueToItem(raw, CTX);
    expect(item?.metadata["slaStatus"]).toBeNull();
    expect(item?.metadata["anomaly"]).toBeNull();
  });

  test("modifiedAt equals syncedAt from context", () => {
    const raw = { issueId: "3" };
    const item = mapBigeyeIssueToItem(raw, CTX);
    expect(item?.modifiedAt).toBe(CTX.syncedAt);
    expect(item?.syncedAt).toBe(CTX.syncedAt);
  });
});
