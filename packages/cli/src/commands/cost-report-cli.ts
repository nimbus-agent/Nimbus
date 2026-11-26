import { stripControlChars } from "../lib/strip-control-chars.ts";
import { csvCell } from "./cost-views-cli.ts";
import type { CostWhyIpc, CostWhySink } from "./cost-why-cli.ts";

/**
 * `nimbus cost report` (Phase 7, the Cost Pack, slice 3):
 * - `nimbus cost report [--json]` lists the `[[cost.report]]` definitions;
 * - `nimbus cost report <name> [--channel slack|teams|gmail|outlook] [--json|--csv]` renders one: the report
 *   (per currency total, change, movers, breakdown, unassigned, freshness) and then each channel's body exactly
 *   as it would be posted, with its destination and subject. `--channel` prints that one body raw (for piping);
 *   `--csv` prints the breakdown (header `currency,part,provider,env,amount`, formula-guarded).
 *
 * Nothing is sent: delivery is a saved workflow (slice 4). Read from the local index only. Exit codes: 0 when
 * every requested channel rendered with no refusal (and for a list); 1 for no cost data, an unknown report, a
 * refused config, any channel error or door refusal, and any IPC error.
 */
export type CostReportArgs =
  | { readonly mode: "list"; readonly json: boolean }
  | {
      readonly mode: "render";
      readonly name: string;
      readonly channel: string | null;
      readonly format: "text" | "json" | "csv";
    };

const KINDS = ["slack", "teams", "gmail", "outlook"];
export const COST_REPORT_CLI_CSV_HEADER = "currency,part,provider,env,amount";
const BREAKDOWN_SHOWN = 20;

type RenderFlags = { channel: string | null; format: "text" | "json" | "csv" };

/** One flag of a render; the number of extra arguments it took, or null for a usage error. */
function applyFlag(f: RenderFlags, a: string, next: string | undefined): number | null {
  if (a === "--json" || a === "--csv") {
    if (f.format !== "text") return null;
    f.format = a === "--json" ? "json" : "csv";
    return 0;
  }
  if (a === "--channel" && next !== undefined && KINDS.includes(next) && f.channel === null) {
    f.channel = next;
    return 1;
  }
  return null;
}

export function parseCostReportArgs(args: readonly string[]): CostReportArgs | undefined {
  if (args.length === 0) return { mode: "list", json: false };
  if (args.length === 1 && args[0] === "--json") return { mode: "list", json: true };
  const name = args[0] ?? "";
  if (name.startsWith("-")) return undefined;
  const f: RenderFlags = { channel: null, format: "text" };
  for (let i = 1; i < args.length; i++) {
    const taken = applyFlag(f, args[i] ?? "", args[i + 1]);
    if (taken === null) return undefined;
    i += taken;
  }
  if (f.channel !== null && f.format === "csv") return undefined;
  return { mode: "render", name, channel: f.channel, format: f.format };
}

type ListResult = {
  reports: {
    name: string;
    scope: Record<string, string>;
    period: string;
    schedule: string | null;
    tz: string | null;
    channels: { kind: string; format: string }[];
  }[];
  configError: string | null;
};
type Currency = {
  total: number;
  previous: number;
  change: number;
  changePct: number | null;
  topMovers: { service: string | null; part: string; provider: string; change: number }[];
  breakdown: { part: string; provider: string; env: string | null; amount: number }[];
  unassigned: number;
  unassignedPct: number | null;
};
type Model = {
  name: string;
  range: { fromDay: string; toDay: string; label: string };
  previous: { fromDay: string; toDay: string; label: string };
  byCurrency: Record<string, Currency>;
  provisionalFrom: string | null;
  freshness: { source: string; lastDay: string | null; provisionalFrom: string | null }[];
  empty: boolean;
  configError: string | null;
};
type Channel = {
  kind: string;
  format: string;
  to: string | { team: string; channel: string } | string[];
  subject: string | null;
  body: string | null;
  truncated: { breakdown: number; topMovers: number };
  error: string | null;
  doorRefusal: string | null;
};
type RenderResult = { model: Model; channels: Channel[] };

const clean = (s: string): string => stripControlChars(s).slice(0, 200);
/** A multi-line body: control characters stripped line by line, the lines kept. */
const cleanBody = (s: string): string => s.split("\n").map(stripControlChars).join("\n");
const money = (n: number): string => n.toFixed(2);
const signed = (n: number): string => (n > 0 ? `+${money(n)}` : money(n));
const pct = (p: number | null): string =>
  p === null ? "new" : `${p > 0 ? "+" : ""}${p.toFixed(1)}%`;

function renderList(r: ListResult, sink: CostWhySink): number {
  if (r.configError !== null) {
    sink.err(`The [cost] config is refused: ${clean(r.configError)}\n`);
    return 1;
  }
  if (r.reports.length === 0) {
    sink.out(
      "No cost reports are configured. Add a [[cost.report]] block to nimbus.toml (see nimbus cost report in the CLI reference).\n",
    );
    return 0;
  }
  for (const rep of r.reports) {
    const scope = Object.entries(rep.scope)
      .map(([k, v]) => `${k}=${clean(v)}`)
      .join(",");
    const schedule =
      rep.schedule === null
        ? "no schedule"
        : `schedule ${clean(rep.schedule)} (${clean(rep.tz ?? "gateway zone")})`;
    const channels =
      rep.channels.length === 0
        ? "no channel"
        : rep.channels.map((c) => `${clean(c.kind)} (${clean(c.format)})`).join(", ");
    sink.out(`${clean(rep.name)}  ${scope}  ${clean(rep.period)}  ${schedule}  ${channels}\n`);
  }
  return 0;
}

function renderCurrency(code: string, c: Currency, sink: CostWhySink): void {
  const cur = clean(code);
  sink.out(
    `${cur}  ${money(c.total)} vs ${money(c.previous)}  ${signed(c.change)} (${pct(c.changePct)})\n`,
  );
  for (const m of c.topMovers) {
    const who = m.service === null ? "" : `${clean(m.service)} `;
    sink.out(`  mover: ${who}${clean(m.part)} (${clean(m.provider)}) ${signed(m.change)}\n`);
  }
  for (const b of c.breakdown.slice(0, BREAKDOWN_SHOWN)) {
    const env = b.env === null ? "" : `, ${clean(b.env)}`;
    sink.out(`  ${clean(b.part)} (${clean(b.provider)}${env}): ${money(b.amount)}\n`);
  }
  if (c.breakdown.length > BREAKDOWN_SHOWN) {
    sink.out(
      `  … and ${String(c.breakdown.length - BREAKDOWN_SHOWN)} more (--csv lists them all)\n`,
    );
  }
  const share = c.unassignedPct === null ? "" : ` (${c.unassignedPct.toFixed(1)}%)`;
  sink.out(`  Unassigned ${cur} (in no product or service): ${money(c.unassigned)}${share}\n`);
}

function destination(to: Channel["to"]): string {
  if (typeof to === "string") return clean(to);
  if (Array.isArray(to)) return to.map(clean).join(", ");
  return `${clean(to.team)}/${clean(to.channel)}`;
}

/** One channel's section; true when it rendered with no refusal. */
function renderChannel(ch: Channel, sink: CostWhySink): boolean {
  sink.out(`--- ${clean(ch.kind)} to ${destination(ch.to)} (${clean(ch.format)}) ---\n`);
  if (ch.subject !== null) sink.out(`Subject: ${clean(ch.subject)}\n`);
  if (ch.error !== null) {
    sink.out(`not rendered: ${clean(ch.error)}\n`);
    return false;
  }
  if (ch.body !== null) sink.out(`${cleanBody(ch.body)}\n`);
  const { breakdown, topMovers } = ch.truncated;
  if (breakdown + topMovers > 0) {
    sink.out(
      `(shortened to fit: ${String(breakdown)} breakdown rows and ${String(topMovers)} movers left out)\n`,
    );
  }
  if (ch.doorRefusal !== null) {
    sink.out(`the send door would refuse it: ${clean(ch.doorRefusal)}\n`);
    return false;
  }
  return true;
}

/** The model's failure, when there is nothing to report on. */
function modelRefusal(m: Model, sink: CostWhySink): boolean {
  if (m.configError !== null) {
    sink.err(`The [cost] config is refused, so no rule applies: ${clean(m.configError)}\n`);
    return true;
  }
  if (m.empty) {
    sink.err(
      'No cost data imported. Import a FOCUS export with "nimbus cost import <file|dir>".\n',
    );
    return true;
  }
  return false;
}

function renderText(r: RenderResult, sink: CostWhySink): number {
  if (modelRefusal(r.model, sink)) return 1;
  const m = r.model;
  sink.out(
    `Cost report ${clean(m.name)}: ${clean(m.range.label)} (${m.range.fromDay} to ${m.range.toDay})\n`,
  );
  sink.out(
    `  compared with ${clean(m.previous.label)} (${m.previous.fromDay} to ${m.previous.toDay})\n`,
  );
  for (const [code, c] of Object.entries(m.byCurrency)) renderCurrency(code, c, sink);
  if (m.provisionalFrom !== null) sink.out(`The days from ${m.provisionalFrom} are provisional.\n`);
  for (const f of m.freshness) {
    const prov = f.provisionalFrom === null ? "" : ` (provisional from ${f.provisionalFrom})`;
    sink.out(`Source ${clean(f.source)}: data up to ${f.lastDay ?? "none"}${prov}\n`);
  }
  const ok = r.channels.map((ch) => renderChannel(ch, sink));
  return ok.every(Boolean) ? 0 : 1;
}

function renderOneBody(r: RenderResult, sink: CostWhySink): number {
  const ch = r.channels[0];
  if (ch === undefined || ch.body === null || ch.error !== null) {
    sink.err(`not rendered: ${clean(ch?.error ?? "no such channel")}\n`);
    return 1;
  }
  sink.out(`${cleanBody(ch.body)}\n`);
  if (ch.doorRefusal !== null) {
    sink.err(`the send door would refuse it: ${clean(ch.doorRefusal)}\n`);
    return 1;
  }
  return 0;
}

function renderCsv(r: RenderResult, sink: CostWhySink): number {
  sink.out(`${COST_REPORT_CLI_CSV_HEADER}\n`);
  for (const [code, c] of Object.entries(r.model.byCurrency)) {
    for (const b of c.breakdown) {
      const cells = [code, b.part, b.provider, b.env ?? ""].map((v) =>
        csvCell(stripControlChars(v)),
      );
      sink.out(`${cells.join(",")},${money(b.amount)}\n`);
    }
  }
  return r.model.empty || r.model.configError !== null ? 1 : 0;
}

function exitOfJson(r: RenderResult): number {
  if (r.model.empty || r.model.configError !== null) return 1;
  return r.channels.every((c) => c.error === null && c.doorRefusal === null) ? 0 : 1;
}

export async function runCostReportWith(
  c: CostWhyIpc,
  a: CostReportArgs,
  sink: CostWhySink,
): Promise<number> {
  try {
    if (a.mode === "list") {
      const r = (await c.call("cost.reportList", {})) as ListResult;
      if (a.json) {
        sink.out(`${JSON.stringify(r)}\n`);
        return r.configError === null ? 0 : 1;
      }
      return renderList(r, sink);
    }
    const params: Record<string, unknown> = { name: a.name };
    if (a.channel !== null) params["channel"] = a.channel;
    const r = (await c.call("cost.reportRender", params)) as RenderResult;
    if (a.format === "json") {
      sink.out(`${JSON.stringify(r)}\n`);
      return exitOfJson(r);
    }
    if (a.format === "csv") return renderCsv(r, sink);
    return a.channel === null ? renderText(r, sink) : renderOneBody(r, sink);
  } catch (e) {
    sink.err(`nimbus cost report: ${clean(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}
