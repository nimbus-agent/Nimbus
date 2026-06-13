import { describe, expect, test } from "bun:test";

import { mapMonteCarloIncidentToItem } from "./monte-carlo-dq-mapping.ts";

const CTX = { syncedAt: 1_700_000_000_000 };

describe("mapMonteCarloIncidentToItem", () => {
  test("returns null when incidentId is missing", () => {
    expect(mapMonteCarloIncidentToItem({}, CTX)).toBeNull();
    expect(mapMonteCarloIncidentToItem({ status: "open" }, CTX)).toBeNull();
  });

  test("returns null when incidentId is empty string", () => {
    expect(mapMonteCarloIncidentToItem({ incidentId: "" }, CTX)).toBeNull();
  });

  test("returns null for non-object input", () => {
    expect(mapMonteCarloIncidentToItem(null, CTX)).toBeNull();
    expect(mapMonteCarloIncidentToItem("string", CTX)).toBeNull();
    expect(mapMonteCarloIncidentToItem(42, CTX)).toBeNull();
  });

  test("maps a full incident to a data_quality_test item", () => {
    const raw = {
      incidentId: "42",
      monitoredTable: "ANALYTICS.PUBLIC.REVENUE",
      status: "open",
      severity: "high",
    };
    const item = mapMonteCarloIncidentToItem(raw, CTX);
    expect(item).not.toBeNull();
    expect(item?.service).toBe("montecarlo");
    expect(item?.type).toBe("data_quality_test");
    expect(item?.externalId).toBe("montecarlo:42");
  });

  test("normalizes monitoredTable into monitoredDataModelKeys", () => {
    const raw = {
      incidentId: "42",
      monitoredTable: "ANALYTICS.PUBLIC.REVENUE",
      status: "open",
      severity: "high",
    };
    const item = mapMonteCarloIncidentToItem(raw, CTX);
    expect(item?.metadata["monitoredDataModelKeys"]).toEqual(["analytics.public.revenue"]);
  });

  test("monitoredDataModelKeys is empty when monitoredTable is absent", () => {
    const raw = { incidentId: "99", status: "fixed" };
    const item = mapMonteCarloIncidentToItem(raw, CTX);
    expect(item?.metadata["monitoredDataModelKeys"]).toEqual([]);
  });

  test("monitoredDataModelKeys is empty when monitoredTable normalizes to null", () => {
    const raw = { incidentId: "10", monitoredTable: '.""..' };
    const item = mapMonteCarloIncidentToItem(raw, CTX);
    expect(item?.metadata["monitoredDataModelKeys"]).toEqual([]);
  });

  test("stores status, severity, firstSeenAt in metadata", () => {
    const raw = {
      incidentId: "7",
      status: "open",
      severity: "high",
      firstSeenAt: "2024-01-15T10:00:00Z",
    };
    const item = mapMonteCarloIncidentToItem(raw, CTX);
    expect(item?.metadata["status"]).toBe("open");
    expect(item?.metadata["severity"]).toBe("high");
    expect(item?.metadata["firstSeenAt"]).toBe("2024-01-15T10:00:00Z");
  });

  test("modifiedAt is parsed from firstSeenAt when provided", () => {
    const raw = {
      incidentId: "8",
      firstSeenAt: "2024-03-01T00:00:00Z",
    };
    const item = mapMonteCarloIncidentToItem(raw, CTX);
    expect(item?.modifiedAt).toBe(Date.parse("2024-03-01T00:00:00Z"));
  });

  test("modifiedAt falls back to syncedAt when firstSeenAt is absent", () => {
    const raw = { incidentId: "9" };
    const item = mapMonteCarloIncidentToItem(raw, CTX);
    expect(item?.modifiedAt).toBe(CTX.syncedAt);
  });

  test("syncedAt is passed through from context", () => {
    const raw = { incidentId: "11" };
    const item = mapMonteCarloIncidentToItem(raw, CTX);
    expect(item?.syncedAt).toBe(CTX.syncedAt);
  });
});
