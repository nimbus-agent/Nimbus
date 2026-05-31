import type { StateCreator } from "zustand";
import type { AuditSummary } from "../../ipc/types";

export type AuditOutcomeFilter = "all" | "approved" | "rejected" | "not_required";

export interface AuditFilter {
  readonly service: string;
  readonly outcome: AuditOutcomeFilter;
  readonly sinceMs: number | null;
  readonly untilMs: number | null;
}

export interface AuditSlice {
  readonly auditFilter: AuditFilter;
  readonly auditSummary: AuditSummary | null;
  readonly auditActionInFlight: boolean;
  setAuditFilter: (next: Partial<AuditFilter>) => void;
  resetAuditFilter: () => void;
  setAuditSummary: (snapshot: AuditSummary | null) => void;
  setAuditActionInFlight: (inFlight: boolean) => void;
}

const DEFAULT_FILTER: AuditFilter = {
  service: "",
  outcome: "all",
  sinceMs: null,
  untilMs: null,
};

export const createAuditSlice: StateCreator<AuditSlice, [], [], AuditSlice> = (set) => ({
  auditFilter: DEFAULT_FILTER,
  auditSummary: null,
  auditActionInFlight: false,
  setAuditFilter: (next) => set((s) => ({ auditFilter: { ...s.auditFilter, ...next } })),
  resetAuditFilter: () => set({ auditFilter: DEFAULT_FILTER }),
  setAuditSummary: (snapshot) => set({ auditSummary: snapshot }),
  setAuditActionInFlight: (inFlight) => set({ auditActionInFlight: inFlight }),
});
