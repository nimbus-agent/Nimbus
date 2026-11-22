import { stripTerminalText } from "../lib/strip-terminal-text.ts";

/**
 * `nimbus cost waste [--service <id>] [--kind <kind>] [--json]` - the cloud cost "garbage collection"
 * report (Phase 10 FinOps, slice G4a): the waste candidates among the recommendations a FinOps vendor
 * made, read from the local index. Nothing is fetched, deleted, queued or proposed. Every vendor
 * string has its control and direction-control characters stripped and is cut to a display length
 * before it reaches the terminal, and no URL is opened (the gateway keeps only http(s) links).
 *
 * Exit codes: 0 when recommendations were read (waste found or not: the text and `--json` `status`
 * say which), 1 for "no recommendations indexed", a usage error and any error.
 */
export interface CostWasteIpc {
  call(method: string, params?: unknown): Promise<unknown>;
}
export interface CostWasteSink {
  out(s: string): void;
  err(s: string): void;
}

export const WASTE_KIND_NAMES = [
  "unattached",
  "idle",
  "orphaned_snapshot",
  "empty_environment",
] as const;
type Kind = (typeof WASTE_KIND_NAMES)[number];

export interface CostWasteArgs {
  readonly json: boolean;
  readonly service?: string;
  readonly kind?: Kind;
}

type CurrencyTotal = { currency: string | null; monthlySavings: number; count: number };
type Candidate = {
  itemId: string;
  kind: Kind;
  title: string;
  provider: string | null;
  cloudService: string | null;
  accountId: string | null;
  resourcesAffected: number | null;
  estimatedMonthlySavings: number | null;
  currency: string | null;
  documentationUrl: string | null;
};
type WasteResult = {
  status: "no_data" | "no_waste_found" | "waste";
  kind: Kind | null;
  lastSyncedMs: number | null;
  counts: { recommendations: number; waste: number; notWaste: number; noEstimate: number };
  byKind: { kind: Kind; count: number; noEstimate: number; totals: CurrencyTotal[] }[];
  totals: CurrencyTotal[];
  candidates: Candidate[];
  candidatesTruncated: number;
  gaps: string[];
};

/** The longest vendor string shown on one line; the rest is cut and marked. */
const DISPLAY_MAX = 200;
const clean = (s: string): string => {
  const t = stripTerminalText(s);
  return t.length > DISPLAY_MAX ? `${t.slice(0, DISPLAY_MAX)}...` : t;
};
const isKind = (v: string): v is Kind => (WASTE_KIND_NAMES as readonly string[]).includes(v);

/** A flag's value, or undefined when it is missing, blank or looks like another flag. */
function flagValue(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "" || value.startsWith("-")) return undefined;
  return value.trim();
}

type Flag = "--service" | "--kind";
const FLAGS: readonly Flag[] = ["--service", "--kind"];

function flagOf(a: string): Flag | undefined {
  return FLAGS.find((f) => a === f || a.startsWith(`${f}=`));
}

export function parseCostWasteArgs(argv: readonly string[]): CostWasteArgs | undefined {
  let json = false;
  const values = new Map<Flag, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--json") {
      json = true;
      continue;
    }
    const flag = flagOf(a);
    if (flag === undefined || values.has(flag)) return undefined;
    const separate = a === flag;
    if (separate) i += 1;
    const value = flagValue(separate ? argv[i] : a.slice(flag.length + 1));
    if (value === undefined) return undefined;
    values.set(flag, value);
  }
  const service = values.get("--service");
  const kind = values.get("--kind");
  if (kind !== undefined && !isKind(kind)) return undefined;
  return {
    json,
    ...(service === undefined ? {} : { service }),
    ...(kind === undefined ? {} : { kind }),
  };
}

function money(n: number, currency: string | null): string {
  const text = n.toFixed(2);
  return currency === null ? `${text} (no currency)` : `${text} ${clean(currency)}`;
}

function totalsText(totals: readonly CurrencyTotal[], noEstimate: number): string {
  const sums = totals.map((t) => `${money(t.monthlySavings, t.currency)}/month`).join(" + ");
  const none = noEstimate > 0 ? `${String(noEstimate)} with no estimate` : "";
  if (sums === "") return none === "" ? "no estimate" : none;
  return none === "" ? sums : `${sums}, plus ${none}`;
}

function candidateLines(c: Candidate): string {
  const where = [c.provider, c.cloudService, c.accountId === null ? null : `account ${c.accountId}`]
    .filter((x): x is string => x !== null)
    .map(clean)
    .join(", ");
  const saving =
    c.estimatedMonthlySavings === null
      ? "no estimate"
      : `${money(c.estimatedMonthlySavings, c.currency)}/month`;
  const affected =
    c.resourcesAffected === null ? "" : `, ${String(c.resourcesAffected)} resource(s)`;
  const location = where === "" ? "" : ` (${where})`;
  let text = `  [${c.kind}] ${clean(c.title)}: ${saving}${affected}${location}\n`;
  text += `      id: ${clean(c.itemId)}\n`;
  if (c.documentationUrl !== null) text += `      docs: ${clean(c.documentationUrl)}\n`;
  return text;
}

function render(r: WasteResult, sink: CostWasteSink): number {
  if (r.status === "no_data") {
    for (const g of r.gaps) sink.err(`${clean(g)}\n`);
    return 1;
  }
  const c = r.counts;
  sink.out(
    `${String(c.recommendations)} recommendation(s) read: ${String(c.waste)} waste, ${String(c.notWaste)} other (rightsizing or commitments, not listed).\n`,
  );
  if (r.lastSyncedMs !== null) {
    sink.out(`Last synced: ${new Date(r.lastSyncedMs).toISOString()}.\n`);
  }
  if (r.status === "no_waste_found") {
    const what = r.kind ?? "waste";
    sink.out(`No ${what} candidates among the vendor's recommendations.\n`);
  } else {
    sink.out(`Estimated savings: ${totalsText(r.totals, c.noEstimate)}.\n`);
    for (const k of r.byKind) {
      sink.out(`  ${k.kind}: ${String(k.count)} (${totalsText(k.totals, k.noEstimate)})\n`);
    }
    sink.out("Candidates (by currency, largest saving first):\n");
    for (const cand of r.candidates) sink.out(candidateLines(cand));
    if (r.candidatesTruncated > 0) {
      sink.out(`  ... and ${String(r.candidatesTruncated)} more (use --kind to narrow).\n`);
    }
  }
  for (const g of r.gaps) sink.out(`Note: ${clean(g)}\n`);
  sink.out("Nothing was deleted or queued: clean these up yourself in the cloud console or CLI.\n");
  return 0;
}

export async function runCostWasteWith(
  c: CostWasteIpc,
  a: CostWasteArgs,
  sink: CostWasteSink,
): Promise<number> {
  try {
    const params: Record<string, unknown> = {};
    if (a.service !== undefined) params["service"] = a.service;
    if (a.kind !== undefined) params["kind"] = a.kind;
    const r = (await c.call("cost.waste", params)) as WasteResult;
    if (a.json) {
      sink.out(`${JSON.stringify(r)}\n`);
      return r.status === "no_data" ? 1 : 0;
    }
    return render(r, sink);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (a.json) sink.out(`${JSON.stringify({ error: msg })}\n`);
    else sink.err(`${clean(msg)}\n`);
    return 1;
  }
}
