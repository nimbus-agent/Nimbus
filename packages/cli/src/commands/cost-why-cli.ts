import { stripControlChars } from "../lib/strip-control-chars.ts";
import { type CostFreshnessRow, costFreshnessLine } from "./cost-freshness-line.ts";

/**
 * `nimbus cost why <product|service> [--period <N>d|week|month] [--json]` (Phase 7, the Cost Pack): compares a
 * product's (or a rule service's) cost in the period with the same number of days before it, per currency, names
 * the spike day and the parts that moved most, then lists each service's deploys in the period (those near the
 * spike first, with the pull request each shipped) and its owners. Read from the local index only: nothing is
 * fetched and nothing leaves the machine.
 *
 * Vendor and index strings are stripped of control characters and capped at 200 characters. Exit codes: 0 for a
 * comparison, 1 for "no cost data imported", an unknown target and any error.
 */
export interface CostWhyIpc {
  call(method: string, params?: unknown): Promise<unknown>;
}
export interface CostWhySink {
  out(s: string): void;
  err(s: string): void;
}

export interface CostWhyArgs {
  readonly target: string;
  readonly period: string;
  readonly json: boolean;
}

export const COST_PERIOD_RE = /^(\d{1,3}d|week|month)$/;

export function parseCostWhyArgs(args: readonly string[]): CostWhyArgs | undefined {
  let target: string | undefined;
  let period = "14d";
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--json") json = true;
    else if (a === "--period" && COST_PERIOD_RE.test(args[i + 1] ?? "")) {
      period = args[i + 1] as string;
      i++;
    } else if (!a.startsWith("-") && a !== "" && target === undefined) target = a;
    else return undefined;
  }
  return target === undefined ? undefined : { target, period, json };
}

type Range = { fromDay: string; toDay: string; label: string };
type Mover = {
  service: string | null;
  part: string;
  provider: string;
  current: number;
  previous: number;
  change: number;
};
type Currency = {
  current: number;
  previous: number;
  change: number;
  changePct: number | null;
  spikeDay: string | null;
  movers: Mover[];
  moversTruncated: number;
};
type Deploy = {
  sha: string;
  environment: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  conclusion: string;
  url: string | null;
  runId: string | null;
  nearSpike: boolean;
  pr: {
    repo: string | null;
    number: number | null;
    title: string;
    url: string | null;
    author: string | null;
  } | null;
};
type Flag = {
  service: string;
  key: string;
  name: string;
  changedAtMs: number;
  environments: string[];
};
type Context = {
  serviceId: string;
  configured: boolean;
  deploys: Deploy[];
  deploysTruncated: number;
  /** Absent from an older gateway's payload. */
  flags?: Flag[];
  flagsTruncated?: number;
  owners: { label: string; share: number; resolved: boolean }[];
  gaps: string[];
};
type WhyResult = {
  empty: false;
  target: { kind: "product" | "service"; name: string };
  range: Range;
  previous: Range;
  byCurrency: Record<string, Currency>;
  services: string[];
  provisionalFrom: string | null;
  coverage: Record<string, { current: number; previous: number; days: number }>;
  unassigned: Record<string, { current: number; previous: number }>;
  freshness: CostFreshnessRow[];
  excludedSources: { source: string; provider: string; reason: string }[];
  notes: string[];
  context: Context[];
};
type WhyEmpty = { empty: true; range: Range; previous: Range; context: [] };

const clean = (s: string): string => stripControlChars(s).slice(0, 200);
const money = (n: number): string => n.toFixed(2);
const signed = (n: number): string => (n > 0 ? `+${money(n)}` : money(n));
const utcMinute = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

function pctText(c: Currency): string {
  if (c.changePct === null) return "new";
  const p = c.changePct.toFixed(1);
  return c.changePct > 0 ? `+${p}%` : `${p}%`;
}

/** What a currency's comparison leaves out: days with no data, and the cost no rule assigned. */
function renderCurrencyCaveats(r: WhyResult, code: string, sink: CostWhySink): void {
  const cov = r.coverage[code];
  if (cov !== undefined && (cov.current < cov.days || cov.previous < cov.days)) {
    sink.out(
      `  ${clean(code)} has data on ${String(cov.current)} of ${String(cov.days)} days now and ${String(cov.previous)} of ${String(cov.days)} days before: the comparison covers partial periods
`,
    );
  }
  const u = r.unassigned[code];
  if (u !== undefined && (u.current !== 0 || u.previous !== 0)) {
    sink.out(
      `  Unassigned ${clean(code)} (in no product or service): ${money(u.current)} now, ${money(u.previous)} before
`,
    );
  }
}

function renderCurrency(code: string, c: Currency, sink: CostWhySink): void {
  sink.out(
    `${clean(code)}  ${money(c.current)} vs ${money(c.previous)}  ${signed(c.change)} (${pctText(c)})\n`,
  );
  if (c.spikeDay !== null) sink.out(`  Spike day: ${c.spikeDay}\n`);
  if (c.movers.length > 0) sink.out("  Moved most:\n");
  for (const m of c.movers) {
    const label = `${m.service === null ? "-" : clean(m.service)}  ${clean(m.part)} (${clean(m.provider)})`;
    sink.out(
      `    ${label.padEnd(52)} ${money(m.current)} vs ${money(m.previous)}  ${signed(m.change)}\n`,
    );
  }
  if (c.moversTruncated > 0) sink.out(`    ... and ${String(c.moversTruncated)} more\n`);
}

function prLine(pr: NonNullable<Deploy["pr"]>): string {
  const ref =
    pr.repo !== null && pr.number !== null ? `${clean(pr.repo)}#${String(pr.number)} ` : "";
  const by = pr.author === null ? "" : ` (${clean(pr.author)})`;
  return `      ${ref}${clean(pr.title)}${by}\n`;
}

function renderDeploys(ctx: Context, sink: CostWhySink): void {
  if (ctx.configured && ctx.deploys.length === 0) sink.out("  No deploy in this period.\n");
  if (ctx.deploys.length > 0) sink.out("  Deploys:\n");
  for (const d of ctx.deploys) {
    const run = d.runId === null ? "" : `  run ${clean(d.runId)}`;
    const near = d.nearSpike ? "  near the spike" : "";
    sink.out(
      `    ${utcMinute(d.finishedAtMs ?? d.startedAtMs)}  ${clean(d.environment)}  ${clean(d.conclusion)}  ${clean(d.sha).slice(0, 12)}${run}${near}\n`,
    );
    if (d.pr !== null) sink.out(prLine(d.pr));
  }
  const more = ctx.deploysTruncated;
  if (more > 0) sink.out(`    ... and ${String(more)} more deploy${more === 1 ? "" : "s"}\n`);
}

function renderFlags(ctx: Context, sink: CostWhySink): void {
  for (const f of ctx.flags ?? []) {
    const envs = f.environments.length === 0 ? "" : ` (${f.environments.map(clean).join(",")})`;
    sink.out(`  Flags changed: ${clean(f.key)}${envs} at ${new Date(f.changedAtMs).toISOString()}
`);
  }
  const more = ctx.flagsTruncated ?? 0;
  if (more > 0)
    sink.out(`    ... and ${String(more)} more flag${more === 1 ? "" : "s"}
`);
}

function renderContext(ctx: Context, sink: CostWhySink): void {
  sink.out(`Service ${clean(ctx.serviceId)}\n`);
  renderDeploys(ctx, sink);
  renderFlags(ctx, sink);
  if (ctx.owners.length > 0) {
    const owners = ctx.owners
      .map((o) => `${clean(o.label)} ${Math.round(o.share * 100)}%`)
      .join(", ");
    sink.out(`  Owners (from git blame, who wrote it): ${owners}\n`);
  }
  for (const g of ctx.gaps) sink.out(`  Gap: ${clean(g)}\n`);
}

function renderFooter(r: WhyResult, sink: CostWhySink): void {
  if (r.provisionalFrom !== null) {
    sink.out(
      `The days from ${r.provisionalFrom} are provisional (the provider may still restate them).\n`,
    );
  }
  for (const f of r.freshness) sink.out(costFreshnessLine(f));
  for (const e of r.excludedSources) {
    sink.out(
      `Note: ${clean(e.source)} lines for ${clean(e.provider)} are not counted: ${clean(e.reason)}\n`,
    );
  }
  for (const n of r.notes) sink.out(`Note: ${clean(n)}\n`);
}

function renderText(r: WhyResult, sink: CostWhySink): number {
  sink.out(
    `Why the cost of ${r.target.kind} ${clean(r.target.name)} changed: ${r.range.fromDay} to ${r.range.toDay} (${r.range.label})\n`,
  );
  sink.out(`  compared with ${r.previous.fromDay} to ${r.previous.toDay} (${r.previous.label})\n`);
  const currencies = Object.keys(r.byCurrency);
  if (currencies.length > 1) {
    sink.out("Several currencies: each is compared on its own; they are never added together.\n");
  }
  for (const c of currencies) {
    renderCurrency(c, r.byCurrency[c] as Currency, sink);
    renderCurrencyCaveats(r, c, sink);
  }
  for (const ctx of r.context) renderContext(ctx, sink);
  renderFooter(r, sink);
  return 0;
}

export async function runCostWhyWith(
  c: CostWhyIpc,
  a: CostWhyArgs,
  sink: CostWhySink,
): Promise<number> {
  try {
    const r = (await c.call("cost.why", { target: a.target, period: a.period })) as
      | WhyResult
      | WhyEmpty;
    if (a.json) {
      sink.out(`${JSON.stringify(r)}\n`);
      return r.empty ? 1 : 0;
    }
    if (r.empty) {
      sink.err(
        'No cost data imported. Import a FOCUS export with "nimbus cost import <file|dir>".\n',
      );
      return 1;
    }
    return renderText(r, sink);
  } catch (e) {
    sink.err(`nimbus cost why: ${clean(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}
