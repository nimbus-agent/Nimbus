/**
 * Types for `nimbus incident debt` (Phase 10 IC7b). This directory is deliberately OUTSIDE `incident/**`: it
 * runs `git log` (see `git-history.ts`), and keeping the child process here keeps I57 (a) ("incident
 * assembly is inert") literally true.
 */

export const DEBT_DEFAULTS = {
  sinceDays: 365,
  untouchedDays: 180,
  minIncidents: 2,
  limit: 50,
} as const;

export type DebtInput = {
  readonly nowMs: number;
  readonly sinceDays: number;
  readonly untouchedDays: number;
  readonly minIncidents: number;
  readonly limit: number;
};

/** A `[[filesystem.roots]]` entry as the scan needs it (the owner's own config, never the index). */
export type ConfiguredRoot = { readonly path: string; readonly gitAware: boolean };

export type DebtIncident = {
  readonly id: string;
  readonly title: string;
  readonly openedAtMs: number;
};

export type DebtSymbol = {
  readonly name: string;
  readonly file: string;
  readonly root: string;
  readonly incidentCount: number;
  /** Null when the file was last touched before the oldest commit the capped history read reached. */
  readonly lastTouchMs: number | null;
  readonly incidents: readonly DebtIncident[];
};

/** A named gap. Its own type: the briefs' closed `GapCategory` union is not extended for one command. */
export type DebtGap = {
  readonly category: string;
  readonly detail: string;
  readonly remediation?: string;
};

export type DebtStatus = "ok" | "none" | "no_incidents" | "no_roots";

export type DebtResult = {
  readonly status: DebtStatus;
  readonly windowDays: number;
  readonly untouchedDays: number;
  readonly minIncidents: number;
  readonly symbols: readonly DebtSymbol[];
  /** Symbols that qualified but were cut by `limit`. */
  readonly omitted: number;
  readonly gaps: readonly DebtGap[];
  readonly counts: {
    readonly incidentsScanned: number;
    readonly rootsScanned: number;
    readonly filesJudged: number;
  };
};
