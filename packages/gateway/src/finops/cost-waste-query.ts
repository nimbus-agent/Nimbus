// Phase 10 FinOps: the read surface of the cloud cost "garbage collection" report (slice G4a).
//
// Local index only (D48: no network, no connector, no model). One read of every indexed
// `cost_recommendation` row; each is classified by `classifyWaste`, the waste candidates are totalled
// per kind and PER CURRENCY (never summed across currencies), and what the report cannot see is said
// as plainly as what it found: "no recommendations indexed" and "nothing classified as waste" are
// different answers. Nothing here deletes, queues or proposes anything.
import type { Database } from "bun:sqlite";
import {
  COST_ALLOCATION_TYPE,
  COST_RECOMMENDATION_TYPE,
  COST_SERVICE_IDS,
  isCostServiceId,
} from "./cost-item-contract.ts";
import { classifyWaste, WASTE_KINDS, type WasteKind } from "./cost-waste.ts";

export const COST_WASTE_MAX_LISTED = 100;
/** A recommendation set last synced longer ago than this is reported as possibly stale. */
export const COST_WASTE_STALE_MS = 24 * 3_600_000;

export interface CostWasteQuery {
  readonly nowMs: number;
  readonly service?: string;
  readonly kind?: WasteKind;
}

export interface WasteCandidate {
  readonly itemId: string;
  readonly service: string;
  readonly kind: WasteKind;
  readonly title: string;
  readonly recommendationType: string | null;
  readonly provider: string | null;
  readonly cloudService: string | null;
  readonly accountId: string | null;
  readonly resourcesAffected: number | null;
  readonly estimatedMonthlySavings: number | null;
  readonly currency: string | null;
  readonly documentationUrl: string | null;
}

/** Savings summed within one currency; `null` is "the vendor gave no currency". */
export interface CurrencyTotal {
  readonly currency: string | null;
  readonly monthlySavings: number;
  readonly count: number;
}

export interface WasteKindTotal {
  readonly kind: WasteKind;
  readonly count: number;
  /** Candidates of this kind with no savings estimate: counted here, never as a zero amount. */
  readonly noEstimate: number;
  readonly totals: readonly CurrencyTotal[];
}

/**
 * `no_data`: nothing from a FinOps source is indexed at all (no recommendation and no cost row).
 * `no_waste_found`: FinOps data is indexed but no recommendation classifies as waste. That is NOT
 * "your cloud has no waste": nothing here scans the cloud, and the result says so.
 */
export type CostWasteStatus = "no_data" | "no_waste_found" | "waste";

export interface CostWasteResult {
  readonly status: CostWasteStatus;
  readonly asOfMs: number;
  readonly service: string | null;
  readonly kind: WasteKind | null;
  /** The newest `synced_at` of the recommendation rows read; null when none were read. */
  readonly lastSyncedMs: number | null;
  readonly counts: {
    readonly recommendations: number;
    readonly waste: number;
    readonly notWaste: number;
    /** Listed-kind candidates with no savings estimate: counted, never totalled as zero. */
    readonly noEstimate: number;
  };
  readonly byKind: readonly WasteKindTotal[];
  readonly totals: readonly CurrencyTotal[];
  /**
   * Grouped by currency (no currency last), largest saving first within it, no estimate last; at most
   * {@link COST_WASTE_MAX_LISTED}. Amounts in different currencies are never compared.
   */
  readonly candidates: readonly WasteCandidate[];
  readonly candidatesTruncated: number;
  readonly gaps: readonly string[];
}

interface Row {
  readonly id: string;
  readonly service: string;
  readonly title: string | null;
  readonly synced_at: number;
  readonly metadata: string | null;
}

function serviceFilter(service: string | undefined): readonly string[] {
  if (service === undefined) return COST_SERVICE_IDS;
  return isCostServiceId(service) ? [service] : [];
}

const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

function parseMeta(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const str = (m: Record<string, unknown>, k: string): string | null => {
  const v = m[k];
  return typeof v === "string" && v !== "" ? v : null;
};
/** A vendor documentation link, kept only when it is a plain http(s) URL. */
function httpUrlOrNull(v: string | null): string | null {
  if (v === null) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const num = (m: Record<string, unknown>, k: string): number | null => {
  const v = m[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

/** A candidate from one row; `not_waste` when it is no waste, null when it is another kind. */
function toCandidate(row: Row, kind: WasteKind | undefined): WasteCandidate | "not_waste" | null {
  const m = parseMeta(row.metadata);
  const title = row.title ?? "";
  const recommendationType = str(m, "recommendationType");
  const cls = classifyWaste({ recommendationType, category: str(m, "category"), title });
  if (cls === "not_waste") return "not_waste";
  if (kind !== undefined && cls !== kind) return null;
  const savings = num(m, "estimatedMonthlySavings");
  return {
    itemId: row.id,
    service: row.service,
    kind: cls,
    title,
    recommendationType,
    provider: str(m, "provider"),
    cloudService: str(m, "cloudService"),
    accountId: str(m, "providerAccountId"),
    resourcesAffected: num(m, "resourcesAffected"),
    estimatedMonthlySavings: savings !== null && savings >= 0 ? savings : null,
    currency: str(m, "currency"),
    documentationUrl: httpUrlOrNull(str(m, "documentationUrl")),
  };
}

/** Sum savings per currency; candidates with no estimate are left out of every sum. */
function currencyTotals(cands: readonly WasteCandidate[]): CurrencyTotal[] {
  const by = new Map<string, { currency: string | null; monthlySavings: number; count: number }>();
  for (const c of cands) {
    if (c.estimatedMonthlySavings === null) continue;
    const key = c.currency ?? "\u0000";
    const t = by.get(key) ?? { currency: c.currency, monthlySavings: 0, count: 0 };
    t.monthlySavings += c.estimatedMonthlySavings;
    t.count += 1;
    by.set(key, t);
  }
  return [...by.values()].sort(
    (a, b) =>
      b.monthlySavings - a.monthlySavings || (a.currency ?? "").localeCompare(b.currency ?? ""),
  );
}

/** Currency first (no currency last), then saving descending (no estimate last), title, id. */
function compareCandidates(a: WasteCandidate, b: WasteCandidate): number {
  if (a.currency !== b.currency) {
    if (a.currency === null) return 1;
    if (b.currency === null) return -1;
    return a.currency.localeCompare(b.currency);
  }
  const sa = a.estimatedMonthlySavings;
  const sb = b.estimatedMonthlySavings;
  if (sa !== sb) {
    if (sa === null) return 1;
    if (sb === null) return -1;
    return sb - sa;
  }
  return a.title.localeCompare(b.title) || a.itemId.localeCompare(b.itemId);
}

function countRows(db: Database, services: readonly string[], type: string): number {
  const r = db
    .query(
      `SELECT COUNT(*) AS n FROM item WHERE service IN (${placeholders(services.length)}) AND type = ?`,
    )
    .get(...services, type) as { n: number };
  return r.n;
}

function freshnessGaps(
  q: CostWasteQuery,
  lastSyncedMs: number | null,
  rowCount: number,
  costRows: number,
): string[] {
  const gaps: string[] = [];
  if (rowCount === 0 && costRows > 0) {
    gaps.push(
      "Cost rows are indexed but no recommendations are: the recommendation drain may have failed, or the vendor listed none.",
    );
  }
  if (lastSyncedMs !== null && q.nowMs - lastSyncedMs > COST_WASTE_STALE_MS) {
    gaps.push(
      `The recommendations were last synced ${new Date(lastSyncedMs).toISOString()}, more than 24 hours ago; the vendor's current list may differ.`,
    );
  }
  return gaps;
}

const HEURISTIC_GAP =
  "Waste is told from rightsizing and commitments by a keyword table over the vendor's type, category and description, which has not been checked against a live account.";
const SCOPE_GAP =
  "This lists only what the FinOps vendor recommends: nothing scans your cloud, no inventory is indexed and no resource ids are shown, so an empty list does not mean there is no waste.";

function kindTotals(cands: readonly WasteCandidate[]): WasteKindTotal[] {
  return WASTE_KINDS.map((kind) => {
    const of = cands.filter((c) => c.kind === kind);
    return {
      kind,
      count: of.length,
      noEstimate: of.filter((c) => c.estimatedMonthlySavings === null).length,
      totals: currencyTotals(of),
    };
  }).filter((t) => t.count > 0);
}

/** Read every indexed recommendation once and report the waste candidates among them. */
export function queryCostWaste(db: Database, q: CostWasteQuery): CostWasteResult {
  const services = serviceFilter(q.service);
  const base = {
    asOfMs: q.nowMs,
    service: q.service ?? null,
    kind: q.kind ?? null,
  };
  const rows =
    services.length === 0
      ? []
      : (db
          .query(
            `SELECT id, service, title, synced_at, metadata
               FROM item
              WHERE service IN (${placeholders(services.length)})
                AND type = ?`,
          )
          .all(...services, COST_RECOMMENDATION_TYPE) as Row[]);
  const costRows = services.length === 0 ? 0 : countRows(db, services, COST_ALLOCATION_TYPE);
  let lastSyncedMs: number | null = null;
  for (const r of rows) {
    if (lastSyncedMs === null || r.synced_at > lastSyncedMs) lastSyncedMs = r.synced_at;
  }
  const gaps = freshnessGaps(q, lastSyncedMs, rows.length, costRows);
  if (rows.length === 0 && costRows === 0) {
    return {
      ...base,
      status: "no_data",
      lastSyncedMs: null,
      counts: { recommendations: 0, waste: 0, notWaste: 0, noEstimate: 0 },
      byKind: [],
      totals: [],
      candidates: [],
      candidatesTruncated: 0,
      gaps: [
        "No FinOps data is indexed (no cost recommendations and no cost rows). Configure a FinOps source (for example vantage.api_token) and let it sync.",
        ...gaps,
      ],
    };
  }
  let notWaste = 0;
  let otherKind = 0;
  const cands: WasteCandidate[] = [];
  for (const r of rows) {
    const c = toCandidate(r, q.kind);
    if (c === "not_waste") notWaste += 1;
    else if (c === null) otherKind += 1;
    else cands.push(c);
  }
  cands.sort(compareCandidates);
  const noEstimate = cands.filter((c) => c.estimatedMonthlySavings === null).length;
  if (noEstimate > 0) {
    gaps.push(
      `${String(noEstimate)} candidate(s) have no savings estimate; they are counted, never totalled as zero.`,
    );
  }
  gaps.push(HEURISTIC_GAP, SCOPE_GAP);
  return {
    ...base,
    status: cands.length > 0 ? "waste" : "no_waste_found",
    lastSyncedMs,
    counts: {
      recommendations: rows.length,
      waste: cands.length + otherKind,
      notWaste,
      noEstimate,
    },
    byKind: kindTotals(cands),
    totals: currencyTotals(cands),
    candidates: cands.slice(0, COST_WASTE_MAX_LISTED),
    candidatesTruncated: Math.max(0, cands.length - COST_WASTE_MAX_LISTED),
    gaps,
  };
}
