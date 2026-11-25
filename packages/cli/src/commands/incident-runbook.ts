import type { IPCClient } from "../ipc-client/index.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { reportCallFailure } from "../lib/status-call.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { stripControl } from "./captures-format.ts";
import { TTY_REFUSAL } from "./incident-remediate.ts";

/**
 * `nimbus incident runbook <id> [--runbook <name>] [--step N | --done N] [--json]` (Phase 10 IC6, spec § 5.6).
 * Lists the owner's runbooks (`<configDir>/runbooks/*.toml`) that match the record, each step with its state; with
 * `--done N` marks check N done; with `--step N` asks the gateway to run read or action step N on THIS connection,
 * so the executor's own prompt (`Proposed by: runbook <name>, step N`, the typed preview, the target's current state,
 * a typed confirmation for a Wave 4 write) appears in this terminal. Only a person can approve: `--yes` and scripted
 * consent are usage errors here and the gateway refuses any answer that did not come from a person.
 */

export const RUNBOOK_USAGE_LINE =
  "       nimbus incident runbook <id> [--runbook <name>] [--step <n> | --done <n>] [--json]   your runbooks for the record; --step runs one (needs a terminal)";

export type RunbookArgs = {
  readonly id: string;
  readonly json: boolean;
  readonly runbook?: string;
  readonly step?: number;
  readonly done?: number;
};

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function stepNumber(v: string | undefined): number | undefined {
  if (v === undefined || !/^\d{1,2}$/.test(v)) return undefined;
  const n = Number(v);
  return n >= 1 && n <= 50 ? n : undefined;
}

function isConsentShortcut(a: string): boolean {
  return a === "--yes" || a === "-y" || a.startsWith("--script-consent-source");
}

type ParseState = { id?: string; json: boolean; runbook?: string; step?: number; done?: number };

/**
 * One argument (and its value, when it takes one). Returns how many arguments it used, or 0 for a malformed one.
 */
function takeArg(out: ParseState, a: string, v: string | undefined): 0 | 1 | 2 {
  if (a === "--json") {
    if (out.json) return 0;
    out.json = true;
    return 1;
  }
  if (a === "--runbook") {
    if (out.runbook !== undefined || v === undefined || !NAME_RE.test(v)) return 0;
    out.runbook = v;
    return 2;
  }
  if (a === "--step" || a === "--done") {
    const n = stepNumber(v);
    if (out.step !== undefined || out.done !== undefined || n === undefined) return 0;
    if (a === "--step") out.step = n;
    else out.done = n;
    return 2;
  }
  if (out.id !== undefined || a.startsWith("-") || a === "" || a.length > 256) return 0;
  out.id = a;
  return 1;
}

/** Strict: every flag at most once, `--step` and `--done` exclusive, `--step` has no `--json` form. */
export function parseRunbookArgs(argv: readonly string[]): RunbookArgs | undefined {
  if (argv.some(isConsentShortcut)) return undefined;
  const out: ParseState = { json: false };
  for (let i = 0; i < argv.length; ) {
    const used = takeArg(out, argv[i] as string, argv[i + 1]);
    if (used === 0) return undefined;
    i += used;
  }
  const acts = out.step !== undefined || out.done !== undefined;
  if (out.id === undefined || (acts && out.runbook === undefined)) return undefined;
  if (out.step !== undefined && out.json) return undefined;
  return {
    id: out.id,
    json: out.json,
    ...(out.runbook === undefined ? {} : { runbook: out.runbook }),
    ...(out.step === undefined ? {} : { step: out.step }),
    ...(out.done === undefined ? {} : { done: out.done }),
  };
}

type StepLike =
  | { n: number; kind: "check"; text: string; status: string | null }
  | {
      n: number;
      kind: "read";
      service: string;
      tool: string;
      params: unknown;
      status: string | null;
    }
  | {
      n: number;
      kind: "action";
      tool: string;
      params: unknown;
      wave: number | null;
      reversibility: string;
      status: string | null;
    };

export type RunbooksReplyLike = {
  recordId: string;
  version: number;
  advisory: boolean;
  runbooks: {
    name: string;
    description: string | null;
    file: string;
    matched: boolean;
    steps: StepLike[];
  }[];
  errors: { file: string; reason: string }[];
};

export type RunReplyLike = {
  runbook: string;
  step: number;
  kind: "read" | "action";
  actionId: string;
  status: "ok" | "denied" | "failed";
  reason?: string;
  nonHuman: boolean;
  result?: unknown;
  resultWithheld?: boolean;
};

const clean = (s: string): string => stripControl(s).replace(/\s+/g, " ").trim();

function paramsText(p: unknown): string {
  if (typeof p !== "object" || p === null) return "";
  return Object.entries(p as Record<string, unknown>)
    .map(([k, v]) => `${clean(k)}=${clean(typeof v === "string" ? v : JSON.stringify(v))}`)
    .join(" ");
}

function reversibilityLabel(r: string): string {
  if (r === "irreversible") return "IRREVERSIBLE";
  return r === "reversible" ? "reversible" : "reversibility unknown";
}

function stepLine(s: StepLike): string {
  const state = s.status === null ? "" : ` [${clean(s.status)}]`;
  if (s.kind === "check") return `${String(s.n)}. check: ${clean(s.text)}${state}`;
  if (s.kind === "read") {
    return `${String(s.n)}. read ${clean(s.service)} ${clean(s.tool)} ${paramsText(s.params)}${state}`;
  }
  const wave = s.wave === null ? "" : `, wave ${String(s.wave)}`;
  return `${String(s.n)}. action [${reversibilityLabel(s.reversibility)}${wave}] ${clean(s.tool)} ${paramsText(s.params)}${state}`;
}

/** The runbooks of one record as the owner reads them. Every text the gateway returns is stripped. */
export function formatRunbooks(r: RunbooksReplyLike): string {
  const lines = [
    `Incident ${clean(r.recordId)} (record version ${String(r.version)}). Advisory mode: ${r.advisory ? "ON - runbook actions are shown, not run" : "off"}.`,
  ];
  if (r.runbooks.length === 0)
    lines.push("", "No runbook in your runbooks folder matches this record.");
  for (const rb of r.runbooks) {
    const matched = rb.matched ? "" : " (does not match this record)";
    lines.push("", `Runbook ${clean(rb.name)}${matched} - ${clean(rb.file)}`);
    if (rb.description !== null) lines.push(`  ${clean(rb.description)}`);
    for (const s of rb.steps) lines.push(`  ${stepLine(s)}`);
  }
  if (r.errors.length > 0) {
    lines.push("", "Refused runbook files:");
    for (const e of r.errors) lines.push(`  - ${clean(e.file)}: ${clean(e.reason)}`);
  }
  if (r.runbooks.some((rb) => rb.matched)) {
    lines.push(
      "",
      `Run a step: nimbus incident runbook ${clean(r.recordId)} --runbook <name> --step <n>; mark a check: --done <n>`,
    );
  }
  return lines.join("\n");
}

const NON_HUMAN_NOTE =
  "the approval did not come from a person at a terminal (--yes, a script and an old client cannot approve); nothing was run";

function reportRun(out: RunReplyLike, sink: Sink): number {
  if (out.status === "ok") {
    sink.out(
      `Done. Step ${String(out.step)} of ${clean(out.runbook)}, action ${clean(out.actionId)}.\n`,
    );
    if (out.kind === "read") {
      if (out.resultWithheld === true) sink.out("The result is too large to show here.\n");
      else sink.out(`${stripControl(JSON.stringify(out.result ?? null, null, 2))}\n`);
    }
    return 0;
  }
  const why = out.nonHuman ? NON_HUMAN_NOTE : clean(out.reason ?? "no reason given");
  sink.err(`${out.status === "denied" ? "Not run" : "Failed"}: ${why}\n`);
  return 1;
}

type Sink = { out(s: string): void; err(s: string): void };
type Tty = { readonly stdin: boolean; readonly stdout: boolean };

export async function runRunbookWith(
  c: Pick<IPCClient, "call">,
  a: RunbookArgs,
  sink: Sink,
  tty: Tty,
): Promise<number> {
  if (a.step !== undefined && !(tty.stdin && tty.stdout)) {
    sink.err(`${TTY_REFUSAL}\n`);
    return 2;
  }
  try {
    await declareCliClientKind(c);
    return await runbookCall(c, a, sink);
  } catch (e) {
    return reportCallFailure(e, a.json, sink, clean);
  }
}

/** One of the three calls: run a step, mark a step done, or list the matching runbooks. */
async function runbookCall(
  c: Pick<IPCClient, "call">,
  a: RunbookArgs,
  sink: Sink,
): Promise<number> {
  if (a.runbook !== undefined && a.step !== undefined) {
    const out = await c.call<RunReplyLike>("incident.runbookRun", {
      id: a.id,
      runbook: a.runbook,
      step: a.step,
    });
    return reportRun(out, sink);
  }
  if (a.runbook !== undefined && a.done !== undefined) {
    const done = await c.call("incident.runbookDone", {
      id: a.id,
      runbook: a.runbook,
      step: a.done,
    });
    sink.out(
      a.json
        ? `${JSON.stringify(done)}\n`
        : `Marked step ${String(a.done)} of ${clean(a.runbook)} done.\n`,
    );
    return 0;
  }
  const r = await c.call<RunbooksReplyLike>("incident.runbooks", {
    id: a.id,
    ...(a.runbook === undefined ? {} : { runbook: a.runbook }),
  });
  sink.out(a.json ? `${JSON.stringify(r)}\n` : `${formatRunbooks(r)}\n`);
  return 0;
}

export async function runRunbookCommand(args: string[]): Promise<void> {
  const a = parseRunbookArgs(args);
  if (a === undefined) {
    process.stderr.write(`Usage:\n${RUNBOOK_USAGE_LINE}\n`);
    throw new CliExit(1);
  }
  const code = await withGatewayIpc(
    (c) =>
      runRunbookWith(
        c,
        a,
        { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
        { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
      ),
    getCliPlatformPaths(),
    // A step blocks on the executor's prompt, which only a person answers (as `nimbus incident remediate`).
    a.step === undefined
      ? undefined
      : { consent: { kind: "human" }, requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS },
  );
  if (code !== 0) throw new CliExit(code);
}
