// `nimbus approve` — standing approval rules (Phase 10 SA3, I55): approve a recurring workflow
// write ONCE, bound to the exact workflow, for a bounded time and a bounded number of actions.
// `add` and `resume` WIDEN what runs unprompted, so they are the owner's, at a terminal, and
// refuse `--yes` (like `nimbus captures accept`): the gateway also refuses an approval whose
// source is not a person answering the prompt. `list`, `show`, `pause` and `revoke` never ask.
import type { IPCClient } from "../ipc-client/index.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { BATCH_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { stripControl } from "./captures-format.ts";

export const APPROVE_USAGE =
  'usage: nimbus approve add --workflow <name> --step <label|number> [--days 1-90] [--max 1-500] [--window "Mon-Fri 06:00-10:00 Europe/Berlin"]\n' +
  "       nimbus approve list [--json]\n" +
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
function parseAdd(flags: string[]): ApproveArgs | undefined {
  const seen = new Set<string>();
  let workflow: string | undefined;
  let step: string | number | undefined;
  const out: { days?: number; max?: number; window?: StandingWindowArg } = {};
  for (let i = 0; i < flags.length; i += 2) {
    const k = flags[i] ?? "";
    const v = flags[i + 1];
    if (v === undefined || v.startsWith("--") || seen.has(k)) return undefined;
    seen.add(k);
    if (k === "--workflow") workflow = v;
    else if (k === "--step") step = /^\d+$/.test(v) ? Number(v) : v;
    else if (k === "--days" || k === "--max") {
      const n = intFlag(v);
      if (n === undefined) return undefined;
      out[k === "--days" ? "days" : "max"] = n;
    } else if (k === "--window") {
      const w = parseWindowArg(v);
      if (w === undefined) return undefined;
      out.window = w;
    } else return undefined;
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
  if (verb === "show" || verb === "pause" || verb === "revoke") {
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

export async function runApproveWith(
  c: Pick<IPCClient, "call">,
  a: ApproveArgs,
  sink: Sink,
  json = false,
): Promise<number> {
  try {
    if (a.verb === "list") {
      const raw = (await c.call<{ rules: unknown[] }>("standing.list", {})).rules;
      sink.out(
        a.json
          ? `${JSON.stringify({ rules: raw }, undefined, 2)}\n`
          : formatRuleTable(raw.map(viewOf)),
      );
      return 0;
    }
    if (a.verb === "add") {
      const { verb: _v, ...params } = a;
      const out = await c.call<unknown>("standing.create", params);
      sink.out(`Created standing rule ${ruleOf(out).id}.\n`);
      return 0;
    }
    const out = await c.call<unknown>(`standing.${a.verb}`, { id: a.id });
    const asJson = "json" in a && a.json;
    if (asJson) {
      sink.out(`${JSON.stringify(out, undefined, 2)}\n`);
    } else if (a.verb === "show") {
      sink.out(formatRuleDetail(ruleOf(out)));
    } else {
      const past = { pause: "Paused", revoke: "Revoked", resume: "Resumed" }[a.verb];
      sink.out(`${past} rule ${a.id}.\n`);
    }
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
