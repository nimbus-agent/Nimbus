import { CliExit } from "../lib/cli-exit.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { runStatusCall } from "../lib/status-call.ts";
import { stripControlChars } from "../lib/strip-control-chars.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { parseCostImportArgs, runCostImportWith } from "./cost-import-cli.ts";
import { parseCostReportArgs, runCostReportWith } from "./cost-report-cli.ts";
import {
  parseCostReportScheduleArgs,
  runCostReportScheduleWith,
} from "./cost-report-schedule-cli.ts";
import { parseCostRulesCheckArgs, runCostRulesCheckWith } from "./cost-rules-check-cli.ts";
import { parseCostViewsArgs, runCostViewsWith } from "./cost-views-cli.ts";
import { parseCostWasteArgs, runCostWasteWith } from "./cost-waste.ts";
import { parseCostWhyArgs, runCostWhyWith } from "./cost-why-cli.ts";

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

export const COST_USAGE =
  "Usage: nimbus cost anomalies [--service <id>] [--days <1-30>] [--json]\n" +
  "       nimbus cost waste [--service <id>] [--kind <unattached|idle|orphaned_snapshot|empty_environment>] [--json]\n" +
  "       nimbus cost import <file|dir> [--provider aws|azure|gcp] [--dry-run] [--json]\n" +
  "       nimbus cost import --remove <importId> [--json]\n" +
  "       nimbus cost products [--period <N>d|week|month] [--allocation cluster] [--json|--csv]\n" +
  "       nimbus cost internal [--period <N>d|week|month] [--json|--csv]\n" +
  "       nimbus cost why <product|service> [--period <N>d|week|month] [--json]\n" +
  "       nimbus cost rules check [--period <N>d|week|month] [--json]\n" +
  "       nimbus cost report [<name> [--channel slack|teams|gmail|outlook] [--json|--csv]]\n" +
  "       nimbus cost report schedule <name> [--channel slack|teams|gmail|outlook] [--json]";

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

type ValueFlag = "--service" | "--days";

/** Which value flag `a` is (`--flag` or `--flag=value`), or undefined for anything else. */
function valueFlagOf(a: string): ValueFlag | undefined {
  if (a === "--service" || a.startsWith("--service=")) return "--service";
  if (a === "--days" || a.startsWith("--days=")) return "--days";
  return undefined;
}

/** A flag's value, or undefined when it is missing, blank or looks like another flag. */
function flagValue(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "" || value.startsWith("-")) return undefined;
  return value;
}

/** The parsed `--days` value, or undefined when it is not a whole number from 1 to 30. */
function parseDays(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const days = Number(value);
  return days < 1 || days > 30 ? undefined : days;
}

interface ParsedValues {
  service: string | undefined;
  days: number | undefined;
}

/** Records one value flag; false when it is repeated or its value is refused. */
function applyValueFlag(state: ParsedValues, flag: ValueFlag, value: string): boolean {
  if (flag === "--service") {
    if (state.service !== undefined) return false;
    state.service = value.trim();
    return true;
  }
  if (state.days !== undefined) return false;
  state.days = parseDays(value);
  return state.days !== undefined;
}

export function parseCostAnomaliesArgs(argv: readonly string[]): CostAnomaliesArgs | undefined {
  let json = false;
  const state: ParsedValues = { service: undefined, days: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--json") {
      json = true;
      continue;
    }
    const flag = valueFlagOf(a);
    if (flag === undefined) return undefined;
    const separate = a === flag;
    if (separate) i += 1;
    const value = flagValue(separate ? argv[i] : a.slice(flag.length + 1));
    if (value === undefined || !applyValueFlag(state, flag, value)) return undefined;
  }
  const { service, days } = state;
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
  const params: Record<string, unknown> = {};
  if (a.service !== undefined) params["service"] = a.service;
  if (a.days !== undefined) params["days"] = a.days;
  return runStatusCall({
    json: a.json,
    sink,
    clean,
    okStatuses: ["ok", "anomalies"],
    call: async () => (await c.call("cost.anomalies", params)) as AnomalyResult,
    render: (r) => renderResult(r, sink),
  });
}

type CostRun = (c: CostIpc) => Promise<number>;

/**
 * Every `nimbus cost` subcommand first declares the connection as the owner's CLI (best-effort, see
 * `declareCliClientKind`): the gateway serves `cost.import`, `cost.importRemove`, `cost.products` and
 * `cost.internal` only to a declared `cli` connection.
 */
function declaringCli(run: CostRun): CostRun {
  return async (c) => {
    await declareCliClientKind({ call: <T>(m: string, p?: unknown) => c.call(m, p) as Promise<T> });
    return run(c);
  };
}

/** The run for `nimbus cost <args>`, or undefined for a usage error (no gateway is contacted). */
export function costRunner(args: readonly string[], sink: CostSink): CostRun | undefined {
  const run = subcommandRunner(args, sink);
  return run === undefined ? undefined : declaringCli(run);
}

function subcommandRunner(args: readonly string[], sink: CostSink): CostRun | undefined {
  if (args[0] === "anomalies") {
    const a = parseCostAnomaliesArgs(args.slice(1));
    return a === undefined ? undefined : (c) => runCostAnomaliesWith(c, a, sink);
  }
  if (args[0] === "products" || args[0] === "internal") {
    const v = parseCostViewsArgs(args[0], args.slice(1));
    return v === undefined ? undefined : (c) => runCostViewsWith(c, v, sink);
  }
  if (args[0] === "import") {
    const i = parseCostImportArgs(args.slice(1));
    return i === undefined ? undefined : (c) => runCostImportWith(c, i, sink);
  }
  if (args[0] === "why") {
    const y = parseCostWhyArgs(args.slice(1));
    return y === undefined ? undefined : (c) => runCostWhyWith(c, y, sink);
  }
  if (args[0] === "rules") {
    const r = parseCostRulesCheckArgs(args.slice(1));
    return r === undefined ? undefined : (c) => runCostRulesCheckWith(c, r, sink);
  }
  if (args[0] === "report" && args[1] === "schedule" && args.length > 2) {
    const s = parseCostReportScheduleArgs(args.slice(2));
    return s === undefined ? undefined : (c) => runCostReportScheduleWith(c, s, sink);
  }
  if (args[0] === "report") {
    const p = parseCostReportArgs(args.slice(1));
    return p === undefined ? undefined : (c) => runCostReportWith(c, p, sink);
  }
  if (args[0] === "waste") {
    const w = parseCostWasteArgs(args.slice(1));
    return w === undefined ? undefined : (c) => runCostWasteWith(c, w, sink);
  }
  return undefined;
}

export async function runCostCommand(args: string[]): Promise<void> {
  const run = costRunner(args, {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
  if (run === undefined) {
    process.stderr.write(`${COST_USAGE}\n`);
    throw new CliExit(1);
  }
  const code = await withGatewayIpc(run, getCliPlatformPaths());
  if (code !== 0) throw new CliExit(code);
}
