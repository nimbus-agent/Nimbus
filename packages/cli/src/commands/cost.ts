import { CliExit } from "../lib/cli-exit.ts";
import { stripControlChars } from "../lib/strip-control-chars.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";

/**
 * `nimbus cost anomalies [--service <id>] [--days <n>] [--json]` - the cost anomaly detector over the
 * locally indexed daily cost series (Phase 10 FinOps). The gateway reads only the local index: nothing
 * is fetched and nothing leaves the machine. Series names come from a vendor, so every one is stripped
 * of control characters before it reaches the terminal.
 *
 * Exit codes: 0 when the check ran and judged at least one series (anomalies found or not: the text
 * and `--json` `status` say which), 1 for "no cost data", "not enough history" and any error.
 */
export interface CostIpc {
  call(method: string, params?: unknown): Promise<unknown>;
}
export interface CostSink {
  out(s: string): void;
  err(s: string): void;
}

export const COST_USAGE = "Usage: nimbus cost anomalies [--service <id>] [--days <1-30>] [--json]";

export interface CostAnomaliesArgs {
  readonly json: boolean;
  readonly service?: string;
  readonly days?: number;
}

type Anomaly = {
  seriesKey: string;
  name: string;
  dayMs: number;
  amount: number;
  baselineMean: number;
  baselineDays: number;
  ratio: number | null;
  excess: number;
  currency: string | null;
};
type AnomalyResult = {
  status: "no_data" | "insufficient_history" | "ok" | "anomalies";
  asOfMs: number;
  service: string | null;
  judgedDayMs: number | null;
  daysChecked: number;
  baseline: { days: number; minDays: number };
  thresholds: { ratio: number; minAmount: number };
  counts: {
    series: number;
    judged: number;
    anomalies: number;
    insufficientHistory: number;
    noDayData: number;
    mixedCurrency: number;
  };
  anomalies: Anomaly[];
  anomaliesTruncated: number;
  gaps: string[];
};

const DAY_MS = 86_400_000;
const clean = (s: string): string => stripControlChars(s);
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function parseCostAnomaliesArgs(argv: readonly string[]): CostAnomaliesArgs | undefined {
  let json = false;
  let service: string | undefined;
  let days: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--json") {
      json = true;
      continue;
    }
    const isService = a === "--service" || a.startsWith("--service=");
    const isDays = a === "--days" || a.startsWith("--days=");
    if (!isService && !isDays) return undefined;
    const flag = isService ? "--service" : "--days";
    let value: string | undefined;
    if (a === flag) {
      i += 1;
      value = argv[i];
    } else {
      value = a.slice(flag.length + 1);
    }
    if (value === undefined || value.trim() === "" || value.startsWith("-")) return undefined;
    if (isService) {
      if (service !== undefined) return undefined;
      service = value.trim();
    } else {
      if (days !== undefined || !/^\d+$/.test(value)) return undefined;
      days = Number(value);
      if (days < 1 || days > 30) return undefined;
    }
  }
  return {
    json,
    ...(service === undefined ? {} : { service }),
    ...(days === undefined ? {} : { days }),
  };
}

function money(n: number, currency: string | null): string {
  const text = n.toFixed(2);
  return currency === null ? text : `${text} ${clean(currency)}`;
}

function windowLine(r: AnomalyResult): string {
  if (r.judgedDayMs === null) return "";
  const newest = utcDay(r.judgedDayMs);
  const oldest = utcDay(r.judgedDayMs - (r.daysChecked - 1) * DAY_MS);
  const judged = oldest === newest ? newest : `${oldest} to ${newest}`;
  const first = utcDay(r.judgedDayMs - (r.daysChecked - 1 + r.baseline.days) * DAY_MS);
  const last = utcDay(r.judgedDayMs - DAY_MS);
  return (
    `Judged day${oldest === newest ? "" : "s"}: ${judged} (UTC, complete days only). ` +
    `Each is compared with the mean of the ${String(r.baseline.days)} days before it (` +
    `${first} to ${last} across the window; at least ${String(r.baseline.minDays)} complete days needed).\n`
  );
}

function countsLine(r: AnomalyResult): string {
  const c = r.counts;
  return (
    `${String(c.series)} series, ${String(c.judged)} checked, ${String(c.anomalies)} anomalous; ` +
    `skipped: ${String(c.insufficientHistory)} for lack of history, ${String(c.noDayData)} with no row on the day, ` +
    `${String(c.mixedCurrency)} with mixed currencies.\n`
  );
}

function anomalyLine(a: Anomaly): string {
  const ratio = a.ratio === null ? "baseline not positive" : `${a.ratio.toFixed(2)}x`;
  return (
    `  ${utcDay(a.dayMs)}  ${clean(a.name)}: ${money(a.amount, a.currency)} vs ` +
    `${money(a.baselineMean, a.currency)} baseline over ${String(a.baselineDays)} days ` +
    `(${ratio}, +${money(a.excess, a.currency)})\n`
  );
}

function renderResult(r: AnomalyResult, sink: CostSink): number {
  if (r.status === "no_data") {
    for (const g of r.gaps) sink.err(`${clean(g)}\n`);
    return 1;
  }
  const rules =
    `Rule: anomalous when the day is at least ${String(r.thresholds.ratio)}x its baseline AND ` +
    `exceeds it by at least ${String(r.thresholds.minAmount)} (series currency).\n`;
  if (r.status === "insufficient_history") {
    sink.err(
      "Not enough history to judge any series: no anomaly can be reported, and none can be ruled out.\n",
    );
    sink.err(windowLine(r));
    sink.err(countsLine(r));
    for (const g of r.gaps) sink.err(`Note: ${clean(g)}\n`);
    return 1;
  }
  sink.out(windowLine(r));
  sink.out(rules);
  if (r.status === "ok") {
    sink.out("No anomalies.\n");
  } else {
    sink.out("Anomalies (largest excess first):\n");
    for (const a of r.anomalies) sink.out(anomalyLine(a));
    if (r.anomaliesTruncated > 0) {
      sink.out(`  ... and ${String(r.anomaliesTruncated)} more (use --json for the count only).\n`);
    }
  }
  sink.out(countsLine(r));
  for (const g of r.gaps) sink.out(`Note: ${clean(g)}\n`);
  return 0;
}

export async function runCostAnomaliesWith(
  c: CostIpc,
  a: CostAnomaliesArgs,
  sink: CostSink,
): Promise<number> {
  try {
    const params: Record<string, unknown> = {};
    if (a.service !== undefined) params["service"] = a.service;
    if (a.days !== undefined) params["days"] = a.days;
    const r = (await c.call("cost.anomalies", params)) as AnomalyResult;
    if (a.json) {
      sink.out(`${JSON.stringify(r)}\n`);
      return r.status === "ok" || r.status === "anomalies" ? 0 : 1;
    }
    return renderResult(r, sink);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (a.json) sink.out(`${JSON.stringify({ error: msg })}\n`);
    else sink.err(`${clean(msg)}\n`);
    return 1;
  }
}

export async function runCostCommand(args: string[]): Promise<void> {
  const a = args[0] === "anomalies" ? parseCostAnomaliesArgs(args.slice(1)) : undefined;
  if (a === undefined) {
    process.stderr.write(`${COST_USAGE}\n`);
    throw new CliExit(1);
  }
  const code = await withGatewayIpc(
    (c) =>
      runCostAnomaliesWith(c, a, {
        out: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
      }),
    getCliPlatformPaths(),
  );
  if (code !== 0) throw new CliExit(code);
}
