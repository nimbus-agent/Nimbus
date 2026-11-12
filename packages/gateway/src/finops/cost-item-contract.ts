// Phase 10 FinOps: the contract of a cost row in the local index (spec section 5.1).
//
// Pure constants and functions. This directory is confined by static rule D48 (`finops-confined`):
// no network, no connector dispatch, no model, no egress. Keep it that way: a mapper that needs a
// connector lives in `connectors/`, and this file holds only what the mapper, the reader and the
// retention pass share.
import { createHash } from "node:crypto";

export const COST_ALLOCATION_TYPE = "cost_allocation";
export const COST_RECOMMENDATION_TYPE = "cost_recommendation";

/** The services whose `cost_allocation` rows this contract covers (FO2 ships `vantage`). */
export const COST_SERVICE_IDS = [
  "vantage",
  "cloudhealth",
  "flexera",
  "kubecost",
  "opencost",
] as const;
export type CostServiceId = (typeof COST_SERVICE_IDS)[number];

export const DAY_MS = 86_400_000;
/** A day whose period ended less than this many days before the sync may still be restated. */
export const RESTATE_WINDOW_DAYS = 3;
/** The first sync reads this many days. */
export const FIRST_WINDOW_DAYS = 45;
/** The dimension value of the max-series remainder. */
export const OTHER_VALUE = "__other__";

export type CostDimensionKind =
  | "tag"
  | "account"
  | "service"
  | "provider"
  | "cost_category"
  | "namespace"
  | "controller"
  | "cluster"
  | "perspective"
  | "other";

/** The metadata of one `cost_allocation` row (spec section 5.1, plus the three additions of FO2). */
export interface CostAllocationMetadata {
  readonly seriesKey: string;
  readonly seriesHash: string;
  /**
   * `<series scope>~<seriesHash>`: the series scope is the report or workspace plus the grouping, so
   * the named set is counted per configuration (a changed configuration does not fill the cap).
   */
  readonly scopeSeries: string;
  readonly scopeId: string;
  readonly dimensionKind: CostDimensionKind;
  readonly dimensionKey: string | null;
  readonly dimensionValue: string;
  readonly groupings: readonly string[];
  readonly periodStartMs: number;
  readonly periodEndMs: number;
  readonly granularity: "day";
  readonly amount: number;
  readonly currency: string | null;
  readonly costKind: "billed" | "amortized" | "list_estimate" | "unknown";
  readonly unit: "currency";
  readonly finalized: boolean;
  readonly provider: string | null;
  readonly cloudService: string | null;
  /** How many vendor rows were summed into this row: 1 for a named series, n for `__other__`. */
  readonly rowCount: number;
}

/** One vendor row after mapping, before it is folded into the named set (a mapper's output). */
export interface CostPoint {
  readonly scopeId: string;
  readonly dimensionKind: CostDimensionKind;
  readonly dimensionKey: string | null;
  readonly dimensionValue: string;
  readonly groupings: readonly string[];
  readonly seriesKey: string;
  readonly seriesHash: string;
  readonly dayMs: number;
  readonly amount: number;
  readonly currency: string | null;
  readonly provider: string | null;
  readonly cloudService: string | null;
}

/** One row ready to be indexed: its item id (external id) and metadata. */
export interface RolledCostRow {
  readonly externalId: string;
  readonly dayMs: number;
  readonly metadata: CostAllocationMetadata;
}

const SCOPE_MAX = 40;
const CLEAN_SCOPE = /^[A-Za-z0-9_-]+$/;

function escapePart(part: string): string {
  return part.replace(/[\\|]/g, String.raw`\$&`);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** First 16 hex of SHA-256 over `kind|key|value`, each part escaped, so a pipe cannot move a boundary. */
export function seriesHashOf(kind: string, key: string | null, value: string): string {
  return sha256Hex([kind, key ?? "", value].map(escapePart).join("|")).slice(0, 16);
}

/** `<service>|<scopeId>|<kind>|<key>|<value>` with each part escaped (spec section 5.1). */
export function seriesKeyOf(
  service: string,
  scopeId: string,
  kind: string,
  key: string | null,
  value: string,
): string {
  return [service, scopeId, kind, key ?? "", value].map(escapePart).join("|");
}

/** A scope id safe to put in an item id: `[A-Za-z0-9_-]` up to 40 characters, else 12 hex of its hash. */
export function sanitiseScopeId(raw: string | null): string {
  if (raw === null || raw === "") {
    return "default";
  }
  return raw.length <= SCOPE_MAX && CLEAN_SCOPE.test(raw) ? raw : sha256Hex(raw).slice(0, 12);
}

/** `YYYY-MM-DD` of `ms` in UTC. */
export function utcDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** `<scopeId>:<seriesHash>:<YYYY-MM-DD>`, at most 80 characters. */
export function costRowExternalId(scopeId: string, seriesHash: string, dayMs: number): string {
  return `${sanitiseScopeId(scopeId)}:${seriesHash}:${utcDateString(dayMs)}`;
}

/** A day is final once its period ended at least {@link RESTATE_WINDOW_DAYS} days before the sync. */
export function finalizedFor(periodEndMs: number, syncedAt: number): boolean {
  return periodEndMs <= syncedAt - RESTATE_WINDOW_DAYS * DAY_MS;
}

export function isCostItemType(type: string): boolean {
  return type === COST_ALLOCATION_TYPE || type === COST_RECOMMENDATION_TYPE;
}

export function isCostServiceId(service: string): service is CostServiceId {
  return (COST_SERVICE_IDS as readonly string[]).includes(service);
}
