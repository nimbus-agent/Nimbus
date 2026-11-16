import type { IPCClient } from "../ipc-client/index.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { stripControlChars } from "../lib/strip-control-chars.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";
import {
  INCIDENT_USAGE,
  type IncidentArgs,
  listLine,
  parseIncidentArgs,
  recordFooter,
  type SourceLike,
  type SummaryLike,
  sourcesLine,
} from "./incident-format.ts";

/**
 * `nimbus incident list | show <id>` (Phase 10 IC3): the incident records the gateway assembled from the local
 * index, with no model and nothing leaving the machine. The three `incident.*` methods answer only a connection
 * that DECLARED `cli` or `ui`, so every subcommand declares `cli` before its first call. The Markdown may carry
 * text from the index (a title, a chat message), so every line is stripped of control characters before it
 * reaches the terminal.
 */
export type IncidentIpc = Pick<IPCClient, "call">;
export interface IncidentSink {
  out(s: string): void;
  err(s: string): void;
}

/** Strips control characters line by line, keeping the line structure the Markdown needs. */
export function cleanMarkdown(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .map((line) => stripControlChars(line))
    .join("\n");
}

type ListReply = {
  status: "ok" | "none" | "no_data";
  records: SummaryLike[];
  sources: SourceLike[];
};

type GetReply = {
  record: {
    summary: SummaryLike;
    markdown: string;
    versions: unknown[];
  } | null;
  reason?: "no_item" | "not_assembled";
  triggerItemId?: string;
};

type AssembleReply = { outcome: string; record: SummaryLike };

const NO_DATA_HINT =
  "No incident source is connected. Connect PagerDuty, Jira Service Management, Sentry, Monte Carlo or Bigeye (nimbus connector auth <service>).\n";

async function listRecords(
  c: IncidentIpc,
  a: Extract<IncidentArgs, { verb: "list" }>,
  sink: IncidentSink,
): Promise<number> {
  await declareCliClientKind(c);
  const r = await c.call<ListReply>("incident.list", {
    ...(a.open ? { open: true } : {}),
    ...(a.service === undefined ? {} : { service: a.service }),
    ...(a.source === undefined ? {} : { source: a.source }),
    ...(a.limit === undefined ? {} : { limit: a.limit }),
  });
  if (a.json) {
    sink.out(`${JSON.stringify(r)}\n`);
    return r.status === "no_data" ? 1 : 0;
  }
  if (r.status === "no_data") {
    sink.err(NO_DATA_HINT);
    return 1;
  }
  if (r.status === "none") {
    sink.out(`No incident records match. ${sourcesLine(r.sources)}\n`);
    return 0;
  }
  for (const rec of r.records) sink.out(`${listLine(rec)}\n`);
  return 0;
}

function printRecord(
  got: NonNullable<GetReply["record"]>,
  sink: IncidentSink,
  nowMs: number,
  assembledNow: boolean,
): void {
  const note = assembledNow
    ? "\nAssembled on demand just now (it was below the automatic severity rule or not yet assembled).\n"
    : "\n";
  sink.out(
    `${cleanMarkdown(got.markdown).trimEnd()}\n${note}${recordFooter(got.summary, nowMs)}\n`,
  );
}

async function showRecord(
  c: IncidentIpc,
  a: Extract<IncidentArgs, { verb: "show" }>,
  sink: IncidentSink,
  nowMs: number,
): Promise<number> {
  await declareCliClientKind(c);
  let got = await c.call<GetReply>("incident.get", { id: a.id });
  let assembledNow = false;
  if (got.record === null && got.reason === "not_assembled" && got.triggerItemId !== undefined) {
    const made = await c.call<AssembleReply>("incident.assemble", { id: got.triggerItemId });
    got = await c.call<GetReply>("incident.get", { id: made.record.id });
    assembledNow = true;
  }
  if (a.json) {
    sink.out(`${JSON.stringify(got)}\n`);
    return got.record === null ? 1 : 0;
  }
  if (got.record === null) {
    sink.err("No incident, alert or issue with that id is in the index.\n");
    return 1;
  }
  printRecord(got.record, sink, nowMs, assembledNow);
  return 0;
}

export async function runIncidentWith(
  c: IncidentIpc,
  a: IncidentArgs,
  sink: IncidentSink,
  nowMs: number = Date.now(),
): Promise<number> {
  try {
    return a.verb === "list" ? await listRecords(c, a, sink) : await showRecord(c, a, sink, nowMs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (a.json) sink.out(`${JSON.stringify({ error: msg })}\n`);
    else sink.err(`${stripControlChars(msg)}\n`);
    return 1;
  }
}

export async function runIncidentCommand(args: string[]): Promise<void> {
  const a = parseIncidentArgs(args);
  if (a === undefined) {
    process.stderr.write(`${INCIDENT_USAGE}\n`);
    throw new CliExit(1);
  }
  const code = await withGatewayIpc(
    (c) =>
      runIncidentWith(c, a, {
        out: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
      }),
    getCliPlatformPaths(),
  );
  if (code !== 0) throw new CliExit(code);
}
