import { briefTextFor } from "../lib/agent-brief-render.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { stripControlChars } from "../lib/strip-control-chars.ts";

/**
 * A title, id or service name on a list line is third-party text (an alert or ticket title): drop control
 * characters, and the format (bidi, zero-width) and line or paragraph separator characters a terminal acts on.
 */
function terminalSafe(s: string): string {
  return stripControlChars(s).replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, "");
}

import { BATCH_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { type RemediateReply, reportRemediateOutcome, TTY_REFUSAL } from "./incident-remediate.ts";

export type OncallPushedArgs =
  | { readonly mode: "newest"; readonly json: boolean }
  | { readonly mode: "list"; readonly json: boolean }
  | {
      readonly mode: "one";
      readonly incidentId: string;
      readonly retry: boolean;
      readonly json: boolean;
      /** Run the proposal this push carried (IC5b): the same path as `incident remediate --pick`. */
      readonly remediate?: boolean;
    };
export interface OncallPushedIpc {
  call(method: string, params?: unknown): Promise<unknown>;
}
export interface OncallPushedSink {
  out(s: string): void;
  err(s: string): void;
}

export const ONCALL_PUSHED_USAGE =
  "Usage: nimbus oncall pushed [--json] | nimbus oncall pushed list [--json] | nimbus oncall pushed <incident-id> [--retry] [--json] | nimbus oncall pushed <incident-id> --remediate";

const PUSH_OFF_HINT = "On-call push is off. Set [oncall.push] enabled = true in nimbus.toml.\n";

type Brief = {
  incidentId: string;
  status: "ok" | "failed";
  title: string | null;
  createdAt: number;
  briefMarkdown: string | null;
  failureCode: string | null;
  service?: string | null;
  /** The top remediation proposal the push carried (IC5b); absent on an older gateway. */
  proposal?: PushedProposal | null;
};
type PushedProposal = {
  recordId: string;
  proposalId: string;
  kind: string;
  toolId: string;
  reversibility: string;
  confidence: number | null;
  expiresAtMs: number;
};
type ListResult = {
  enabled: boolean;
  identity: string;
  briefs: Brief[];
  /** Phase 10 IC3; absent on an older gateway. */
  sources?: string[];
  incidentEngineEnabled?: boolean;
  lastRun?: { notPushed?: Record<string, number> } | null;
};

/** The two diagnostics that make a silent non-push explainable (Phase 10 IC3). */
function recordDiagnostics(r: ListResult): string[] {
  const out: string[] = [];
  const widened = (r.sources ?? []).some((s) => s !== "pagerduty");
  if (widened && r.incidentEngineEnabled === false) {
    out.push(
      "Records are off: pushes of other sources need [incident] enabled = true in nimbus.toml.\n",
    );
  }
  const counts = Object.entries(r.lastRun?.notPushed ?? {}).filter(([, n]) => n > 0);
  if (counts.length > 0) {
    const text = counts.map(([why, n]) => `${why} ${String(n)}`).join(", ");
    out.push(`The last run did not push: ${text}.\n`);
  }
  return out;
}

const PUSHED_SWITCHES: ReadonlySet<string> = new Set(["--json", "--retry", "--remediate"]);

export function parseOncallPushedArgs(argv: readonly string[]): OncallPushedArgs | undefined {
  const seen = new Set<string>();
  const pos: string[] = [];
  for (const a of argv) {
    if (PUSHED_SWITCHES.has(a)) seen.add(a);
    else if (a.startsWith("-")) return undefined;
    else pos.push(a);
  }
  if (pos.length > 1) return undefined;
  const json = seen.has("--json");
  const retry = seen.has("--retry");
  // A run holds the terminal for the owner's prompt: it names one push, and has no --retry or --json form.
  if (seen.has("--remediate")) {
    if (pos.length !== 1 || pos[0] === "list" || retry || json) return undefined;
    return {
      mode: "one",
      incidentId: pos[0] as string,
      retry: false,
      json: false,
      remediate: true,
    };
  }
  if (pos.length === 0) return retry ? undefined : { mode: "newest", json };
  if (pos[0] === "list") return retry ? undefined : { mode: "list", json };
  return { mode: "one", incidentId: pos[0] as string, retry, json };
}

function renderBrief(b: Brief, sink: OncallPushedSink, demo: boolean): number {
  if (b.status === "failed") {
    sink.err(
      `The brief for ${b.incidentId} could not be assembled: ${b.failureCode ?? "unknown"}\n`,
    );
    sink.err(`Retry: nimbus oncall pushed ${b.incidentId} --retry\n`);
    return 1;
  }
  sink.out(`${briefTextFor(b.briefMarkdown ?? "", { demo })}\n`);
  return 0;
}

async function runList(c: OncallPushedIpc, json: boolean, sink: OncallPushedSink): Promise<number> {
  const r = (await c.call("oncall.pushedList", { limit: 50 })) as ListResult;
  if (json) {
    sink.out(`${JSON.stringify(r)}\n`);
    return 0;
  }
  if (r.briefs.length === 0) {
    sink.out("No pushed briefs yet.\n");
    if (!r.enabled) sink.out(PUSH_OFF_HINT);
    for (const line of recordDiagnostics(r)) sink.out(line);
    return 0;
  }
  for (const b of r.briefs) {
    const status = b.status === "ok" ? "ok    " : "FAILED";
    const svc =
      b.service !== undefined && b.service !== null && b.service !== ""
        ? `[${terminalSafe(b.service)}]  `
        : "";
    sink.out(
      `${new Date(b.createdAt).toISOString()}  ${status}  ${terminalSafe(b.incidentId)}  ${svc}${terminalSafe(b.title ?? "")}\n`,
    );
  }
  for (const line of recordDiagnostics(r)) sink.out(line);
  return 0;
}

function jsonExitCode(brief: Brief | null, named: boolean): number {
  // Spec § 2.7: newest+none → 0 (an empty list is an answer); a named id with none → 1;
  // a failed brief → 1; an ok brief → 0.
  if (brief === null) {
    if (named) return 1;
    return 0;
  }
  if (brief.status === "failed") return 1;
  return 0;
}

/** Every mode but `list`: the ones that answer with a single brief. */
type BriefArgs = Exclude<OncallPushedArgs, { readonly mode: "list" }>;

/** `--retry` re-assembles a failed brief; otherwise read the named brief, or the newest one. */
function requestBrief(c: OncallPushedIpc, a: BriefArgs): Promise<unknown> {
  if (a.mode === "newest") return c.call("oncall.pushedGet", {});
  if (a.retry) return c.call("oncall.pushedRetry", { incidentId: a.incidentId });
  return c.call("oncall.pushedGet", { incidentId: a.incidentId });
}

/** No brief matched: a named id is an error, an empty newest is an answer (plus the off hint). */
async function renderNoBrief(
  c: OncallPushedIpc,
  a: BriefArgs,
  sink: OncallPushedSink,
): Promise<number> {
  if (a.mode === "one") {
    sink.err(`No pushed brief for ${a.incidentId}.\n`);
    return 1;
  }
  sink.out("No pushed briefs yet.\n");
  const list = (await c.call("oncall.pushedList", { limit: 1 })) as ListResult;
  if (!list.enabled) sink.out(PUSH_OFF_HINT);
  return 0;
}

const REMEDIATE_REFUSALS = ["ERR_PROPOSAL_STALE", "ERR_PROPOSAL_EXPIRED", "ERR_PROPOSAL_NOT_FOUND"];

/**
 * `nimbus oncall pushed <id> --remediate` (Phase 10 IC5b, approve-from-push). Reads the push and asks the gateway
 * to run the proposal it carried through `incident.remediate` on THIS connection: the gateway re-derives it from
 * the record as it is now (refusing a stale or expired one), claims it, and the executor's own prompt (the typed
 * preview, the target's current state, `Proposed by: the incident engine`, the reversibility label, and for a
 * Wave 4 write the typed confirmation) appears here. The push itself approved nothing.
 */
async function runPushedRemediate(
  c: OncallPushedIpc,
  incidentId: string,
  sink: OncallPushedSink,
  tty: { readonly stdin: boolean; readonly stdout: boolean },
): Promise<number> {
  if (!(tty.stdin && tty.stdout)) {
    sink.err(`${TTY_REFUSAL}\n`);
    return 2;
  }
  const raw = await c.call("oncall.pushedGet", { incidentId });
  const brief = (raw as { brief: Brief | null }).brief;
  if (brief === null) {
    sink.err(`No pushed brief for ${terminalSafe(incidentId)}.\n`);
    return 1;
  }
  const p = brief.proposal ?? null;
  if (p === null) {
    sink.err(
      "This push carried no remediation proposal. List the current ones with: nimbus incident remediate <incident-id>\n",
    );
    return 1;
  }
  // Declare this connection as the owner's CLI (as `declareCliClientKind` does): the gateway serves
  // `incident.remediate` only to a declared `cli` or `ui` connection. Best effort, like that helper.
  try {
    await c.call("session.declareKind", { kind: "cli" });
  } catch {
    // An older gateway: `incident.remediate` then refuses with its own message.
  }
  const label = p.reversibility === "irreversible" ? "IRREVERSIBLE" : terminalSafe(p.reversibility);
  sink.out(
    `Running the proposal pushed for ${terminalSafe(incidentId)}: [${label}] ${terminalSafe(p.kind)} - ${terminalSafe(p.toolId)} (${terminalSafe(p.proposalId)})\n`,
  );
  try {
    const out = (await c.call("incident.remediate", {
      id: p.recordId,
      proposalId: p.proposalId,
    })) as RemediateReply;
    return reportRemediateOutcome(out, sink);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    sink.err(`${stripControlChars(msg)}\n`);
    if (REMEDIATE_REFUSALS.some((code) => msg.includes(code))) {
      sink.err(
        `List the current proposals with: nimbus incident remediate ${terminalSafe(p.recordId)}\n`,
      );
    }
    return 1;
  }
}

/** No terminal: the default when the caller passes none. */
const NO_TTY: { readonly stdin: boolean; readonly stdout: boolean } = Object.freeze({
  stdin: false,
  stdout: false,
});

export async function runOncallPushedWith(
  c: OncallPushedIpc,
  a: OncallPushedArgs,
  sink: OncallPushedSink,
  demo: boolean,
  tty: { readonly stdin: boolean; readonly stdout: boolean } = NO_TTY,
): Promise<number> {
  try {
    if (a.mode === "one" && a.remediate === true) {
      return await runPushedRemediate(c, a.incidentId, sink, tty);
    }
    if (a.mode === "list") return await runList(c, a.json, sink);
    const raw = await requestBrief(c, a);
    const brief = (raw as { brief: Brief | null }).brief;
    const notDelivered = (raw as { notDelivered?: unknown }).notDelivered;
    if (a.json) {
      sink.out(
        `${JSON.stringify(typeof notDelivered === "string" ? { brief, notDelivered } : { brief })}\n`,
      );
      return jsonExitCode(brief, a.mode === "one");
    }
    // `return await`, not a bare return: a failing off-hint lookup must reach the catch below.
    if (brief === null) return await renderNoBrief(c, a, sink);
    const code = renderBrief(brief, sink, demo);
    if (typeof notDelivered === "string") {
      sink.err(`Retried and stored; not delivered: ${stripControlChars(notDelivered)}.\n`);
    }
    return code;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (a.json) sink.out(`${JSON.stringify({ error: msg })}\n`);
    else sink.err(`${msg}\n`);
    return 1;
  }
}

export async function runOncallPushed(argv: string[]): Promise<void> {
  const a = parseOncallPushedArgs(argv);
  if (a === undefined) {
    process.stderr.write(`${ONCALL_PUSHED_USAGE}\n`);
    throw new CliExit(1);
  }
  const paths = getCliPlatformPaths();
  // A run blocks on the executor's prompt, which only a person answers: the long budget and a consent choice
  // that ignores NIMBUS_SCRIPT_CONSENT_SOURCE (as `nimbus incident remediate --pick`).
  const asksOwner = a.mode === "one" && a.remediate === true;
  const code = await withGatewayIpc(
    (c) =>
      runOncallPushedWith(
        c,
        a,
        { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
        paths.demo === true,
        { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
      ),
    paths,
    asksOwner ? { consent: { kind: "human" }, requestTimeoutMs: BATCH_RPC_TIMEOUT_MS } : undefined,
  );
  if (code !== 0) throw new CliExit(code);
}
