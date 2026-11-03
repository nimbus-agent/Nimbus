import type { Database } from "bun:sqlite";

import { type ExtensionRow, listExtensions } from "../automation/extension-store.ts";
import { isNetworkNarrowed, networkEntryKey } from "../extensions/network-entry-key.ts";
import { declaredNetworkFor } from "../extensions/observation/declared-network.ts";
import { type NarrowingOffer, narrowingOffer } from "../extensions/observation/narrowing-offer.ts";
import {
  type ObservationFinding,
  observationFindings,
} from "../extensions/observation/observation-findings.ts";
import {
  type CoverageRow,
  type ObservationRow,
  readExtensionAudit,
} from "../extensions/observation/observation-store.ts";

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
  /**
   * `host:port` from the verified installed MANIFEST (what the extension declares, as the approval
   * re-resolves it), normalised the way the forwarder plans it (lowercase host, one trailing dot
   * dropped, the port as a number, 443 when none is given). From the run grant only when the
   * manifest could not be read and verified: `declaredFrom` says which.
   */
  declared: string[];
  declaredFrom: "manifest" | "grant";
  /** The stored run grant's network, normalised like `declared`; absent with no grant. */
  approved?: string[];
  /** The owner narrowed the grant (I52): `approved` names fewer `host:port` keys than `declared`. */
  narrowed: boolean;
  /**
   * A narrower grant the evidence supports (see `narrowingOffer`), RAW manifest entries so `keep`
   * is exactly the `--network` list the approval accepts; `null` when none. Never applied here.
   */
  offer: NarrowingOffer | null;
  used: AuditDestination[];
  /** Declared and not seen: a lower bound's complement, never "not used". */
  notSeen: string[];
  refused: AuditDestination[];
  unmatched: AuditDestination[];
  dropped: number;
  /** What the owner should look at (see `observationFindings`), `null` when nothing. */
  findings: ObservationFinding | null;
  /** Distinct findings: `findings.count`, 0 when none. */
  findingCount: number;
  /** A run's observation stopped at its one-day bound (1440 window files). */
  stopped: boolean;
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

/** The same normalisation `planForwardEntries` applies, so a declared key compares with a used one. */
function normalisedSet(network: readonly string[]): string[] {
  return [...new Set(network.map(networkEntryKey))];
}

/** Compared by parse key, never as strings of different forms. */
function isNarrowed(declared: readonly string[], approved: readonly string[] | undefined): boolean {
  return approved !== undefined && isNetworkNarrowed(declared, approved);
}

function offerFor(
  source: ReturnType<typeof declaredNetworkFor>,
  coverage: CoverageRow | undefined,
  rows: readonly ObservationRow[],
  version: string,
): NarrowingOffer | null {
  // Computed against the manifest only: a grant fallback is not what the approval re-resolves.
  if (coverage === undefined || source.from !== "manifest" || source.approved === undefined) {
    return null;
  }
  return narrowingOffer({
    os: coverage.os,
    declaredRaw: source.entries,
    approved: source.approved,
    coverage: {
      networkObserved: coverage.network_observed === 1,
      runs: coverage.runs,
      observedDays: daysSpanned(coverage),
      dropped: coverage.dropped,
      stopped: coverage.stopped === 1,
    },
    used: rows.filter((r) => r.outcome === "used"),
    unmatched: rows.filter((r) => r.outcome === "unmatched"),
    installedVersion: version,
    coverageVersion: coverage.version,
  });
}

function entryFor(
  db: Database,
  id: string,
  version: string,
  installed: readonly ExtensionRow[],
): AuditEntry {
  const { coverage, rows } = readExtensionAudit(db, id, version);
  const source = declaredNetworkFor(db, id, version, installed);
  const declared = normalisedSet(source.entries);
  const approved = source.approved === undefined ? undefined : normalisedSet(source.approved);
  const used = ofOutcome(rows, "used");
  const usedKeys = new Set(used.map((u) => `${u.destination}:${u.port}`.toLowerCase()));
  const networkObserved = coverage !== undefined && coverage.network_observed === 1;
  const base = {
    id,
    version,
    networkObserved,
    declared,
    declaredFrom: source.from,
    ...(approved === undefined ? {} : { approved }),
    narrowed: source.from === "manifest" && isNarrowed(declared, approved),
    offer: offerFor(source, coverage, rows, version),
    used,
    // Only where the network was observed: elsewhere "not seen" would read as a finding.
    notSeen: networkObserved ? declared.filter((d) => !usedKeys.has(d)) : [],
    refused: ofOutcome(rows, "refused"),
    unmatched: ofOutcome(rows, "unmatched"),
  };
  if (coverage === undefined) {
    return {
      ...base,
      runs: 0,
      observedDays: 0,
      dropped: 0,
      stopped: false,
      findings: null,
      findingCount: 0,
    };
  }
  const findings = observationFindings({
    os: coverage.os,
    declared,
    refused: base.refused,
    unmatched: base.unmatched,
  });
  return {
    ...base,
    findings,
    findingCount: findings?.count ?? 0,
    os: coverage.os,
    runs: coverage.runs,
    observedDays: daysSpanned(coverage),
    firstSeen: coverage.first_seen,
    lastSeen: coverage.last_seen,
    dropped: coverage.dropped,
    stopped: coverage.stopped === 1,
  };
}

/** `undefined` when `id` names no installed extension. Read-only; the installed version only. */
export function readAuditEntries(db: Database, id?: string): AuditEntry[] | undefined {
  const installed = listExtensions(db);
  const chosen = id === undefined ? installed : installed.filter((r) => r.id === id);
  if (id !== undefined && chosen.length === 0) return undefined;
  return chosen.map((r) => entryFor(db, r.id, r.version, installed));
}
