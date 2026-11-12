import { createHash } from "node:crypto";
import {
  type CostDimensionKind,
  type CostPoint,
  type RolledCostRow,
  seriesHashOf,
  seriesKeyOf,
  startOfUtcDay,
  utcDateString,
} from "../finops/cost-item-contract.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE = "vantage";
const TITLE_MAX = 200;
const VALUE_MAX = 200;
const NUMERIC_CHARS = /^[-+.\deE]+$/;

/**
 * Fields of a vendor cost row that are measurements or dates, never dimensions. Anything else that
 * holds a non-empty string is a dimension (the documented example row has provider, account_id and
 * service). A field ending in `_cost` or `_amount` is a measurement sibling (`total_cost`).
 */
const METRIC_FIELDS: ReadonlySet<string> = new Set(["accrued_at", "amount", "currency"]);

const KIND_BY_FIELD: Readonly<Record<string, CostDimensionKind>> = {
  account_id: "account",
  billing_account_id: "account",
  service: "service",
  provider: "provider",
  cost_category: "cost_category",
  cost_subcategory: "cost_category",
};

export interface VantageCostMapContext {
  /** The cost-report token, or "default". */
  readonly scopeId: string;
  /** `vantage.group_by`, in order; the order of dimension names in the series. */
  readonly groupBy: readonly string[];
}

export interface VantageMappingContext {
  readonly syncedAt: number;
}

export type VantageMappedRow = MappedRow<"vantage", "cost_allocation" | "cost_recommendation">;

function isMetricField(name: string): boolean {
  return METRIC_FIELDS.has(name) || name.endsWith("_cost") || name.endsWith("_amount");
}

/** A finite JSON number, or a numeric string; anything else is null. */
function numberOrNumericString(v: unknown): number | null {
  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v === "string" && NUMERIC_CHARS.test(v.trim())) {
    // Number() parses sign, decimal point and exponent; the charset check keeps hex, binary,
    // "Infinity" and other spellings out.
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function dayOf(v: unknown): number | null {
  if (typeof v !== "string") {
    return null;
  }
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? startOfUtcDay(ms) : null;
}

function escapeValue(v: string): string {
  return v.replaceAll("%", "%25").replaceAll("/", "%2F");
}

/** A value over {@link VALUE_MAX} is cut, then ends with an ellipsis and 6 hex of its own hash. */
function boundedValue(v: string): string {
  if (v.length <= VALUE_MAX) {
    return v;
  }
  const suffix = createHash("sha256").update(v, "utf8").digest("hex").slice(0, 6);
  return `${v.slice(0, VALUE_MAX - 7)}…${suffix}`;
}

/** Code-unit order: deterministic on every machine, unlike a locale compare. */
function compareNames(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function dimensionNames(row: Record<string, unknown>, groupBy: readonly string[]): string[] {
  const present = (name: string): boolean => {
    const v = row[name];
    return typeof v === "string" && v !== "" && !isMetricField(name);
  };
  const ordered = groupBy.filter((name, i) => present(name) && groupBy.indexOf(name) === i);
  const rest = Object.keys(row)
    .filter((name) => present(name) && !ordered.includes(name))
    .sort(compareNames);
  return [...ordered, ...rest];
}

function kindAndKey(name: string): { kind: CostDimensionKind; key: string | null } {
  if (name.startsWith("tag:")) {
    return { kind: "tag", key: name.slice(4) };
  }
  return { kind: KIND_BY_FIELD[name] ?? "other", key: null };
}

/**
 * One vendor cost row to a {@link CostPoint}, or null when it cannot be one (not an object, no
 * usable day, no finite amount). Nothing about a dropped row is logged by value.
 */
export function mapVantageCostRow(raw: unknown, ctx: VantageCostMapContext): CostPoint | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const dayMs = dayOf(row["accrued_at"]);
  const amount = numberOrNumericString(row["amount"]);
  if (dayMs === null || amount === null) {
    return null;
  }
  const rawCurrency = stringField(row, "currency");
  const currency =
    rawCurrency !== undefined && /^[A-Za-z]{3}$/.test(rawCurrency) ? rawCurrency : null;
  const names = dimensionNames(row, ctx.groupBy);
  const first = names[0];
  const { kind, key } =
    first === undefined ? { kind: "other" as const, key: null } : kindAndKey(first);
  const value =
    first === undefined
      ? "total"
      : boundedValue(names.map((n) => escapeValue(String(row[n]))).join(" / "));
  const provider = stringField(row, "provider");
  const service = stringField(row, "service");
  return {
    scopeId: ctx.scopeId,
    dimensionKind: kind,
    dimensionKey: key,
    dimensionValue: value,
    groupings: names,
    seriesKey: seriesKeyOf(SERVICE, ctx.scopeId, kind, key, value),
    seriesHash: seriesHashOf(kind, key, value),
    dayMs,
    amount,
    currency,
    provider: provider !== undefined && provider !== "" ? provider : null,
    cloudService: service !== undefined && service !== "" ? service : null,
  };
}

/** The index row of one rolled-up day of one series (spec section 5.1: metadata_only, no body). */
export function costAllocationItem(rolled: RolledCostRow, syncedAt: number): VantageMappedRow {
  const m = rolled.metadata;
  const money = m.currency === null ? String(m.amount) : `${String(m.amount)} ${m.currency}`;
  const title = `${m.dimensionValue} ${utcDateString(rolled.dayMs)} ${money}`.slice(0, TITLE_MAX);
  // Literal service, type and metadata keys on purpose: the index-lane census reads them as the
  // writer's emissions (docs/structure-audit/index-lane-census.json), and a spread would hide them.
  return {
    service: "vantage",
    type: "cost_allocation",
    externalId: rolled.externalId,
    title,
    bodyPreview: title,
    url: null,
    canonicalUrl: null,
    modifiedAt: Math.min(m.periodEndMs, syncedAt),
    metadata: {
      seriesKey: m.seriesKey,
      seriesHash: m.seriesHash,
      scopeId: m.scopeId,
      dimensionKind: m.dimensionKind,
      dimensionKey: m.dimensionKey,
      dimensionValue: m.dimensionValue,
      groupings: m.groupings,
      periodStartMs: m.periodStartMs,
      periodEndMs: m.periodEndMs,
      granularity: m.granularity,
      amount: m.amount,
      currency: m.currency,
      costKind: m.costKind,
      unit: m.unit,
      finalized: m.finalized,
      provider: m.provider,
      cloudService: m.cloudService,
      rowCount: m.rowCount,
    },
    syncedAt,
  };
}

function textOrNull(row: Record<string, unknown>, key: string): string | null {
  const v = stringField(row, key);
  return v !== undefined && v !== "" ? v : null;
}

function isoMsOrNull(v: unknown): number | null {
  if (typeof v !== "string") {
    return null;
  }
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** One vendor recommendation to an index row; the id is the vendor token. Null when it has none. */
export function mapVantageRecommendationToItem(
  raw: unknown,
  ctx: VantageMappingContext,
): VantageMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const token = textOrNull(row, "token");
  if (token === null) {
    return null;
  }
  const type = textOrNull(row, "type");
  const title = (textOrNull(row, "description") ?? type ?? "Vantage recommendation").slice(
    0,
    TITLE_MAX,
  );
  const createdAtMs = isoMsOrNull(row["created_at"]);
  const resources = row["resources_affected_count"];
  return {
    service: "vantage",
    type: "cost_recommendation",
    externalId: token,
    title,
    bodyPreview: title,
    url: null,
    canonicalUrl: null,
    modifiedAt: createdAtMs ?? ctx.syncedAt,
    metadata: {
      recommendationType: type,
      category: textOrNull(row, "category"),
      provider: textOrNull(row, "provider"),
      cloudService: textOrNull(row, "service"),
      providerAccountId: textOrNull(row, "provider_account_id"),
      estimatedMonthlySavings: numberOrNumericString(row["potential_savings"]),
      currency: textOrNull(row, "currency_code"),
      resourcesAffected:
        typeof resources === "number" && Number.isFinite(resources) ? resources : null,
      createdAtMs,
      documentationUrl: textOrNull(row, "documentation_url"),
    },
    syncedAt: ctx.syncedAt,
  };
}
