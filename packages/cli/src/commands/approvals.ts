// `nimbus approvals` — the owner's queue of connector actions that outside MCP agents proposed, and
// the ONE-step approval of one (agent door AD2). `nimbus approvals <id>` asks the gateway to run the
// proposal on THIS connection, so the executor's own prompt (the typed preview, the target's current
// state, the UNVERIFIED proposer block, and for a Wave 4 write the typed confirmation) appears in
// this terminal. Only a person can approve: `--yes` and scripted consent are usage errors here and
// the gateway refuses any answer that did not come from a person. The command imports nothing from
// the model layer: the whole flow needs no model.
import type { IPCClient } from "../ipc-client/index.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { BATCH_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";
import {
  acceptLine,
  ago,
  cell,
  parseAcceptResult,
  stripControl,
  until,
} from "./captures-format.ts";

export const APPROVALS_USAGE =
  "usage: nimbus approvals [list] [--json]\n" +
  "       nimbus approvals show <id> [--json]\n" +
  "       nimbus approvals <id>                      approve one proposal (needs a terminal; the prompt appears here)\n" +
  "       nimbus approvals <id> --decline [--json]\n" +
  "       nimbus approvals --decline-all-from <label> [--json]";

export type ApprovalsArgs =
  | { verb: "list"; json: boolean }
  | { verb: "show"; id: string; json: boolean }
  | { verb: "approve"; id: string }
  | { verb: "decline"; id: string; json: boolean }
  | { verb: "declineAll"; label: string; json: boolean };

const isId = (s: string | undefined): s is string => typeof s === "string" && s.startsWith("cap_");

/** `--yes`, `-y` and any spelling of `--script-consent-source`: a person approves, nothing else. */
function isConsentShortcut(a: string): boolean {
  return a === "--yes" || a === "-y" || a.startsWith("--script-consent-source");
}

function parseWithoutJson(rest: string[], json: boolean): ApprovalsArgs | undefined {
  const [first, second, third] = rest;
  if (rest.length === 0 || (first === "list" && rest.length === 1)) return { verb: "list", json };
  if (first === "show") {
    return rest.length === 2 && isId(second) ? { verb: "show", id: second, json } : undefined;
  }
  if (first === "--decline-all-from") {
    return rest.length === 2 && second !== undefined && !second.startsWith("--")
      ? { verb: "declineAll", label: second, json }
      : undefined;
  }
  if (rest.length === 2 && first === "--decline" && isId(second)) {
    return { verb: "decline", id: second, json };
  }
  if (rest.length === 2 && isId(first) && second === "--decline") {
    return { verb: "decline", id: first, json };
  }
  if (rest.length === 1 && isId(first) && third === undefined) {
    // The prompt owns stdout while it runs, so an approval has no --json form.
    return json ? undefined : { verb: "approve", id: first };
  }
  return undefined;
}

export function parseApprovalsArgs(argv: string[]): ApprovalsArgs | undefined {
  if (argv.some(isConsentShortcut)) return undefined;
  const json = argv.includes("--json");
  return parseWithoutJson(
    argv.filter((a) => a !== "--json"),
    json,
  );
}

type Tty = { readonly stdin: boolean; readonly stdout: boolean };
type Sink = { out(s: string): void; err(s: string): void };

const TTY_REFUSAL =
  "nimbus approvals <id> requires an interactive terminal (TTY): the approval prompt is answered by you, at this terminal. Nothing was sent to the gateway.";

interface Proposal {
  id: string;
  actionType: string;
  wave: number | null;
  typedConfirm: boolean;
  label: string | null;
  summary: string;
  createdAt: number;
  expiresAt: number;
}

function rec(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`malformed ${what}`);
  }
  return v as Record<string, unknown>;
}

function field(r: Record<string, unknown>, k: string, t: "string" | "number"): string | number {
  const v = r[k];
  if (typeof v !== t) throw new Error(`malformed field ${k}`);
  return v as string | number;
}

function parseProposal(v: unknown): Proposal {
  const r = rec(v, "proposal");
  const wave = r["wave"];
  const label = r["label"];
  return {
    id: field(r, "id", "string") as string,
    actionType: field(r, "actionType", "string") as string,
    wave: typeof wave === "number" ? wave : null,
    typedConfirm: r["typedConfirm"] === true,
    label: typeof label === "string" ? label : null,
    summary: field(r, "summary", "string") as string,
    createdAt: field(r, "createdAt", "number") as number,
    expiresAt: field(r, "expiresAt", "number") as number,
  };
}

function parseProposals(raw: unknown): Proposal[] {
  const list = rec(raw, "approvals.list result")["proposals"];
  if (!Array.isArray(list)) throw new Error("malformed approvals.list result");
  return list.map(parseProposal);
}

function waveCell(p: { wave: number | null; typedConfirm: boolean }): string {
  if (p.wave === null) return "-";
  return p.typedConfirm ? `${String(p.wave)} (type-to-confirm)` : String(p.wave);
}

function labelCell(label: string | null): string {
  return `${stripControl(label ?? "-")} (unverified)`;
}

function formatQueue(rows: Proposal[], now: number): string {
  if (rows.length === 0) return "No agent proposals are waiting.\n";
  const head = `${cell("ID", 42)} ${cell("FROM (declared, unverified)", 30)} ${cell("TYPE", 26)} ${cell("WAVE", 22)} ${cell("AGE", 8)} ${cell("EXPIRES", 8)} SUMMARY`;
  const lines = rows.map(
    (r) =>
      `${cell(r.id, 42)} ${cell(labelCell(r.label), 30)} ${cell(stripControl(r.actionType), 26)} ${cell(waveCell(r), 22)} ${cell(ago(r.createdAt, now), 8)} ${cell(until(r.expiresAt, now), 8)} ${stripControl(r.summary).slice(0, 60)}`,
  );
  return `${[head, ...lines].join("\n")}\nApprove one with: nimbus approvals <id>   (read it first with: nimbus approvals show <id>)\n`;
}

function formatDetail(raw: unknown, now: number): string {
  const r = rec(raw, "approvals.get result");
  const p = parseProposal(r);
  const input = r["inputLines"];
  const lines = [
    `${p.id}  ${stripControl(p.actionType)}  wave ${waveCell(p)}`,
    `Proposed by ${stripControl(p.label ?? "an unnamed MCP client")} (declared, unverified) ${ago(p.createdAt, now)}; expires in ${until(p.expiresAt, now)}.`,
    `Agent's summary (UNVERIFIED): ${stripControl(p.summary)}`,
    "",
    ...(Array.isArray(input)
      ? input.map((l) => `  ${stripControl(typeof l === "string" ? l : "")}`)
      : []),
    "",
  ];
  const note = r["note"];
  if (typeof note === "string") lines.push(`Note: ${stripControl(note)}`);
  lines.push(
    `Approve with: nimbus approvals ${p.id}   Decline with: nimbus approvals ${p.id} --decline`,
  );
  return `${lines.join("\n")}\n`;
}

/** The label as the gateway prints it: a backslash and a quote are escaped. */
function escapeLabelArg(label: string): string {
  return label.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`);
}

type Client = Pick<IPCClient, "call">;

async function runList(c: Client, a: { json: boolean }, sink: Sink, now: number): Promise<number> {
  const raw = await c.call<unknown>("approvals.list", {});
  const rows = parseProposals(raw);
  sink.out(a.json ? `${JSON.stringify(raw, undefined, 2)}\n` : formatQueue(rows, now));
  return 0;
}

async function runShow(
  c: Client,
  a: { id: string; json: boolean },
  sink: Sink,
  now: number,
): Promise<number> {
  const raw = await c.call<unknown>("approvals.get", { id: a.id });
  sink.out(a.json ? `${JSON.stringify(raw, undefined, 2)}\n` : formatDetail(raw, now));
  return 0;
}

async function runApprove(c: Client, a: { id: string }, sink: Sink): Promise<number> {
  const raw = await c.call<unknown>("approvals.approve", { id: a.id });
  const { line, exit } = acceptLine(a.id, parseAcceptResult(raw), undefined);
  sink.out(line);
  return exit;
}

async function runDecline(c: Client, a: { id: string; json: boolean }, sink: Sink) {
  const raw = await c.call<unknown>("approvals.decline", { id: a.id });
  sink.out(
    a.json
      ? `${JSON.stringify(raw, undefined, 2)}\n`
      : `Declined ${a.id}. Nothing was run; the record is kept 90 days, then pruned.\n`,
  );
  return 0;
}

type DeclineResult = { id: string; declined: true } | { id: string; error: string };

async function declineOne(c: Client, id: string): Promise<DeclineResult> {
  try {
    await c.call<unknown>("approvals.decline", { id });
    return { id, declined: true };
  } catch (e) {
    return { id, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A CLI loop over `approvals.list` and `approvals.decline`: a proposal that arrives mid-run is not declined. */
async function runDeclineAll(
  c: Client,
  a: { label: string; json: boolean },
  sink: Sink,
): Promise<number> {
  const rows = parseProposals(await c.call<unknown>("approvals.list", {}));
  const escaped = escapeLabelArg(a.label);
  // ONE canonical form per run: the argument is the declared label as typed, so its escaped form is
  // the wire form. Only when that matches nothing is the argument read as the label AS PRINTED (the
  // way to name a label with an invisible character). Never both: two differently-labelled agents
  // are never declined by one argument.
  const typed = rows.filter((r) => r.label === escaped);
  const hits = typed.length > 0 ? typed : rows.filter((r) => r.label === a.label);
  const say = (s: string): void => (a.json ? sink.err(s) : sink.out(s));
  const results: DeclineResult[] = [];
  for (const r of hits) {
    // Sequential on purpose: each decline is its own gateway write, in the listed order.
    results.push(await declineOne(c, r.id)); // NOSONAR S9382: one gateway write at a time
  }
  const declined = results.filter((r) => "declined" in r).length;
  for (const r of results) {
    if ("error" in r) say(`[refused] ${r.id}: ${stripControl(r.error)}\n`);
  }
  if (a.json) {
    sink.out(`${JSON.stringify({ declined, total: hits.length, results }, undefined, 2)}\n`);
  } else if (hits.length === 0) {
    say(`No waiting proposal is labelled "${stripControl(a.label)}".\n`);
  } else {
    const s = declined === 1 ? "" : "s";
    say(`Declined ${String(declined)} proposal${s} labelled "${stripControl(a.label)}".\n`);
  }
  return declined === hits.length ? 0 : 1;
}

export async function runApprovalsWith(
  c: Client,
  a: ApprovalsArgs,
  sink: Sink,
  tty: Tty,
  now: number = Date.now(),
): Promise<number> {
  // Fail closed and BEFORE any RPC: the gateway cannot see a terminal, so approving without one
  // would send a prompt nobody can answer honestly (piped stdin) or see (redirected stdout).
  if (a.verb === "approve" && !(tty.stdin && tty.stdout)) {
    sink.err(`${TTY_REFUSAL}\n`);
    return 1;
  }
  // The first frame on the connection: the gateway serves approvals only to a declared cli or ui.
  await declareCliClientKind(c);
  try {
    switch (a.verb) {
      case "list":
        return await runList(c, a, sink, now);
      case "show":
        return await runShow(c, a, sink, now);
      case "approve":
        return await runApprove(c, a, sink);
      case "decline":
        return await runDecline(c, a, sink);
      case "declineAll":
        return await runDeclineAll(c, a, sink);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A refusal can quote agent text (an id, a label): strip it like every other print.
    if ("json" in a && a.json) sink.out(`${JSON.stringify({ error: stripControl(msg) })}\n`);
    else sink.err(`${stripControl(msg)}\n`);
    return 1;
  }
}

export async function runApprovalsCmd(argv: string[]): Promise<void> {
  const a = parseApprovalsArgs(argv);
  if (a === undefined) {
    process.stderr.write(`${APPROVALS_USAGE}\n`);
    throw new CliExit(2);
  }
  const code = await withGatewayIpc(
    (c) =>
      runApprovalsWith(
        c,
        a,
        { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
        { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
      ),
    getCliPlatformPaths(),
    // The approval blocks on the executor's prompt, which only a person answers: the long budget,
    // and a consent choice that ignores NIMBUS_SCRIPT_CONSENT_SOURCE.
    { consent: { kind: "human" }, requestTimeoutMs: BATCH_RPC_TIMEOUT_MS },
  );
  if (code !== 0) throw new CliExit(code);
}
