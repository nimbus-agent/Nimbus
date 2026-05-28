import { beforeEach, describe, expect, it } from "vitest";
import { create } from "zustand";
import { useNimbusStore } from "../../../src/store";
import { type AuditSlice, createAuditSlice } from "../../../src/store/slices/audit";

function makeStore() {
  return create<AuditSlice>()((...a) => ({ ...createAuditSlice(...a) }));
}

describe("audit slice", () => {
  it("seeds with the default filter and null summary", () => {
    const store = makeStore();
    const s = store.getState();
    expect(s.auditFilter).toEqual({ service: "", outcome: "all", sinceMs: null, untilMs: null });
    expect(s.auditSummary).toBeNull();
    expect(s.auditActionInFlight).toBe(false);
  });

  it("setAuditFilter merges patches without dropping unspecified fields", () => {
    const store = makeStore();
    store.getState().setAuditFilter({ service: "github" });
    expect(store.getState().auditFilter.service).toBe("github");
    expect(store.getState().auditFilter.outcome).toBe("all");
    store.getState().setAuditFilter({ outcome: "rejected" });
    expect(store.getState().auditFilter.service).toBe("github");
    expect(store.getState().auditFilter.outcome).toBe("rejected");
  });

  it("resetAuditFilter restores defaults", () => {
    const store = makeStore();
    store
      .getState()
      .setAuditFilter({ service: "github", outcome: "approved", sinceMs: 1, untilMs: 2 });
    store.getState().resetAuditFilter();
    expect(store.getState().auditFilter).toEqual({
      service: "",
      outcome: "all",
      sinceMs: null,
      untilMs: null,
    });
  });

  it("setAuditSummary swaps the snapshot reference", () => {
    const store = makeStore();
    const snap = { byOutcome: { approved: 3 }, byService: { github: 2 }, total: 3 };
    store.getState().setAuditSummary(snap);
    expect(store.getState().auditSummary).toBe(snap);
  });

  it("setAuditActionInFlight toggles the boolean", () => {
    const store = makeStore();
    store.getState().setAuditActionInFlight(true);
    expect(store.getState().auditActionInFlight).toBe(true);
    store.getState().setAuditActionInFlight(false);
    expect(store.getState().auditActionInFlight).toBe(false);
  });
});

describe("AuditSlice — persist whitelist unchanged", () => {
  beforeEach(() => {
    localStorage.clear();
    useNimbusStore.setState({
      auditFilter: { service: "", outcome: "all", sinceMs: null, untilMs: null },
      auditSummary: null,
      auditActionInFlight: false,
    } as never);
  });

  it("auditFilter, auditSummary, auditActionInFlight are NOT persisted", () => {
    useNimbusStore.setState({
      auditFilter: { service: "github", outcome: "approved", sinceMs: 1, untilMs: 2 },
      auditSummary: { byOutcome: { approved: 1 }, byService: { github: 1 }, total: 1 },
      auditActionInFlight: true,
    } as never);
    const raw = localStorage.getItem("nimbus-ui-store");
    if (raw === null) {
      return;
    }
    const parsed = JSON.parse(raw);
    expect(parsed.state?.auditFilter).toBeUndefined();
    expect(parsed.state?.auditSummary).toBeUndefined();
    expect(parsed.state?.auditActionInFlight).toBeUndefined();
  });
});
