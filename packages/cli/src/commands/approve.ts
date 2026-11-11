// `nimbus approve` — standing approval rules (Phase 10 SA3, I55): approve a recurring workflow
// write ONCE, bound to the exact workflow, for a bounded time and a bounded number of actions.
// `add` and `resume` WIDEN what runs unprompted, so they are the owner's, at a terminal, and
// refuse `--yes` (like `nimbus captures accept`): the gateway also refuses an approval whose
// source is not a person answering the prompt. `list`, `show`, `pause`, `revoke` and `dismiss` never
// ask. After you approve the same workflow write by hand several runs in a row, Nimbus suggests a
// rule (Phase 10 SA5): `list` shows the suggestions, `add --from-suggestion` turns one into a rule
// through the SAME approval prompt as any rule, and `dismiss` drops one. Nothing is automatic.
import type { IPCClient } from "../ipc-client/index.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { BATCH_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { stripControl } from "./captures-format.ts";

export const APPROVE_USAGE =
  'usage: nimbus approve add --workflow <name> --step <label|number> [--days 1-90] [--max 1-500] [--window "Mon-Fri 06:00-10:00 Europe/Berlin"]\n' +
  '       nimbus approve add --from-suggestion <id> [--days 1-90] [--max 1-500] [--window "Mon-Fri 06:00-10:00 Europe/Berlin"]\n' +
  "       nimbus approve list [--json]\n" +
  "       nimbus approve dismiss <suggestion-id> [--json]\n" +
  "       nimbus approve show <id> [--json]\n" +
  "       nimbus approve pause <id> [--json]\n" +
  "       nimbus approve resume <id>\n" +
  "       nimbus approve revoke <id> [--json]";

/** The message `add` and `resume` give for `--yes`: a rule is approved by a person. */
export const APPROVE_YES_REFUSAL =
  "nimbus approve add and resume cannot take --yes: a standing rule is approved by you, at the prompt, never automatically.";

export type StandingWindowArg = {
  days: number[];
  from: string;
  to: string;
  tz: string;
};

export type ApproveArgs =
  | {
      verb: "add";
      workflow: string;
      step: string | number;
      days?: number;
      max?: number;
      window?: StandingWindowArg;
    }
  | {
      verb: "add";
      fromSuggestion: string;
      days?: number;
      max?: number;
      window?: StandingWindowArg;
    }
  | { verb: "dismiss"; id: string; json: boolean }
  | { verb: "list"; json: boolean }
  | { verb: "show" | "pause" | "revoke"; id: string; json: boolean }
  | { verb: "resume"; id: string };

const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** `Mon-Fri 06:00-10:00 Europe/Berlin` or `Sat,Sun 09:00-12:00 UTC`; the gateway validates it again. */
export function parseWindowArg(spec: string): StandingWindowArg | undefined {
  const m = /^(\S+)\s+(\d{2}:\d{2})-(\d{2}:\d{2})\s+(\S+)$/.exec(spec.trim());
  if (m === null) return undefined;
  const [, dayPart, from, to, tz] = m as unknown as [string, string, string, string, string];
  const days = new Set<number>();
  for (const piece of dayPart.split(",")) {
    const range = piece.toLowerCase().split("-");
    const a = DAY_NAMES.indexOf(range[0] ?? "");
    const b = range.length === 1 ? a : DAY_NAMES.indexOf(range[1] ?? "");
    if (a === -1 || b === -1 || range.length > 2 || b < a) return undefined;
    for (let d = a; d <= b; d++) days.add(d + 1);
  }
  return { days: [...days].sort((x, y) => x - y), from, to, tz };
}

function intFlag(v: string | undefined): number | undefined {
  return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
}

/** `add`'s `--flag value` pairs; an unknown flag, a repeated one or a missing value refuses the parse. */
type AddFlags = {
  fromSuggestion?: string;
  workflow?: string;
  step?: string | number;
  days?: number;
  max?: number;
  window?: StandingWindowArg;
};

/** Takes one `--flag value` pair into `acc`; false when the flag is unknown or its value is invalid. */
function takeAddFlag(acc: AddFlags, k: string, v: string): boolean {
  switch (k) {
    case "--from-suggestion":
      acc.fromSuggestion = v;
      return true;
    case "--workflow":
      acc.workflow = v;
      return true;
    case "--step":
      acc.step = /^\d+$/.test(v) ? Number(v) : v;
      return true;
    case "--days":
    case "--max": {
      const n = intFlag(v);
      if (n === undefined) return false;
      acc[k === "--days" ? "days" : "max"] = n;
      return true;
    }
    case "--window": {
      const w = parseWindowArg(v);
      if (w === undefined) return false;
      acc.window = w;
      return true;
    }
    default:
      return false;
  }
}

function parseAdd(flags: string[]): ApproveArgs | undefined {
  const seen = new Set<string>();
  const acc: AddFlags = {};
  for (let i = 0; i < flags.length; i += 2) {
    const k = flags[i] ?? "";
    const v = flags[i + 1];
    if (v === undefined || v.startsWith("--") || seen.has(k)) return undefined;
    seen.add(k);
    if (!takeAddFlag(acc, k, v)) return undefined;
  }
  const { workflow, step, fromSuggestion, ...out } = acc;
  if (fromSuggestion !== undefined) {
    // A suggestion names the workflow and step itself; naming them too is ambiguous, so refused.
    return workflow === undefined && step === undefined && /^ss_[0-9a-f]{16}$/.test(fromSuggestion)
      ? { verb: "add", fromSuggestion, ...out }
      : undefined;
  }
  if (workflow === undefined || workflow === "" || step === undefined) return undefined;
  return { verb: "add", workflow, step, ...out };
}

export function parseApproveArgs(argv: string[]): ApproveArgs | undefined {
  const json = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--json");
  const verb = rest[0] ?? "list";
  if (verb === "add") return parseAdd(rest.slice(1));
  if (verb === "list") return rest.length <= 1 ? { verb, json } : undefined;
  if (verb === "show" || verb === "pause" || verb === "revoke" || verb === "dismiss") {
    const id = rest[1];
    return id === undefined || id.startsWith("--") || rest.length !== 2
      ? undefined
      : { verb, id, json };
  }
  if (verb === "resume") {
    const id = rest[1];
    return id === undefined || id.startsWith("--") || rest.length !== 2 || json
      ? undefined
      : { verb, id };
  }
  return undefined;
}

type Sink = { out(s: string): void; err(s: string): void };

type RuleView = {
  id: string;
  state: string;
  workflowName: string | null;
  workflowId: string;
  workflowSha256: string;
  stepIndex: number;
  actionType: string;
  toolId: string;
  scope: Record<string, unknown>;
  window: { label?: string } | null;
  createdAt: number;
  expiresAt: number;
  maxActions: number;
  actionsUsed: number;
  lastFiredAt: number | null;
};

/** An open standing-rule suggestion, as `standing.suggestions` returns it. */
type SuggestionView = {
  id: string;
  workflowName: string | null;
  workflowId: string;
  stepIndex: number;
  stepLabel: string;
  toolId: string | null;
  streak: number;
  createdAt: number;
};

function viewOf(raw: unknown): RuleView {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("the gateway returned a malformed rule");
  }
  return raw as RuleView;
}

function iso(ms: number | null): string {
  return ms === null ? "never" : new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}

/** One safe line per field: every stored string is stripped of terminal controls before printing. */
export function formatRuleTable(rules: readonly RuleView[]): string {
  if (rules.length === 0) return "No standing rules.\n";
  const rows = rules.map((r) => [
    r.id,
    stripControl(r.workflowName ?? r.workflowId),
    String(r.stepIndex + 1),
    stripControl(r.toolId),
    `${String(r.actionsUsed)}/${String(r.maxActions)}`,
    iso(r.expiresAt),
    iso(r.lastFiredAt),
    r.state,
  ]);
  const head = ["ID", "WORKFLOW", "STEP", "TOOL", "USED", "EXPIRES", "LAST FIRED", "STATE"];
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]): string =>
    `${cells.map((c, i) => c.padEnd(width[i] ?? 0)).join("  ")}\n`;
  return line(head) + rows.map(line).join("");
}

/** The `Suggestions` section of `list`; empty when there is nothing to suggest. */
export function formatSuggestions(list: readonly SuggestionView[]): string {
  if (list.length === 0) return "";
  const rows = list.map((s) => [
    s.id,
    stripControl(s.workflowName ?? s.workflowId),
    `${String(s.stepIndex + 1)} (${stripControl(s.stepLabel)})`,
    String(s.streak),
  ]);
  const head = ["ID", "WORKFLOW", "STEP", "APPROVED IN A ROW"];
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]): string =>
    `${cells.map((c, i) => c.padEnd(width[i] ?? 0)).join("  ")}\n`;
  const intro =
    "\nSuggestions (you approved these by hand, run after run; nothing changes until you add one):\n";
  const how =
    "Make a rule: nimbus approve add --from-suggestion <id>   Drop one: nimbus approve dismiss <id>\n";
  return intro + line(head) + rows.map(line).join("") + how;
}

export function formatRuleDetail(r: RuleView): string {
  const scope = Object.entries(r.scope)
    .map(([f, e]) => `  ${stripControl(f)}: ${stripControl(JSON.stringify(e))}`)
    .join("\n");
  return `${[
    `Rule ${r.id} (${r.state})`,
    `Workflow: ${stripControl(r.workflowName ?? r.workflowId)} (content ${r.workflowSha256.slice(0, 12)})`,
    `Step ${String(r.stepIndex + 1)}: ${stripControl(r.toolId)} (${stripControl(r.actionType)})`,
    "Inputs:",
    scope,
    `When: ${r.window?.label === undefined ? "any time" : stripControl(r.window.label)}`,
    `Created: ${iso(r.createdAt)}   Expires: ${iso(r.expiresAt)}`,
    `Used: ${String(r.actionsUsed)} of ${String(r.maxActions)}   Last fired: ${iso(r.lastFiredAt)}`,
  ].join("\n")}\n`;
}

function ruleOf(raw: unknown): RuleView {
  const rec = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return viewOf(rec["rule"]);
}

type Client = Pick<IPCClient, "call">;

async function runList(c: Client, a: { json: boolean }, sink: Sink): Promise<void> {
  const rules = (await c.call<{ rules: unknown[] }>("standing.list", {})).rules;
  const suggestions = (await c.call<{ suggestions: unknown[] }>("standing.suggestions", {}))
    .suggestions;
  if (a.json) {
    sink.out(`${JSON.stringify({ rules, suggestions }, undefined, 2)}\n`);
    return;
  }
  sink.out(formatRuleTable(rules.map(viewOf)) + formatSuggestions(suggestions as SuggestionView[]));
}

async function runDismiss(c: Client, a: { id: string; json: boolean }, sink: Sink): Promise<void> {
  const out = await c.call<{ id: string; changed: boolean }>("standing.dismissSuggestion", {
    id: a.id,
  });
  if (a.json) {
    sink.out(`${JSON.stringify(out, undefined, 2)}\n`);
    return;
  }
  sink.out(out.changed ? `Dismissed suggestion ${a.id}.\n` : `Suggestion ${a.id} was not open.\n`);
}

async function runRuleVerb(
  c: Client,
  a: Extract<ApproveArgs, { verb: "show" | "pause" | "revoke" | "resume" }>,
  sink: Sink,
): Promise<void> {
  const out = await c.call<unknown>(`standing.${a.verb}`, { id: a.id });
  if ("json" in a && a.json) {
    sink.out(`${JSON.stringify(out, undefined, 2)}\n`);
  } else if (a.verb === "show") {
    sink.out(formatRuleDetail(ruleOf(out)));
  } else {
    const past = { pause: "Paused", revoke: "Revoked", resume: "Resumed" }[a.verb];
    sink.out(`${past} rule ${a.id}.\n`);
  }
}

async function runAdd(
  c: Client,
  a: Extract<ApproveArgs, { verb: "add" }>,
  sink: Sink,
): Promise<void> {
  const { verb: _v, ...params } = a;
  const out = await c.call<unknown>("standing.create", params);
  sink.out(`Created standing rule ${ruleOf(out).id}.\n`);
}

function runVerb(c: Client, a: ApproveArgs, sink: Sink): Promise<void> {
  if (a.verb === "list") return runList(c, a, sink);
  if (a.verb === "dismiss") return runDismiss(c, a, sink);
  if (a.verb === "add") return runAdd(c, a, sink);
  return runRuleVerb(c, a, sink);
}

export async function runApproveWith(
  c: Client,
  a: ApproveArgs,
  sink: Sink,
  json = false,
): Promise<number> {
  try {
    await runVerb(c, a, sink);
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (json) sink.out(`${JSON.stringify({ error: msg })}\n`);
    else sink.err(`${stripControl(msg)}\n`);
    return 1;
  }
}

export async function runApproveCmd(argv: string[]): Promise<void> {
  if (argv.includes("--yes") || argv.includes("-y")) {
    const verb = argv[0] ?? "";
    if (verb === "add" || verb === "resume") {
      process.stderr.write(`${APPROVE_YES_REFUSAL}\n`);
      throw new CliExit(2);
    }
  }
  const a = parseApproveArgs(argv);
  if (a === undefined) {
    process.stderr.write(`${APPROVE_USAGE}\n`);
    throw new CliExit(2);
  }
  const json = "json" in a && a.json;
  const widening = a.verb === "add" || a.verb === "resume";
  const code = await withGatewayIpc(
    async (c) => {
      // The gateway only creates or resumes a rule for a connection that declared itself the CLI.
      if (widening) await declareCliClientKind(c);
      return runApproveWith(
        c,
        a,
        { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
        json,
      );
    },
    getCliPlatformPaths(),
    widening ? { requestTimeoutMs: BATCH_RPC_TIMEOUT_MS } : {},
  );
  if (code !== 0) throw new CliExit(code);
}
