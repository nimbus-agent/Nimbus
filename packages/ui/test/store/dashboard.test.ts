import { beforeEach, describe, expect, it } from "vitest";
import { create } from "zustand";
import { createDashboardSlice, type DashboardSlice } from "../../src/store/slices/dashboard";

describe("dashboard slice", () => {
  let useStore: ReturnType<typeof create<DashboardSlice>>;
  beforeEach(() => {
    useStore = create<DashboardSlice>()((...a) => createDashboardSlice(...a));
  });

  it("starts empty", () => {
    const s = useStore.getState();
    expect(s.metrics).toBeNull();
    expect(s.connectors).toEqual([]);
    expect(s.audit).toEqual([]);
    expect(s.highlightConnector).toBeNull();
  });

  it("setConnectors replaces the list", () => {
    useStore.getState().setConnectors([{ name: "drive", health: "healthy" }]);
    expect(useStore.getState().connectors).toHaveLength(1);
  });

  it("patchConnector updates by name", () => {
    useStore.getState().setConnectors([
      { name: "drive", health: "healthy" },
      { name: "gmail", health: "healthy" },
    ]);
    useStore.getState().patchConnector("gmail", { health: "degraded", degradationReason: "rate" });
    const c = useStore.getState().connectors.find((x) => x.name === "gmail");
    expect(c?.health).toBe("degraded");
    expect(c?.degradationReason).toBe("rate");
    const d = useStore.getState().connectors.find((x) => x.name === "drive");
    expect(d?.health).toBe("healthy");
  });

  it("patchConnector on unknown name is a no-op", () => {
    useStore.getState().patchConnector("nonexistent", { health: "error" });
    expect(useStore.getState().connectors).toEqual([]);
  });

  it("requestHighlight/clearHighlight round-trip", () => {
    useStore.getState().requestHighlight("drive");
    expect(useStore.getState().highlightConnector).toBe("drive");
    useStore.getState().clearHighlight();
    expect(useStore.getState().highlightConnector).toBeNull();
  });

  it("setMetrics, setMetricsError and setAudit store what they are given", () => {
    const metrics = { itemCount: 3 } as unknown as Parameters<DashboardSlice["setMetrics"]>[0];
    useStore.getState().setMetrics(metrics);
    expect(useStore.getState().metrics).toBe(metrics);
    useStore.getState().setMetricsError("offline");
    expect(useStore.getState().metricsError).toBe("offline");
    useStore.getState().setMetricsError(null);
    expect(useStore.getState().metricsError).toBeNull();
    const audit = [{ id: 1 }] as unknown as Parameters<DashboardSlice["setAudit"]>[0];
    useStore.getState().setAudit(audit);
    expect(useStore.getState().audit).toBe(audit);
  });
});
