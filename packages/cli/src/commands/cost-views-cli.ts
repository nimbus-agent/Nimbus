import { stripControlChars } from "../lib/strip-control-chars.ts";

/**
 * `nimbus cost products [--period 30d] [--allocation cluster] [--json|--csv]` and
 * `nimbus cost internal [--period 30d] [--json|--csv]` (Phase 7, the Cost Pack): cost per product, and the
 * internal cost (CI and the dev/test environments), from the local cost lines and the owner's
 * `[[cost.rule]]` rules. Nothing is fetched and nothing leaves the machine.
 *
 * Amounts are shown per currency and never summed across currencies. Every output states the unassigned share
 * and the source freshness. Exit codes: 0 for a view (including a period whose cost is 0), 1 for "no cost data
 * imported", a refused cost config and any error.
 *
 * CSV: a fixed header (`COST_PRODUCTS_CSV_HEADER` / `COST_INTERNAL_CSV_HEADER`), one row per currency and group,
 * unassigned rows with an empty product (or env) and the reason; a text cell that starts with `=`, `+`, `-`,
 * `@`, a tab or a carriage return is prefixed with `'` so a spreadsheet never runs it as a formula.
 */
export interface CostViewsIpc {
  call(method: string, params?: unknown): Promise<unknown>;
}
export interface CostViewsSink {
  out(s: string): void;
  err(s: string): void;
}

export interface CostViewsArgs {
  readonly view: "products" | "internal";
  readonly period: string;
  readonly cluster: boolean;
  readonly format: "text" | "json" | "csv";
}

export const COST_PRODUCTS_CSV_HEADER =
  "currency,product,env,service,provider,amount,unassigned_reason";
export const COST_INTERNAL_CSV_HEADER =
  "currency,env,product,service,provider,amount,unassigned_reason";
export const COST_CLUSTER_CSV_HEADER = "currency,service,dimension,name,amount";

export function parseCostViewsArgs(
  view: "products" | "internal",
  args: readonly string[],
): CostViewsArgs | undefined {
  let period = "30d";
  let cluster = false;
  let format: CostViewsArgs["format"] = "text";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json" || a === "--csv") {
      if (format !== "text") return undefined;
      format = a === "--json" ? "json" : "csv";
    } else if (a === "--period") {
      const v = args[++i];
      if (v === undefined || !/^(\d{1,3}d|week|month)$/.test(v)) return undefined;
      period = v;
    } else if (a === "--allocation" && view === "products") {
      if (args[++i] !== "cluster") return undefined;
      cluster = true;
    } else return undefined;
  }
  return { view, period, cluster, format };
}

type Row = {
  key: string;
  secondary: string | null;
  part: string;
  provider: string;
  amount: number;
};
type Block = {
  total: number;
  rows: Row[];
  unassigned: number;
  unassignedReasons: { reason: string; amount: number; lines: number }[];
  outside: number;
};
type ViewResult = {
  view: "products" | "internal";
  range: { fromDay: string; toDay: string; label: string };
  byCurrency: Record<string, Block>;
  freshness: { source: string; lastDay: string | null; provisionalFrom: string | null }[];
  empty: boolean;
  excludedSources: { source: string; provider: string; reason: string }[];
  notes: string[];
  configError: string | null;
  internalEnvs?: string[];
};
type ClusterResult = {
  view: "cluster";
  range: { fromDay: string; toDay: string; label: string };
  rows: { service: string; dimension: string; name: string; currency: string; amount: number }[];
};

const clean = (s: string): string => stripControlChars(s).slice(0, 200);
const money = (n: number): string => n.toFixed(2);

export function csvCell(value: string): string {
  const v = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function pct(part: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}

function renderBlockText(r: ViewResult, currency: string, b: Block, sink: CostViewsSink): void {
  const c = clean(currency);
  sink.out(`${c}\n`);
  let current: string | null = null;
  const subtotal = (key: string): number =>
    b.rows.filter((x) => x.key === key).reduce((a, x) => a + x.amount, 0);
  for (const row of b.rows) {
    if (row.key !== current) {
      current = row.key;
      sink.out(`  ${clean(row.key).padEnd(32)} ${money(subtotal(row.key)).padStart(14)}\n`);
    }
    const second = row.secondary === null ? "-" : clean(row.secondary);
    sink.out(
      `    ${`${second}  ${clean(row.part)} (${clean(row.provider)})`.padEnd(46)} ${money(row.amount).padStart(14)}\n`,
    );
  }
  if (r.view === "internal" && b.outside !== 0) {
    sink.out(`  ${"other envs (not internal)".padEnd(32)} ${money(b.outside).padStart(14)}\n`);
  }
  sink.out(
    `  ${"unassigned".padEnd(32)} ${money(b.unassigned).padStart(14)}  (${pct(b.unassigned, b.total)} of ${c})\n`,
  );
  for (const u of b.unassignedReasons) {
    sink.out(
      `    ${clean(u.reason).padEnd(46)} ${money(u.amount).padStart(14)}  (${String(u.lines)} lines)\n`,
    );
  }
  sink.out(`  ${"total".padEnd(32)} ${money(b.total).padStart(14)}\n`);
}

function renderFooter(r: ViewResult, sink: CostViewsSink): void {
  for (const f of r.freshness) {
    const prov = f.provisionalFrom === null ? "" : ` (provisional from ${f.provisionalFrom})`;
    sink.out(`Source ${clean(f.source)}: data up to ${f.lastDay ?? "none"}${prov}\n`);
  }
  for (const e of r.excludedSources) {
    sink.out(
      `Note: ${clean(e.source)} lines for ${clean(e.provider)} are not counted: ${clean(e.reason)}\n`,
    );
  }
  for (const n of r.notes) sink.out(`Note: ${clean(n)}\n`);
}

function renderText(r: ViewResult, sink: CostViewsSink): number {
  if (r.configError !== null) {
    sink.err(`The [cost] config is refused, so no rule applies: ${clean(r.configError)}\n`);
    return 1;
  }
  if (r.empty) {
    sink.err(
      'No cost data imported. Import a FOCUS export with "nimbus cost import <file|dir>".\n',
    );
    return 1;
  }
  const what =
    r.view === "products"
      ? "Cost by product"
      : `Internal cost (${(r.internalEnvs ?? []).map(clean).join(", ")})`;
  sink.out(`${what}, ${r.range.fromDay} to ${r.range.toDay} (${r.range.label})\n`);
  const currencies = Object.keys(r.byCurrency);
  if (currencies.length > 1)
    sink.out("Several currencies: each has its own total; they are never added together.\n");
  for (const c of currencies) renderBlockText(r, c, r.byCurrency[c] as Block, sink);
  renderFooter(r, sink);
  return 0;
}

function renderCsv(r: ViewResult, sink: CostViewsSink): number {
  sink.out(`${r.view === "products" ? COST_PRODUCTS_CSV_HEADER : COST_INTERNAL_CSV_HEADER}\n`);
  for (const [currency, b] of Object.entries(r.byCurrency)) {
    for (const row of b.rows) {
      sink.out(
        `${[currency, row.key, row.secondary ?? "", row.part, row.provider].map(csvCell).join(",")},${money(row.amount)},\n`,
      );
    }
    for (const u of b.unassignedReasons) {
      sink.out(
        `${[currency, "", "", "", ""].map(csvCell).join(",")},${money(u.amount)},${csvCell(u.reason)}\n`,
      );
    }
  }
  if (r.configError !== null) {
    sink.err(`The [cost] config is refused, so no rule applies: ${clean(r.configError)}\n`);
    return 1;
  }
  return r.empty ? 1 : 0;
}

function renderCluster(
  r: ClusterResult,
  format: CostViewsArgs["format"],
  sink: CostViewsSink,
): number {
  if (format === "csv") {
    sink.out(`${COST_CLUSTER_CSV_HEADER}\n`);
    for (const x of r.rows) {
      sink.out(
        `${[x.currency, x.service, x.dimension, x.name].map(csvCell).join(",")},${money(x.amount)}\n`,
      );
    }
    return 0;
  }
  if (r.rows.length === 0) {
    sink.err("No Kubecost or OpenCost allocation is indexed for this period.\n");
    return 1;
  }
  sink.out(
    `Cluster allocation (Kubecost/OpenCost, not part of cloud totals), ${r.range.fromDay} to ${r.range.toDay}\n`,
  );
  for (const x of r.rows) {
    sink.out(
      `  ${`${clean(x.service)} ${clean(x.dimension)} ${clean(x.name)}`.padEnd(46)} ${money(x.amount).padStart(14)} ${clean(x.currency)}\n`,
    );
  }
  return 0;
}

export async function runCostViewsWith(
  c: CostViewsIpc,
  a: CostViewsArgs,
  sink: CostViewsSink,
): Promise<number> {
  try {
    const params: Record<string, unknown> = { period: a.period };
    if (a.cluster) params["allocation"] = "cluster";
    const r = (await c.call(a.view === "products" ? "cost.products" : "cost.internal", params)) as
      | ViewResult
      | ClusterResult;
    if (a.format === "json") {
      sink.out(`${JSON.stringify(r)}\n`);
      if (r.view === "cluster") return r.rows.length === 0 ? 1 : 0;
      return r.empty || r.configError !== null ? 1 : 0;
    }
    if (r.view === "cluster") return renderCluster(r, a.format, sink);
    return a.format === "csv" ? renderCsv(r, sink) : renderText(r, sink);
  } catch (e) {
    sink.err(`nimbus cost ${a.view}: ${clean(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}
