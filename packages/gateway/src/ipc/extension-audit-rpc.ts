import type { Database } from "bun:sqlite";

import { listExtensions } from "../automation/extension-store.ts";
import { parseRunGrants } from "../extensions/extension-run-grants.ts";
import {
  type CoverageRow,
  type ObservationRow,
  readExtensionAudit,
} from "../extensions/observation/observation-store.ts";
import { getRunGrant } from "../extensions/run-grant-store.ts";

const DAY_MS = 86_400_000;

export type AuditDestination = { destination: string; port: number; count: number };

export type AuditEntry = {
  id: string;
  version: string;
  os?: "linux" | "darwin" | "win32";
  networkObserved: boolean;
  runs: number;
  observedDays: number;
  firstSeen?: number;
  lastSeen?: number;
  /** `host:port` from the installed run grant. */
  declared: string[];
  used: AuditDestination[];
  /** Declared and not seen: a lower bound's complement, never "not used". */
  notSeen: string[];
  refused: AuditDestination[];
  unmatched: AuditDestination[];
  dropped: number;
};

function ofOutcome(rows: readonly ObservationRow[], outcome: string): AuditDestination[] {
  return rows
    .filter((r) => r.outcome === outcome)
    .map((r) => ({ destination: r.destination, port: r.port, count: r.count }));
}

/** UTC calendar days the observation touched, at least 1 once anything was observed. */
function daysSpanned(c: CoverageRow): number {
  return Math.floor(c.last_seen / DAY_MS) - Math.floor(c.first_seen / DAY_MS) + 1;
}

function declaredOf(db: Database, id: string): string[] {
  const grant = getRunGrant(db, id);
  if (grant === null) return [];
  return [...(parseRunGrants(grant.permissions_json)?.network ?? [])];
}

function entryFor(db: Database, id: string, version: string): AuditEntry {
  const { coverage, rows } = readExtensionAudit(db, id, version);
  const declared = declaredOf(db, id);
  const used = ofOutcome(rows, "used");
  const usedKeys = new Set(used.map((u) => `${u.destination}:${u.port}`.toLowerCase()));
  const base = {
    id,
    version,
    networkObserved: coverage !== undefined && coverage.network_observed === 1,
    declared,
    used,
    notSeen: declared.filter((d) => !usedKeys.has(d.toLowerCase())),
    refused: ofOutcome(rows, "refused"),
    unmatched: ofOutcome(rows, "unmatched"),
  };
  if (coverage === undefined) {
    return { ...base, runs: 0, observedDays: 0, dropped: 0 };
  }
  return {
    ...base,
    os: coverage.os,
    runs: coverage.runs,
    observedDays: daysSpanned(coverage),
    firstSeen: coverage.first_seen,
    lastSeen: coverage.last_seen,
    dropped: coverage.dropped,
  };
}

/** `undefined` when `id` names no installed extension. Read-only; the installed version only. */
export function readAuditEntries(db: Database, id?: string): AuditEntry[] | undefined {
  const installed = listExtensions(db);
  const chosen = id === undefined ? installed : installed.filter((r) => r.id === id);
  if (id !== undefined && chosen.length === 0) return undefined;
  return chosen.map((r) => entryFor(db, r.id, r.version));
}
