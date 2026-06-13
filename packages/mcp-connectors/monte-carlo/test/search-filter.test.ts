import { describe, expect, test } from "bun:test";

import { filterMonteCarloIncidents } from "../src/search-filter.ts";

function incident(over: {
  incidentId?: string;
  status?: string;
  severity?: string;
  monitoredTable?: string | null;
}): Record<string, unknown> {
  return {
    incidentId: over.incidentId ?? "INC-001",
    status: over.status ?? "active",
    severity: over.severity ?? "high",
    monitoredTable: over.monitoredTable === undefined ? "revenue.orders" : over.monitoredTable,
  };
}

describe("filterMonteCarloIncidents", () => {
  test("matches against incidentId (case-insensitive)", () => {
    expect(filterMonteCarloIncidents([incident({})], { query: "INC-001" })).toHaveLength(1);
    expect(filterMonteCarloIncidents([incident({})], { query: "inc-001" })).toHaveLength(1);
  });

  test("matches against status", () => {
    expect(
      filterMonteCarloIncidents([incident({ status: "resolved" })], { query: "resolved" }),
    ).toHaveLength(1);
  });

  test("matches against severity", () => {
    expect(
      filterMonteCarloIncidents([incident({ severity: "critical" })], { query: "critical" }),
    ).toHaveLength(1);
  });

  test("matches against monitoredTable", () => {
    expect(
      filterMonteCarloIncidents([incident({ monitoredTable: "analytics.pageviews" })], {
        query: "pageviews",
      }),
    ).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterMonteCarloIncidents([incident({})], { query: "nonexistent" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(
      filterMonteCarloIncidents([null, 42, "x", incident({})], { query: "INC-001" }),
    ).toHaveLength(1);
  });

  test("tolerates a null monitoredTable without throwing", () => {
    const noTable = {
      incidentId: "INC-002",
      status: "active",
      severity: "low",
      monitoredTable: null,
    };
    expect(filterMonteCarloIncidents([noTable], { query: "inc-002" })).toHaveLength(1);
    expect(filterMonteCarloIncidents([noTable], { query: "revenue" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      incident({ incidentId: `INC-${String(i).padStart(3, "0")}` }),
    );
    expect(filterMonteCarloIncidents(many, { query: "inc-", limit: 3 })).toHaveLength(3);
  });

  test("defaults the cap to 50", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      incident({ incidentId: `INC-${String(i).padStart(3, "0")}` }),
    );
    expect(filterMonteCarloIncidents(many, { query: "inc-" })).toHaveLength(50);
  });
});
