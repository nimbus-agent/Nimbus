// Phase 7 (the Cost Pack): the FOCUS CSV reader. A FinOps Open Cost and Usage Specification (FOCUS 1.x)
// export from AWS, Azure or Google Cloud becomes daily `CostLine`s.
//
// Confined by static rule D48 (no network, no connector, no model). Pure: text in, lines out. The CSV
// parser is dependency-free RFC 4180 (a UTF-8 BOM is stripped, CRLF and LF both end a record, quoted
// fields may hold commas, doubled quotes and line breaks). Parquet is not read (no vetted, licence-clean,
// native-free reader); the docs say CSV only.
import {
  COST_CHARGE_CATEGORIES,
  type CostChargeCategory,
  type CostLine,
  type CostLineKey,
  costLineGrainHash,
  setTag,
} from "./cost-line.ts";

export class FocusCsvError extends Error {
  override readonly name = "FocusCsvError";
}

export const FOCUS_SOURCE = "focus";
export const FOCUS_REQUIRED_COLUMNS = [
  "BilledCost",
  "BillingCurrency",
  "ChargePeriodStart",
  "ServiceName",
] as const;
export const FOCUS_MAX_TAGS = 50;
export const FOCUS_MAX_TAG_CHARS = 128;
export type FocusProvider = "aws" | "azure" | "gcp";

/** RFC 4180 records. Throws {@link FocusCsvError} on an unterminated quoted field. */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const st: CsvState = { src, i: 0, field: "", record: [], records: [], quoted: false };
  while (st.i < src.length) {
    if (st.quoted) quotedStep(st);
    else plainStep(st);
  }
  if (st.quoted) throw new FocusCsvError("the CSV ends inside a quoted field");
  if (st.field !== "" || st.record.length > 0) endRecord(st);
  return st.records;
}

type CsvState = {
  readonly src: string;
  i: number;
  field: string;
  record: string[];
  readonly records: string[][];
  quoted: boolean;
};

function endField(st: CsvState): void {
  st.record.push(st.field);
  st.field = "";
}

function endRecord(st: CsvState): void {
  endField(st);
  if (!(st.record.length === 1 && st.record[0] === "")) st.records.push(st.record);
  st.record = [];
}

/** Inside quotes: a doubled quote is one quote, a single quote closes, anything else is data. */
function quotedStep(st: CsvState): void {
  const c = st.src[st.i];
  if (c !== '"') {
    st.field += c;
    st.i++;
  } else if (st.src[st.i + 1] === '"') {
    st.field += '"';
    st.i += 2;
  } else {
    st.quoted = false;
    st.i++;
  }
}

/** Outside quotes: a quote opens an empty field, a comma ends a field, CRLF or LF ends a record. */
function plainStep(st: CsvState): void {
  const c = st.src[st.i];
  if (c === '"' && st.field === "") st.quoted = true;
  else if (c === ",") endField(st);
  else if (c === "\n") endRecord(st);
  else if (c === "\r" && st.src[st.i + 1] === "\n") {
    endRecord(st);
    st.i++;
  } else st.field += c;
  st.i++;
}

export interface FocusRowIssue {
  /** The CSV record number (the header is record 1). */
  readonly row: number;
  readonly reason: string;
}

export interface FocusPeriod {
  readonly key: CostLineKey;
  /** Every charge day the file has for this tuple (the days an import replaces). */
  readonly days: Set<string>;
  /** The file's own total of `BilledCost` per currency, from the accepted rows. */
  readonly totals: Map<string, number>;
}

export interface FocusParseResult {
  readonly lines: CostLine[];
  /** Keyed `provider|billingAccountId|billingPeriod`. */
  readonly byPeriod: Map<string, FocusPeriod>;
  readonly skipped: FocusRowIssue[];
  readonly warnings: FocusRowIssue[];
}

export interface FocusParseOptions {
  readonly provider?: FocusProvider;
  readonly importId: string;
}

const PROVIDER_ALIASES: Readonly<Record<string, FocusProvider>> = {
  aws: "aws",
  "amazon web services": "aws",
  amazon: "aws",
  azure: "azure",
  microsoft: "azure",
  "microsoft azure": "azure",
  gcp: "gcp",
  google: "gcp",
  "google cloud": "gcp",
  "google cloud platform": "gcp",
};

function providerSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** The provider of a row, or a reason it has none. */
function resolveProvider(
  name: string,
  forced: FocusProvider | undefined,
): { provider: string } | { reason: string } {
  const trimmed = name.trim();
  const known = PROVIDER_ALIASES[trimmed.toLowerCase()];
  if (forced !== undefined) {
    if (known !== undefined && known !== forced) {
      return { reason: `ProviderName ${trimmed} is not --provider ${forced}` };
    }
    return { provider: forced };
  }
  if (known !== undefined) return { provider: known };
  const slug = providerSlug(trimmed);
  if (slug === "") return { reason: "ProviderName is empty; pass --provider aws|azure|gcp" };
  return { provider: slug };
}

/** UTC instant of a FOCUS datetime; a timestamp with no zone is UTC. */
function parseInstant(text: string): number | null {
  const t = text.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(t)) return null;
  let iso = t.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) iso += "T00:00:00Z";
  else if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(iso)) iso += "Z";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function parseAmount(text: string): number | null {
  const t = text.trim();
  if (t === "" || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseCategory(text: string): CostChargeCategory | null {
  const t = text.trim().toLowerCase();
  if (t === "") return "usage";
  return (COST_CHARGE_CATEGORIES as readonly string[]).includes(t)
    ? (t as CostChargeCategory)
    : null;
}

/** The `Tags` cell as a JSON object, or null (a warning when it is present but not an object). */
function tagObject(
  text: string,
  row: number,
  warnings: FocusRowIssue[],
): Record<string, unknown> | null {
  const t = text.trim();
  if (t === "") return null;
  let v: unknown = null;
  try {
    v = JSON.parse(t);
  } catch {
    v = null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    warnings.push({ row, reason: "Tags is not a JSON object; the row keeps no tags" });
    return null;
  }
  return v as Record<string, unknown>;
}

/** One tag's string value, or the reason it is dropped. */
function tagValue(k: string, raw: unknown): { value: string } | { reason: string } {
  const name = k.slice(0, FOCUS_MAX_TAG_CHARS);
  const scalar = typeof raw === "number" || typeof raw === "boolean";
  if (typeof raw !== "string" && !scalar) return { reason: `tag ${name} dropped: not a string` };
  const value = String(raw);
  if (k.length > FOCUS_MAX_TAG_CHARS || value.length > FOCUS_MAX_TAG_CHARS) {
    return { reason: `tag ${name} dropped: longer than ${FOCUS_MAX_TAG_CHARS} characters` };
  }
  return { value };
}

function parseTags(text: string, row: number, warnings: FocusRowIssue[]): Record<string, string> {
  const obj = tagObject(text, row, warnings);
  if (obj === null) return {};
  const out: Record<string, string> = {};
  let kept = 0;
  let beyond = 0;
  for (const [k, raw] of Object.entries(obj)) {
    const r = tagValue(k, raw);
    if ("reason" in r) warnings.push({ row, reason: r.reason });
    else if (kept >= FOCUS_MAX_TAGS) beyond++;
    else {
      setTag(out, k, r.value);
      kept++;
    }
  }
  if (beyond > 0) {
    warnings.push({ row, reason: `${beyond} tags dropped beyond the first ${FOCUS_MAX_TAGS}` });
  }
  return out;
}

const nullable = (text: string | undefined): string | null => {
  const t = (text ?? "").trim();
  return t === "" ? null : t;
};

type Getter = (column: string) => string;

function columnIndex(header: readonly string[]): Map<string, number> {
  const idx = new Map<string, number>();
  header.forEach((h, i) => {
    const k = h.trim().toLowerCase();
    if (!idx.has(k)) idx.set(k, i);
  });
  const missing = FOCUS_REQUIRED_COLUMNS.filter((c) => !idx.has(c.toLowerCase()));
  if (missing.length > 0) {
    throw new FocusCsvError(`not a FOCUS export: missing required column ${missing.join(", ")}`);
  }
  return idx;
}

/** One accepted row as a line, or the reason it is skipped. */
function rowToLine(
  get: Getter,
  row: number,
  opts: FocusParseOptions,
  warnings: FocusRowIssue[],
): CostLine | { reason: string } {
  const billed = parseAmount(get("BilledCost"));
  if (billed === null)
    return { reason: `BilledCost is not a number: ${get("BilledCost").slice(0, 64)}` };
  const effText = get("EffectiveCost").trim();
  const effective = effText === "" ? null : parseAmount(effText);
  if (effText !== "" && effective === null) {
    return { reason: `EffectiveCost is not a number: ${effText.slice(0, 64)}` };
  }
  const currency = get("BillingCurrency").trim();
  if (currency === "" || currency.length > 16)
    return { reason: "BillingCurrency is empty or too long" };
  const startMs = parseInstant(get("ChargePeriodStart"));
  if (startMs === null) {
    return { reason: `ChargePeriodStart is not a date: ${get("ChargePeriodStart").slice(0, 64)}` };
  }
  const serviceName = get("ServiceName").trim();
  if (serviceName === "") return { reason: "ServiceName is empty" };
  const category = parseCategory(get("ChargeCategory"));
  if (category === null)
    return { reason: `ChargeCategory is not a FOCUS value: ${get("ChargeCategory").slice(0, 64)}` };
  const provider = resolveProvider(
    get("ProviderName") || get("ServiceProviderName"),
    opts.provider,
  );
  if ("reason" in provider) return provider;
  const chargeDay = new Date(startMs).toISOString().slice(0, 10);
  const periodMs = parseInstant(get("BillingPeriodStart"));
  const billingPeriod = (periodMs === null ? chargeDay : new Date(periodMs).toISOString()).slice(
    0,
    7,
  );
  return {
    source: FOCUS_SOURCE,
    provider: provider.provider,
    billingAccountId: get("BillingAccountId").trim().slice(0, 256),
    billingPeriod,
    chargeDay,
    subAccountId: nullable(get("SubAccountId")),
    subAccountName: nullable(get("SubAccountName")),
    serviceName,
    serviceCategory: nullable(get("ServiceCategory")),
    regionId: nullable(get("RegionId")),
    resourceId: nullable(get("ResourceId")),
    resourceName: nullable(get("ResourceName")),
    skuId: nullable(get("SkuId")),
    chargeCategory: category,
    billedCost: billed,
    effectiveCost: effective,
    currency,
    tags: parseTags(get("Tags"), row, warnings),
    repo: null,
    workflow: null,
    model: null,
    importId: opts.importId,
  };
}

/** Sum a second raw row of the same grain into the line already held for it. */
function merge(into: CostLine, add: CostLine): CostLine {
  const effective =
    into.effectiveCost === null && add.effectiveCost === null
      ? null
      : (into.effectiveCost ?? 0) + (add.effectiveCost ?? 0);
  return { ...into, billedCost: into.billedCost + add.billedCost, effectiveCost: effective };
}

/**
 * Parse a FOCUS CSV export. Throws {@link FocusCsvError} when the text is not a FOCUS export (a required
 * column is missing, or a quoted field never ends). Rows that share (provider, billing account, charge day,
 * grain) are aggregated into one line, so the stored unique key never collides and totals still reconcile.
 */
export function parseFocusCsv(text: string, opts: FocusParseOptions): FocusParseResult {
  const records = parseCsv(text);
  const header = records[0];
  if (header === undefined) throw new FocusCsvError("the file is empty");
  const idx = columnIndex(header);
  const skipped: FocusRowIssue[] = [];
  const warnings: FocusRowIssue[] = [];
  const merged = new Map<string, CostLine>();
  const byPeriod = new Map<string, FocusPeriod>();
  for (let r = 1; r < records.length; r++) {
    const fields = records[r] ?? [];
    const rowNo = r + 1;
    if (fields.length !== header.length) {
      skipped.push({
        row: rowNo,
        reason: `${fields.length} fields where the header has ${header.length}`,
      });
      continue;
    }
    const get: Getter = (column) => {
      const i = idx.get(column.toLowerCase());
      return i === undefined ? "" : (fields[i] ?? "");
    };
    const line = rowToLine(get, rowNo, opts, warnings);
    if ("reason" in line) {
      skipped.push({ row: rowNo, reason: line.reason });
      continue;
    }
    const periodKey = `${line.provider}|${line.billingAccountId}|${line.billingPeriod}`;
    let period = byPeriod.get(periodKey);
    if (period === undefined) {
      period = {
        key: {
          source: line.source,
          provider: line.provider,
          billingAccountId: line.billingAccountId,
          billingPeriod: line.billingPeriod,
        },
        days: new Set(),
        totals: new Map(),
      };
      byPeriod.set(periodKey, period);
    }
    period.days.add(line.chargeDay);
    period.totals.set(line.currency, (period.totals.get(line.currency) ?? 0) + line.billedCost);
    const grainKey = `${periodKey}|${line.chargeDay}|${line.currency}|${costLineGrainHash(line)}`;
    const prior = merged.get(grainKey);
    merged.set(grainKey, prior === undefined ? line : merge(prior, line));
  }
  return { lines: [...merged.values()], byPeriod, skipped, warnings };
}
