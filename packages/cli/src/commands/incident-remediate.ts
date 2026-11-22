import type { IPCClient } from "../ipc-client/index.ts";
import { stripControl } from "./captures-format.ts";

/**
 * `nimbus incident remediate | undo | advisory` (Phase 10 IC5a, spec § 5.5). The gateway PROPOSES; the owner
 * runs. `remediate <id>` lists the proposals for a record (read-only); `remediate <id> --pick N|prp_...` asks the
 * gateway to run ONE stored proposal on THIS connection, so the executor's own prompt (the typed preview, the
 * target's current state, `Proposed by: the incident engine`, the reversibility label, and for a Wave 4 write the
 * typed confirmation) appears in this terminal. Only a person can approve: `--yes` and scripted consent are usage
 * errors here and the gateway refuses any answer that did not come from a person. `undo <act_...>` runs the
 * declared inverse of an executed reversible action the same way. Nothing here needs a model.
 */

export const REMEDIATE_USAGE =
  "       nimbus incident remediate <id> [--pick <n|prp_...>] [--json]   list the proposals; with --pick, run one (needs a terminal)\n" +
  "       nimbus incident remediate <id> --pick <n|prp_...> --dry-run [--json]   read the target, predict the outcome; runs nothing\n" +
  "       nimbus incident undo <act_...>                                 reverse an executed reversible action (needs a terminal)\n" +
  "       nimbus incident advisory on|off|status [--json]                advisory mode: proposals are shown, nothing is run";

export type RemediationArgs =
  | {
      readonly verb: "remediate";
      readonly json: boolean;
      readonly id: string;
      readonly pick?: string;
      readonly dryRun?: boolean;
    }
  | { readonly verb: "undo"; readonly actionId: string }
  | { readonly verb: "advisory"; readonly json: boolean; readonly action: "on" | "off" | "status" };

/** `--yes`, `-y` and any spelling of `--script-consent-source`: a person approves, nothing else. */
function isConsentShortcut(a: string): boolean {
  return a === "--yes" || a === "-y" || a.startsWith("--script-consent-source");
}

const ID_OK = (s: string | undefined): s is string =>
  s !== undefined && s !== "" && !s.startsWith("--") && s.length <= 256;

function parseRemediate(rest: readonly string[]): RemediationArgs | undefined {
  let json = false;
  let id: string | undefined;
  let pick: string | undefined;
  let dryRun = false;
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i] as string;
    if (a === "--dry-run") {
      if (dryRun) return undefined;
      dryRun = true;
    } else if (a === "--json") {
      if (json) return undefined;
      json = true;
    } else if (a === "--pick") {
      const v = rest[i + 1];
      if (pick !== undefined || !ID_OK(v) || !/^(\d{1,3}|prp_[0-9a-f]{16})$/.test(v)) {
        return undefined;
      }
      pick = v;
      i += 1;
    } else if (id === undefined && ID_OK(a)) {
      id = a;
    } else {
      return undefined;
    }
  }
  if (id === undefined) return undefined;
  // A dry run names one proposal and asks nothing, so it needs --pick and may print JSON.
  if (dryRun) return pick === undefined ? undefined : { verb: "remediate", json, id, pick, dryRun };
  // A run holds the terminal for the prompt, so it has no --json form.
  if (pick !== undefined && json) return undefined;
  return { verb: "remediate", json, id, ...(pick === undefined ? {} : { pick }) };
}

/** The remediation verbs of `parseIncidentArgs`; `undefined` for anything else or any malformed flag. */
export function parseRemediationArgs(
  verb: string | undefined,
  rest: readonly string[],
): RemediationArgs | undefined {
  if (rest.some(isConsentShortcut)) return undefined;
  if (verb === "remediate") return parseRemediate(rest);
  if (verb === "undo") {
    const [id, ...more] = rest;
    return more.length === 0 && ID_OK(id) && /^act_[0-9a-f]{16}$/.test(id)
      ? { verb: "undo", actionId: id }
      : undefined;
  }
  if (verb === "advisory") {
    const json = rest.filter((a) => a === "--json");
    const words = rest.filter((a) => a !== "--json");
    const [word] = words;
    if (json.length > 1 || words.length !== 1) return undefined;
    return word === "on" || word === "off" || word === "status"
      ? { verb: "advisory", json: json.length === 1, action: word }
      : undefined;
  }
  return undefined;
}

type Tty = { readonly stdin: boolean; readonly stdout: boolean };
type Sink = { out(s: string): void; err(s: string): void };

export const TTY_REFUSAL =
  "Running or undoing an action needs an interactive terminal (TTY): the approval prompt is answered by you, at this terminal. Nothing was sent to the gateway.";

type Confidence = { terms: { name: string; weight: number; met: boolean }[]; total: number };
type Evidence = {
  rule?: string;
  items?: string[];
  blast?: {
    service: string | null;
    environment: string | null;
    dependents: string[];
    dependentsTruncated: boolean;
  };
  confidence?: Confidence | null;
  dryRun?: string;
  target?: string;
};

export type ProposalLike = {
  id: string;
  kind: string;
  toolId: string;
  input: unknown;
  evidence: Evidence | null;
  confidence: number | null;
  reversibility: string;
  irreversibleReason: string | null;
  status: string;
  actionId: string | null;
  undoStatus: string | null;
  undoable: boolean;
  expiresAtMs: number;
  /** What `--dry-run` can do for this proposal (absent from an older gateway). */
  dryRun?: "predicted" | "current_state" | "none";
};

export type ProposalsReply = {
  recordId: string;
  version: number;
  advisory: boolean;
  proposals: ProposalLike[];
  unavailable: { kind: string; code: string; reason: string }[];
};

const clean = (s: string): string => stripControl(s).replace(/\s+/g, " ").trim();

/** A tool input as `key=value` pairs: strings and numbers print plainly, anything else as JSON, all stripped. */
function inputText(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  return Object.entries(input as Record<string, unknown>)
    .map(([k, v]) => `${clean(k)}=${clean(typeof v === "string" ? v : JSON.stringify(v))}`)
    .join(" ");
}

function headline(p: ProposalLike): string {
  if (p.reversibility === "irreversible") {
    const why = p.irreversibleReason === null ? "" : `: ${clean(p.irreversibleReason)}`;
    return `IRREVERSIBLE${why}`;
  }
  return p.reversibility === "reversible" ? "reversible" : "reversibility unknown";
}

function confidenceText(p: ProposalLike): string[] {
  const c = p.evidence?.confidence;
  if (c === undefined || c === null) {
    return ["confidence: not scored (this action does not depend on a diagnosis)"];
  }
  const met = c.terms.filter((t) => t.met);
  const sum =
    met.length === 0
      ? "nothing met"
      : met.map((t) => `${clean(t.name)} ${String(t.weight)}`).join(" + ");
  const missing = c.terms.filter((t) => !t.met).map((t) => clean(t.name));
  return [
    `confidence ${String(c.total)} of 100 = ${sum}${missing.length === 0 ? "" : ` (not met: ${missing.join(", ")})`}`,
  ];
}

function evidenceLines(p: ProposalLike): string[] {
  const e = p.evidence;
  if (e === null) return [];
  const out: string[] = [];
  if (e.rule !== undefined) {
    const items = (e.items ?? []).map(clean).join(", ");
    out.push(`evidence: ${clean(e.rule)}${items === "" ? "" : ` (${items})`}`);
  }
  if (e.blast !== undefined) {
    const b = e.blast;
    const deps =
      b.dependents.length === 0
        ? "no dependent service declared"
        : `${b.dependents.map(clean).join(", ")}${b.dependentsTruncated ? ", and more" : ""} depend on it`;
    out.push(
      `blast radius: service ${b.service === null ? "unbound" : clean(b.service)}, environment ${b.environment === null ? "unknown" : clean(b.environment)}; ${deps}; the target's current state is shown when you approve`,
    );
  }
  if (e.dryRun !== undefined) out.push(`dry run: ${clean(e.dryRun)}${dryRunKindText(p.dryRun)}`);
  return out;
}

function dryRunKindText(kind: ProposalLike["dryRun"]): string {
  if (kind === "predicted") return " (here: the outcome is predicted)";
  if (kind === "current_state") return " (here: the current state only, no prediction)";
  if (kind === "none") return " (here: nothing can be read)";
  return "";
}

/** An earlier entry's undo state: the exact command, so the owner never has to find the action id (Phase 17 one-tap rollback). */
function undoText(p: ProposalLike): string {
  if (p.undoStatus === "undone") return ", undone";
  if (p.undoable && p.actionId !== null)
    return `, undo it with: nimbus incident undo ${clean(p.actionId)}`;
  return "";
}

/** The proposals of one record as the owner reads them; the reversibility label comes FIRST on every entry. */
export function formatProposals(r: ProposalsReply): string {
  const lines: string[] = [
    `Incident ${clean(r.recordId)} (record version ${String(r.version)}). Advisory mode: ${r.advisory ? "ON - nothing can be run" : "off"}.`,
  ];
  const open = r.proposals.filter((p) => p.status === "proposed");
  if (open.length === 0) lines.push("", "No remediation is proposed for this record right now.");
  open.forEach((p, i) => {
    lines.push(
      "",
      `${String(i + 1)}. [${headline(p)}] ${clean(p.kind)} - ${clean(p.toolId)} ${inputText(p.input)}  (${clean(p.id)})`,
    );
    for (const l of [...confidenceText(p), ...evidenceLines(p)]) lines.push(`   ${l}`);
  });
  if (r.unavailable.length > 0) {
    lines.push("", "Not available here:");
    for (const u of r.unavailable) lines.push(`  - ${clean(u.kind)}: ${clean(u.reason)}`);
  }
  const past = r.proposals.filter((p) => p.status !== "proposed");
  if (past.length > 0) {
    lines.push("", "Earlier:");
    for (const p of past) {
      const ran = p.actionId === null ? "" : `, action ${clean(p.actionId)}`;
      lines.push(
        `  - ${clean(p.kind)} ${clean(p.toolId)} ${inputText(p.input)} [${clean(p.status)}]${ran}${undoText(p)}`,
      );
    }
  }
  if (open.length > 0 && !r.advisory) {
    lines.push("", `Run one with: nimbus incident remediate ${clean(r.recordId)} --pick <n>`);
  }
  return lines.join("\n");
}

export type RemediateReply = {
  proposalId: string;
  actionId: string;
  status: "executed" | "denied" | "failed";
  reason?: string;
  nonHuman: boolean;
  undoable: boolean;
};
type UndoReply = {
  actionId: string;
  status: "undone" | "denied" | "failed";
  reason?: string;
  nonHuman: boolean;
};

const NON_HUMAN_NOTE =
  "the approval did not come from a person at a terminal (--yes, a script and an old client cannot approve); nothing was run";

function resolvePick(proposals: readonly ProposalLike[], pick: string): ProposalLike | undefined {
  const open = proposals.filter((p) => p.status === "proposed");
  if (pick.startsWith("prp_")) return open.find((p) => p.id === pick);
  return open[Number(pick) - 1];
}

type BeforeField = { label: string; value: string };
export type DryRunReply = {
  proposalId: string;
  toolId: string;
  before:
    | { status: "ok"; fields: BeforeField[]; notShown?: number }
    | { status: "unavailable"; reason: string }
    | { status: "refused"; reason: string }
    | { status: "no_reader" };
  prediction: { verdict: "would_change" | "no_change" | "uncertain" | "none"; text: string };
  label: string;
};

const VERDICT_TEXT: Readonly<Record<DryRunReply["prediction"]["verdict"], string>> = {
  would_change: "would change",
  no_change: "no change",
  uncertain: "uncertain",
  none: "not predicted",
};

function beforeLines(b: DryRunReply["before"]): string[] {
  if (b.status === "no_reader")
    return ["Current state: this action has no reader, so nothing was read"];
  if (b.status !== "ok") return [`Current state: ${b.status} (${clean(b.reason)})`];
  const out = ["Current state:", ...b.fields.map((f) => `  ${clean(f.label)}: ${clean(f.value)}`)];
  if (b.notShown !== undefined && b.notShown > 0)
    out.push(`  (${String(b.notShown)} more not shown)`);
  return out;
}

/** A dry run as the owner reads it: what was read, what is predicted, and the fixed label. Nothing was run. */
export function formatDryRun(chosen: ProposalLike, r: DryRunReply): string {
  return [
    `Dry run of [${headline(chosen)}] ${clean(chosen.kind)} - ${clean(r.toolId)} ${inputText(chosen.input)}  (${clean(r.proposalId)})`,
    ...beforeLines(r.before),
    `Predicted outcome: ${VERDICT_TEXT[r.prediction.verdict] ?? "not predicted"} - ${clean(r.prediction.text)}`,
    clean(r.label),
    "Nothing was run.",
  ].join("\n");
}

async function runDryRun(
  c: Pick<IPCClient, "call">,
  a: Extract<RemediationArgs, { verb: "remediate" }>,
  chosen: ProposalLike,
  sink: Sink,
): Promise<number> {
  const out = await c.call<DryRunReply>("incident.dryRun", { id: a.id, proposalId: chosen.id });
  sink.out(a.json ? `${JSON.stringify(out)}\n` : `${formatDryRun(chosen, out)}\n`);
  // A read that was refused or failed answers nothing reliable about the target.
  return out.before.status === "refused" || out.before.status === "unavailable" ? 1 : 0;
}

async function runRemediate(
  c: Pick<IPCClient, "call">,
  a: Extract<RemediationArgs, { verb: "remediate" }>,
  sink: Sink,
  tty: Tty,
): Promise<number> {
  if (a.pick !== undefined && a.dryRun !== true && !(tty.stdin && tty.stdout)) {
    sink.err(`${TTY_REFUSAL}\n`);
    return 2;
  }
  // A dry run writes nothing back: its listing must not revive a denied or expired proposal or renew a TTL.
  const view = await c.call<ProposalsReply>(
    "incident.proposals",
    a.dryRun === true ? { id: a.id, revive: false } : { id: a.id },
  );
  if (a.pick === undefined) {
    sink.out(a.json ? `${JSON.stringify(view)}\n` : `${formatProposals(view)}\n`);
    return 0;
  }
  const chosen = resolvePick(view.proposals, a.pick);
  if (chosen === undefined) {
    sink.err(
      "No such proposal is open for this record; list them with: nimbus incident remediate <id>\n",
    );
    return 1;
  }
  if (a.dryRun === true) return runDryRun(c, a, chosen, sink);
  sink.out(
    `Running [${headline(chosen)}] ${clean(chosen.kind)} - ${clean(chosen.toolId)} ${inputText(chosen.input)}\n`,
  );
  const out = await c.call<RemediateReply>("incident.remediate", {
    id: a.id,
    proposalId: chosen.id,
  });
  return reportRemediateOutcome(out, sink);
}

/** How a run's outcome reads, for `incident remediate --pick` and `oncall pushed --remediate` alike. */
export function reportRemediateOutcome(out: RemediateReply, sink: Sink): number {
  if (out.status === "executed") {
    sink.out(
      `Done. Action ${clean(out.actionId)}.${out.undoable ? ` Undo with: nimbus incident undo ${clean(out.actionId)}` : ""}\n`,
    );
    // The gateway ran it but could not record it (its proposal row changed meanwhile): say so, still exit 0.
    if (out.reason !== undefined) sink.err(`Note: ${clean(out.reason)}\n`);
    return 0;
  }
  const why = out.nonHuman ? NON_HUMAN_NOTE : clean(out.reason ?? "no reason given");
  sink.err(`${out.status === "denied" ? "Not run" : "Failed"}: ${why}\n`);
  return 1;
}

async function runUndo(
  c: Pick<IPCClient, "call">,
  a: Extract<RemediationArgs, { verb: "undo" }>,
  sink: Sink,
  tty: Tty,
): Promise<number> {
  if (!(tty.stdin && tty.stdout)) {
    sink.err(`${TTY_REFUSAL}\n`);
    return 2;
  }
  const out = await c.call<UndoReply>("incident.undo", { actionId: a.actionId });
  if (out.status === "undone") {
    sink.out(`Undone. Action ${clean(out.actionId)} was reversed.\n`);
    return 0;
  }
  const why = out.nonHuman ? NON_HUMAN_NOTE : clean(out.reason ?? "no reason given");
  sink.err(`${out.status === "denied" ? "Not undone" : "Undo failed"}: ${why}\n`);
  return 1;
}

async function runAdvisory(
  c: Pick<IPCClient, "call">,
  a: Extract<RemediationArgs, { verb: "advisory" }>,
  sink: Sink,
): Promise<number> {
  const r =
    a.action === "status"
      ? await c.call<{ advisory: boolean }>("incident.advisory", {})
      : await c.call<{ advisory: boolean }>("incident.advisorySet", { on: a.action === "on" });
  sink.out(
    a.json
      ? `${JSON.stringify(r)}\n`
      : `Advisory mode is ${r.advisory ? "ON: proposals are shown, nothing is run (remediate and undo are refused)" : "off"}.\n`,
  );
  return 0;
}

/** Runs one remediation verb. The caller has already declared the connection's kind. */
export async function runRemediation(
  c: Pick<IPCClient, "call">,
  a: RemediationArgs,
  sink: Sink,
  tty: Tty,
): Promise<number> {
  if (a.verb === "remediate") return runRemediate(c, a, sink, tty);
  if (a.verb === "undo") return runUndo(c, a, sink, tty);
  return runAdvisory(c, a, sink);
}
