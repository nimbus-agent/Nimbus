import { CliExit } from "../lib/cli-exit.ts";
import { stripControlChars } from "../lib/strip-control-chars.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";
import {
  BRIEFING_USAGE,
  type BriefingArgs,
  type BriefingStatusLike,
  listLine,
  parseBriefingArgs,
  type RunSummaryLike,
  type RunViewLike,
  runFooter,
  statusLines,
} from "./briefing-format.ts";

/**
 * `nimbus briefing [now | list | status] [--json]` - the morning briefing, built from the local index with
 * no model; nothing leaves the machine. The Markdown comes from the gateway and may carry text from the
 * index (a title, a sender), so every line is stripped of control characters before it reaches the
 * terminal (an ANSI escape in an indexed title must not).
 */
export interface BriefingIpc {
  call(method: string, params?: unknown): Promise<unknown>;
}
export interface BriefingSink {
  out(s: string): void;
  err(s: string): void;
}

const NO_BRIEFING_HINT =
  'No briefing yet. Run "nimbus briefing now", or enable [briefing] in nimbus.toml\n';

/** Strips control characters line by line, keeping the line structure the Markdown needs. */
export function cleanMarkdown(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .map((line) => stripControlChars(line))
    .join("\n");
}

function printRun(run: RunViewLike, sink: BriefingSink, zone?: string): void {
  const body = run.markdown === null ? clean(run.headline) : cleanMarkdown(run.markdown);
  sink.out(`${body.trimEnd()}\n\n${runFooter(run, zone)}\n`);
}

function clean(s: string): string {
  return stripControlChars(s);
}

async function showLatest(c: BriefingIpc, a: BriefingArgs, sink: BriefingSink, zone?: string) {
  const r = (await c.call("briefing.latest", {})) as { run: RunViewLike | null };
  if (a.json) {
    sink.out(`${JSON.stringify(r)}\n`);
    return r.run === null ? 1 : 0;
  }
  if (r.run === null) {
    sink.err(NO_BRIEFING_HINT);
    return 1;
  }
  printRun(r.run, sink, zone);
  return 0;
}

async function runNow(c: BriefingIpc, a: BriefingArgs, sink: BriefingSink, zone?: string) {
  const r = (await c.call("briefing.runNow", {})) as { run: RunViewLike };
  if (a.json) sink.out(`${JSON.stringify(r)}\n`);
  else printRun(r.run, sink, zone);
  return r.run.status === "ok" ? 0 : 1;
}

async function showList(c: BriefingIpc, a: BriefingArgs, sink: BriefingSink, zone?: string) {
  const r = (await c.call("briefing.list", a.limit === undefined ? {} : { limit: a.limit })) as {
    runs: RunSummaryLike[];
  };
  if (a.json) {
    sink.out(`${JSON.stringify(r)}\n`);
    return 0;
  }
  if (r.runs.length === 0) sink.out("No briefing runs yet.\n");
  for (const run of r.runs) sink.out(`${listLine(run, zone)}\n`);
  return 0;
}

async function showStatus(c: BriefingIpc, a: BriefingArgs, sink: BriefingSink) {
  const s = (await c.call("briefing.status", {})) as BriefingStatusLike;
  if (a.json) sink.out(`${JSON.stringify(s)}\n`);
  else for (const line of statusLines(s)) sink.out(`${line}\n`);
  return 0;
}

export async function runBriefingWith(
  c: BriefingIpc,
  a: BriefingArgs,
  sink: BriefingSink,
  zone?: string,
): Promise<number> {
  try {
    switch (a.mode) {
      case "latest":
        return await showLatest(c, a, sink, zone);
      case "now":
        return await runNow(c, a, sink, zone);
      case "list":
        return await showList(c, a, sink, zone);
      case "status":
        return await showStatus(c, a, sink);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (a.json) sink.out(`${JSON.stringify({ error: msg })}\n`);
    else sink.err(`${clean(msg)}\n`);
    return 1;
  }
}

export async function runBriefingCommand(args: string[]): Promise<void> {
  const a = parseBriefingArgs(args);
  if (a === undefined) {
    process.stderr.write(`${BRIEFING_USAGE}\n`);
    throw new CliExit(1);
  }
  const code = await withGatewayIpc(
    (c) =>
      runBriefingWith(c, a, {
        out: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
      }),
    getCliPlatformPaths(),
  );
  if (code !== 0) throw new CliExit(code);
}
