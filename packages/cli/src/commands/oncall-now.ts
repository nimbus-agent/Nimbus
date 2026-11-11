import { CliExit } from "../lib/cli-exit.ts";
import { stripControlChars } from "../lib/strip-control-chars.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";

export interface OncallNowArgs {
  readonly service?: string;
  readonly json: boolean;
}
export interface OncallNowIpc {
  call(method: string, params?: unknown): Promise<unknown>;
}
export interface OncallNowSink {
  out(s: string): void;
  err(s: string): void;
}

export const ONCALL_NOW_USAGE = "Usage: nimbus oncall now [--service <id|name>] [--json]";

type Shift = {
  source: string;
  userName: string;
  policyName: string | null;
  scheduleName: string | null;
  level: number | null;
  endMs: number | null;
  isMe: boolean;
};
type SourceAge = { source: string; oldestFetchedMs: number | null; stale: boolean };
type NowResult = {
  status: "ok" | "none_on_call" | "no_match" | "no_data";
  asOfMs: number;
  query: string | null;
  resolvedVia: string | null;
  sources: SourceAge[];
  shifts: Shift[];
  next: Shift[];
  known: string[];
  gaps: string[];
};

const SOURCE_LABEL: Record<string, string> = {
  pagerduty: "PagerDuty",
  jsm: "Jira Service Management",
};

export function parseOncallNowArgs(argv: readonly string[]): OncallNowArgs | undefined {
  let json = false;
  let service: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--json") {
      json = true;
    } else if (a === "--service" || a.startsWith("--service=")) {
      if (service !== undefined) return undefined;
      if (a === "--service") i += 1;
      const value = a === "--service" ? argv[i] : a.slice("--service=".length);
      if (value === undefined || value.trim() === "" || value.startsWith("-")) return undefined;
      service = value;
    } else {
      return undefined;
    }
  }
  return { json, ...(service === undefined ? {} : { service }) };
}

const clean = (s: string): string => stripControlChars(s);

function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function shiftLine(s: Shift): string {
  const where = clean(s.scheduleName ?? s.policyName ?? "unknown schedule");
  const parts: string[] = [];
  if (s.policyName !== null) parts.push(clean(s.policyName));
  if (s.level !== null) parts.push(`level ${String(s.level)}`);
  if (s.endMs !== null) parts.push(`until ${utc(s.endMs)}`);
  const detail = parts.length === 0 ? "" : ` [${parts.join(", ")}]`;
  const label = SOURCE_LABEL[s.source] ?? clean(s.source);
  return `${where} -> ${clean(s.userName)}${detail} (${label})${s.isMe ? " <- you" : ""}\n`;
}

function ageLines(r: NowResult): string {
  let out = "";
  for (const src of r.sources) {
    const label = SOURCE_LABEL[src.source] ?? clean(src.source);
    if (src.oldestFetchedMs === null) {
      out += `${label} data age unknown\n`;
    } else {
      const minutes = Math.max(0, Math.round((r.asOfMs - src.oldestFetchedMs) / 60_000));
      out += `${label} data ${String(minutes)} min old\n`;
    }
    if (src.stale) out += "WARNING: older than 1 h; the shift may have changed\n";
  }
  return out;
}

function renderResult(r: NowResult, sink: OncallNowSink): number {
  const target = r.query === null ? "any schedule" : clean(r.query);
  if (r.status === "no_data") {
    for (const g of r.gaps) sink.err(`${clean(g)}\n`);
    return 1;
  }
  if (r.status === "no_match") {
    sink.err(`No on-call schedule, policy or service matches "${target}".\n`);
    if (r.known.length > 0) sink.err(`Known names: ${r.known.map(clean).join(", ")}\n`);
    return 1;
  }
  if (r.status === "none_on_call") {
    sink.out(`No on-call shift covers now for ${target}.\n`);
  } else {
    if (r.resolvedVia !== null) sink.out(`Matched by ${r.resolvedVia.replaceAll("_", " ")}.\n`);
    sink.out("On call now:\n");
    for (const s of r.shifts) sink.out(`  ${shiftLine(s)}`);
  }
  if (r.next.length > 0) {
    sink.out("Next:\n");
    for (const s of r.next) sink.out(`  ${shiftLine(s)}`);
  }
  for (const g of r.gaps) sink.out(`Note: ${clean(g)}\n`);
  sink.out(ageLines(r));
  return 0;
}

export async function runOncallNowWith(
  c: OncallNowIpc,
  a: OncallNowArgs,
  sink: OncallNowSink,
): Promise<number> {
  try {
    const r = (await c.call(
      "oncall.now",
      a.service === undefined ? {} : { service: a.service },
    )) as NowResult;
    if (a.json) {
      sink.out(`${JSON.stringify(r)}\n`);
      return r.status === "ok" || r.status === "none_on_call" ? 0 : 1;
    }
    return renderResult(r, sink);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (a.json) sink.out(`${JSON.stringify({ error: msg })}\n`);
    else sink.err(`${clean(msg)}\n`);
    return 1;
  }
}

export async function runOncallNow(argv: string[]): Promise<void> {
  const a = parseOncallNowArgs(argv);
  if (a === undefined) {
    process.stderr.write(`${ONCALL_NOW_USAGE}\n`);
    throw new CliExit(1);
  }
  const code = await withGatewayIpc(
    (c) =>
      runOncallNowWith(c, a, {
        out: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
      }),
    getCliPlatformPaths(),
  );
  if (code !== 0) throw new CliExit(code);
}
