import type { IPCClient } from "../ipc-client/index.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { BATCH_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { stripTerminalText } from "../lib/strip-terminal-text.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { type DebtReplyLike, formatDebt } from "./incident-debt-format.ts";
import {
  type CascadeGroupLike,
  formatCascadeGroups,
  formatTimeline,
  INCIDENT_USAGE,
  type IncidentArgs,
  listLine,
  parseIncidentArgs,
  recordFooter,
  type SourceLike,
  type SummaryLike,
  sourcesLine,
  type TimelineReplyLike,
} from "./incident-format.ts";
import { runRemediation } from "./incident-remediate.ts";
import { runUpdateCommand } from "./incident-update.ts";

/**
 * `nimbus incident list | show <id> | timeline <id> | investigate <id>` (Phase 10 IC3, IC4, IC9a): the incident records the gateway assembled from the local
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
    .map((line) => stripTerminalText(line))
    .join("\n");
}

type ListReply = {
  status: "ok" | "none" | "no_data";
  records: SummaryLike[];
  sources: SourceLike[];
  groups?: CascadeGroupLike[] | null;
};

type GetReply = {
  record: {
    summary: SummaryLike;
    markdown: string;
    versions: unknown[];
    /** IC4: where this record stands in the live cascade (a rendered block), absent on an older gateway. */
    cascade?: { status: "ok"; markdown: string } | { status: "unavailable" } | null;
  } | null;
  reason?: "no_item" | "not_assembled";
  triggerItemId?: string;
};

type InvestigateReply = { investigation: unknown; markdown: string };

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
    ...(a.cascade ? { cascade: true } : {}),
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
  if (a.cascade) {
    sink.out("\n");
    for (const line of formatCascadeGroups(r.groups ?? null)) sink.out(`${line}\n`);
  }
  return 0;
}

async function showTimeline(
  c: IncidentIpc,
  a: Extract<IncidentArgs, { verb: "timeline" }>,
  sink: IncidentSink,
): Promise<number> {
  await declareCliClientKind(c);
  const t = await c.call<TimelineReplyLike>("incident.timeline", {
    id: a.id,
    ...(a.version === undefined ? {} : { version: a.version }),
  });
  if (a.json) sink.out(`${JSON.stringify(t)}\n`);
  else sink.out(`${formatTimeline(t)}\n`);
  return 0;
}

async function investigateRecord(
  c: IncidentIpc,
  a: Extract<IncidentArgs, { verb: "investigate" }>,
  sink: IncidentSink,
): Promise<number> {
  await declareCliClientKind(c);
  const r = await c.call<InvestigateReply>("incident.investigate", { id: a.id });
  if (a.json) sink.out(`${JSON.stringify(r)}\n`);
  else sink.out(`${cleanMarkdown(r.markdown).trimEnd()}\n`);
  return 0;
}

async function showDebt(
  c: IncidentIpc,
  a: Extract<IncidentArgs, { verb: "debt" }>,
  sink: IncidentSink,
): Promise<number> {
  await declareCliClientKind(c);
  const r = await c.call<DebtReplyLike>("incident.debt", {
    ...(a.since === undefined ? {} : { since: a.since }),
    ...(a.untouched === undefined ? {} : { untouched: a.untouched }),
    ...(a.minIncidents === undefined ? {} : { minIncidents: a.minIncidents }),
    ...(a.limit === undefined ? {} : { limit: a.limit }),
  });
  if (a.json) sink.out(`${JSON.stringify(r)}\n`);
  else sink.out(`${formatDebt(r)}\n`);
  // A missing configuration is exit 1; no incident is a healthy state (the text never says "no debt").
  return r.status === "no_roots" ? 1 : 0;
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
  // IC4: the LIVE cascade, after the stored Markdown (the stored record never holds it).
  const cascade =
    got.cascade?.status === "ok"
      ? `\n${cleanMarkdown(got.cascade.markdown).trimEnd()}\n`
      : got.cascade?.status === "unavailable"
        ? "\nThe other open records could not be ranked this time.\n"
        : "";
  sink.out(
    `${cleanMarkdown(got.markdown).trimEnd()}\n${cascade}${note}${recordFooter(got.summary, nowMs)}\n`,
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
  tty: { readonly stdin: boolean; readonly stdout: boolean } = { stdin: false, stdout: false },
): Promise<number> {
  try {
    if (a.verb === "remediate" || a.verb === "undo" || a.verb === "advisory") {
      await declareCliClientKind(c);
      return await runRemediation(c, a, sink, tty);
    }
    if (a.verb === "list") return await listRecords(c, a, sink);
    if (a.verb === "timeline") return await showTimeline(c, a, sink);
    if (a.verb === "investigate") return await investigateRecord(c, a, sink);
    if (a.verb === "debt") return await showDebt(c, a, sink);
    return await showRecord(c, a, sink, nowMs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if ("json" in a && a.json) sink.out(`${JSON.stringify({ error: msg })}\n`);
    else sink.err(`${stripTerminalText(msg)}\n`);
    return 1;
  }
}

export async function runIncidentCommand(args: string[]): Promise<void> {
  // IC9b: the update draft, send and queue have their own flags and (for the send) approval timeout.
  if (args[0] === "update") return runUpdateCommand(args.slice(1));
  const a = parseIncidentArgs(args);
  if (a === undefined) {
    process.stderr.write(`${INCIDENT_USAGE}\n`);
    throw new CliExit(1);
  }
  // A run or an undo blocks on the executor's prompt, which only a person answers: the long budget and a
  // consent choice that ignores NIMBUS_SCRIPT_CONSENT_SOURCE (as `nimbus approvals <id>`).
  const asksOwner = (a.verb === "remediate" && a.pick !== undefined) || a.verb === "undo";
  const code = await withGatewayIpc(
    (c) =>
      runIncidentWith(
        c,
        a,
        {
          out: (s) => process.stdout.write(s),
          err: (s) => process.stderr.write(s),
        },
        Date.now(),
        { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
      ),
    getCliPlatformPaths(),
    asksOwner ? { consent: { kind: "human" }, requestTimeoutMs: BATCH_RPC_TIMEOUT_MS } : undefined,
  );
  if (code !== 0) throw new CliExit(code);
}
