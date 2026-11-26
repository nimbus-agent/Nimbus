// `nimbus prove --by-proposer` (agent door AD4): what outside agents proposed, what the owner's gate
// decided and what reached the egress ledger, grouped by the label each client SAID it was. It runs
// no query and reads two ledgers through `audit.proveByProposer`. The CLI cannot import gateway
// source, so the reply types below mirror `gateway/src/audit/agent-door-proof.ts` by hand: if that
// file changes `ProposerProof`, change this and its test fixture too.
import type { IPCClient } from "../ipc-client/index.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { parseSinceDurationToMs } from "../lib/parse-since.ts";
import { stripControlChars } from "../lib/strip-control-chars.ts";

export interface ProposerGroupView {
  readonly label: string | null;
  readonly labelSource: string;
  readonly proposed: number;
  readonly refusedAtSubmit: number;
  readonly approved: number;
  readonly declined: number;
  readonly executed: number;
  readonly failed: number;
  readonly expired: number;
  readonly waiting: number;
  readonly dispatches: number;
  readonly connections: number;
}

export interface ProposerProofView {
  readonly labelsVerified: false;
  readonly sinceMs: number | null;
  readonly untilMs: number | null;
  readonly groups: readonly ProposerGroupView[];
  readonly scanCut: boolean;
  /** Which ledger hit the row cap; absent from an older gateway. */
  readonly scanCutSides?: readonly string[];
  /** How many groups the window holds before `--proposer` filtered; absent from an older gateway. */
  readonly totalGroups?: number;
  readonly completeness: {
    readonly status: "ok" | "indeterminate";
    readonly causes: readonly string[];
    readonly mismatches: readonly { readonly code: string; readonly captureId: string }[];
    readonly checkedCaptures: number;
    readonly unreadableRows: number;
    /** Reserved-range egress rows that name no capture; absent from an older gateway. */
    readonly foreignRows?: number;
    readonly notChecked: { readonly preVersionCaptures: number; readonly prunedGateRows: number };
  };
}

export const PROVE_BY_PROPOSER_USAGE =
  "usage: nimbus prove --by-proposer [--since <dur>] [--proposer <label> | --proposer=<label>] [--json]\n" +
  "       use --proposer=<label> for a label that starts with --";

export interface ProveByProposerArgs {
  readonly sinceMs: number | undefined;
  readonly proposer: string | undefined;
  readonly json: boolean;
}

/** Thrown for a malformed command line; the message is the whole usage line. */
export class ProveUsageError extends Error {}

function usage(why: string): ProveUsageError {
  return new ProveUsageError(`${why}\n${PROVE_BY_PROPOSER_USAGE}`);
}

const SIGN_REFUSAL =
  "--by-proposer cannot be signed: a receipt over labels the clients chose themselves would read as proof of who acted.";

type ProveScan = { sinceMs?: number; proposer?: string; json: boolean };

/** Takes `--since <dur>` or `--proposer <label>` (the value already read) into the scan. */
function takeProveValue(s: ProveScan, flag: string, v: string, now: number): void {
  if (flag === "--since") {
    if (s.sinceMs !== undefined) throw usage("--since was given more than once.");
    s.sinceMs = now - parseSinceDurationToMs(v);
    return;
  }
  if (s.proposer !== undefined) throw usage("--proposer was given more than once.");
  s.proposer = v;
}

/** Why an argument that is none of the accepted flags is refused. */
function refusalFor(a: string): ProveUsageError {
  if (a === "--receipt" || a === "--sign") return usage(SIGN_REFUSAL);
  if (a.startsWith("--")) return usage(`Unknown option ${stripControlChars(a)}.`);
  return usage("--by-proposer runs no query and takes no positional argument.");
}

/** Reads one accepted flag (and its value) into `s`; returns the last index used, or throws a usage error. */
function takeProveToken(s: ProveScan, args: readonly string[], i: number, now: number): number {
  const a = args[i] ?? "";
  if (a === "--json") {
    s.json = true;
    return i;
  }
  if (a.startsWith("--proposer=")) {
    // The unambiguous form: the label may start with `--`.
    if (s.proposer !== undefined) throw usage("--proposer was given more than once.");
    s.proposer = a.slice("--proposer=".length);
    if (s.proposer === "") throw usage("--proposer needs a non-empty label.");
    return i;
  }
  if (a === "--since" || a === "--proposer") {
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) throw usage(`${a} needs a value.`);
    takeProveValue(s, a, v, now);
    return i + 1;
  }
  throw refusalFor(a);
}

/**
 * Parse the arguments of the `--by-proposer` form. This runs BEFORE the query path of `nimbus prove`
 * and never reaches it: a positional argument is a usage error (nothing is asked of the agent), and
 * so is `--receipt` or `--sign` (a signature over a report grouped by unverified labels would read as
 * signed proof that agent X did Y).
 */
export function parseProveByProposerArgs(
  args: readonly string[],
  now: number,
): ProveByProposerArgs {
  const s: ProveScan = { json: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--by-proposer") continue;
    i = takeProveToken(s, args, i, now);
  }
  if (s.proposer === "") throw usage("--proposer needs a non-empty label.");
  return { sinceMs: s.sinceMs, proposer: s.proposer, json: s.json };
}

function cutSideName(x: string): string {
  if (x === "audit") return "the audit log";
  if (x === "egress") return "the egress ledger";
  return stripControlChars(x);
}

/** One plain sentence per reason a proof is indeterminate. */
const CAUSE_SENTENCES: Readonly<Record<string, (p: ProposerProofView) => string>> = {
  mismatch: () =>
    "The audit log and the egress ledger disagree about at least one proposal (listed below).",
  unreadable_row: (p) =>
    `${String(p.completeness.unreadableRows)} audit row(s) of this kind could not be read, so they were not counted.`,
  scan_cut: (p) => {
    const sides = (p.scanCutSides ?? []).map(cutSideName);
    const where = sides.length === 0 ? "" : ` on ${sides.join(" and ")}`;
    return `The scan stopped at its row cap${where}, so rows may be missing from this report.`;
  },
  audit_chain_broken: () =>
    "The audit log's hash chain does not verify, so its rows cannot be trusted.",
  egress_chain_broken: () =>
    "The egress ledger's hash chain does not verify, so its rows cannot be trusted.",
  coverage_none: () =>
    "No boot marker covers this window for gated connector actions, so nothing recorded that the egress ledger was watching.",
};

function labelText(label: string | null): string {
  // The gateway already escaped the label; strip again so a raw control character from an older or
  // another gateway still cannot reach the terminal.
  return label === null ? "(no label)" : `"${stripControlChars(label)}"`;
}

function headerLines(proof: ProposerProofView, proposer: string | undefined): string[] {
  const window =
    proof.sinceMs === null
      ? "the whole audit log"
      : `since ${new Date(proof.sinceMs).toISOString().replace("T", " ").slice(0, 19)} UTC`;
  const lines = [
    `Actions proposed by outside agents (MCP), by proposer: ${window}`,
    "Every label below is the client's own claim and is UNVERIFIED: any program can send any label, and a label does not identify a program.",
    "",
  ];
  if (proof.groups.length === 0) {
    const total = proof.totalGroups ?? 0;
    lines.push(
      proposer !== undefined && total > 0
        ? `No proposer in this window has the label "${stripControlChars(proposer)}"; the window has ${String(total)} group(s) in all.`
        : "No outside-agent proposals were recorded in this window.",
    );
  }
  return lines;
}

function groupLines(g: ProposerGroupView): string[] {
  return [
    `UNVERIFIED label ${labelText(g.label)} (${stripControlChars(g.labelSource)})`,
    `  proposed ${String(g.proposed)}, refused at submit ${String(g.refusedAtSubmit)}, approved ${String(g.approved)}, declined ${String(g.declined)}, executed ${String(g.executed)}, failed ${String(g.failed)}, expired ${String(g.expired)}, waiting ${String(g.waiting)}`,
    `  authorized writes in the egress ledger: ${String(g.dispatches)}; connections: ${String(g.connections)} (an id lasts one gateway run)`,
  ];
}

function causeLine(proof: ProposerProofView, cause: string): string {
  const f = CAUSE_SENTENCES[cause];
  const sentence = f === undefined ? `Unrecognised reason ${stripControlChars(cause)}.` : f(proof);
  return `  - ${sentence}`;
}

/** The verdict: nothing checked, both ledgers agree, or why the report is not proof. */
function verdictLines(proof: ProposerProofView, nothingChecked: boolean): string[] {
  const c = proof.completeness;
  if (nothingChecked) {
    const held = c.notChecked.preVersionCaptures + c.notChecked.prunedGateRows > 0;
    return [
      held
        ? "Nothing in this window could be checked: no proposal had both ledgers to compare (see the not-checked counts below)."
        : "Nothing in this window could be checked: it holds no proposal for the two ledgers to compare.",
    ];
  }
  if (c.status === "ok") {
    return [`Both ledgers agree for the ${String(c.checkedCaptures)} proposal(s) checked.`];
  }
  return [
    "INDETERMINATE: this report is not proof, for these reasons:",
    ...c.causes.map((cause) => causeLine(proof, cause)),
    ...c.mismatches.map(
      (m) => `    ${stripControlChars(m.code)}  ${stripControlChars(m.captureId)}`,
    ),
  ];
}

function conclusionLine(status: string, nothingChecked: boolean): string {
  if (nothingChecked) {
    return "You can conclude nothing about the two ledgers agreeing from this report: no proposal was compared across them.";
  }
  return status === "ok"
    ? "You can conclude: these proposals were recorded, the owner's gate decided this many of them, and both ledgers agree capture by capture."
    : "You can conclude nothing from this report until the reasons above are resolved.";
}

/** The printable report. Pure, so the tests need no gateway. */
export function formatProposerProof(proof: ProposerProofView, proposer?: string): string {
  const c = proof.completeness;
  const nothingChecked = c.status === "ok" && c.checkedCaptures === 0;
  const lines = [
    ...headerLines(proof, proposer),
    ...proof.groups.flatMap(groupLines),
    "",
    ...verdictLines(proof, nothingChecked),
  ];
  if ((c.foreignRows ?? 0) > 0) {
    lines.push(
      `${String(c.foreignRows)} egress row(s) in the reserved agent range name no capture and were not counted; the gateway never writes one.`,
    );
  }
  lines.push(
    `Not checked: ${String(c.notChecked.preVersionCaptures)} proposal(s) accepted before this version recorded the label source; ${String(c.notChecked.prunedGateRows)} gate row(s) older than the newest egress prune.`,
    conclusionLine(c.status, nothingChecked),
    "You cannot conclude which program sent them, whether the remote service applied a write, anything an agent did with its own credentials, or anything that never reached the executor.",
  );
  return lines.join("\n");
}

function isMethodNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === -32601;
}

/** Run the report on an open connection; sets exit code 1 when the proof is indeterminate. */
export async function runProveByProposer(client: IPCClient, a: ProveByProposerArgs): Promise<void> {
  await declareCliClientKind(client);
  const params: Record<string, unknown> = {};
  if (a.sinceMs !== undefined) params["sinceMs"] = a.sinceMs;
  if (a.proposer !== undefined) params["proposer"] = a.proposer;
  let proof: ProposerProofView;
  try {
    proof = await client.call<ProposerProofView>("audit.proveByProposer", params);
  } catch (e) {
    if (!isMethodNotFound(e)) throw e;
    console.log(
      "This gateway is too old to report by proposer (it does not serve audit.proveByProposer). Update the gateway.",
    );
    process.exitCode = 1;
    return;
  }
  if (a.json) console.log(JSON.stringify(proof, null, 2));
  else console.log(formatProposerProof(proof, a.proposer));
  if (proof.completeness.status !== "ok") process.exitCode = 1;
}
