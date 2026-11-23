/**
 * `nimbus agent install|status|hook` (Phase 28 AD7b): the agent kits.
 *
 * `install` shows exactly what it would write into another product's configuration, then writes
 * only after the owner types `yes`. `status` re-reads those files and never writes. `hook` is what
 * the Claude Code kit's installed hook runs; it is not a command for people.
 *
 * This file parses arguments and prints. What a kit writes is decided in `agent-kits/kits/`, and
 * `agent-kits/apply.ts` is the only module that writes.
 */
import { type ApplyResult, pendingEdits } from "../agent-kits/apply.ts";
import { decideHook, hookOutput } from "../agent-kits/hook.ts";
import {
  isKitId,
  KIT_IDS,
  type KitEnv,
  type KitId,
  type KitPlan,
  type KitScope,
} from "../agent-kits/kit-types.ts";
import { DEFAULT_SCOPE, planKit } from "../agent-kits/kits/index.ts";
import { unifiedDiff } from "../agent-kits/line-diff.ts";
import { KitRefusal } from "../agent-kits/plan-files.ts";
import { planKitRemoval } from "../agent-kits/removal.ts";
import { allKitStatuses, type KitStatus, needsAttention } from "../agent-kits/status.ts";
import { AGENT_DOOR_BOUNDS } from "../lib/agent-door-bounds.ts";
import { quoteForPrintedCommand } from "../lib/shell-quote.ts";
import { stripControlChars } from "../lib/strip-control-chars.ts";

export const AGENT_USAGE = [
  "Usage: nimbus agent <subcommand>",
  `  nimbus agent install <${KIT_IDS.join("|")}> [--scope user|project] [--dry-run] [--yes]`,
  `  nimbus agent uninstall <${KIT_IDS.join("|")}> [--scope user|project] [--dry-run] [--yes]`,
  "  nimbus agent status [--json]",
  "",
  "install writes the Nimbus MCP server entry and steering rules into that agent's own",
  "configuration. It prints every change first and writes only after you type yes.",
  "uninstall removes only what install wrote (an unedited block, the kit's own keys), the same way:",
  "it prints every change, keeps a backup of each file, and asks for yes.",
  "status reports whether those entries are still as Nimbus wrote them. It never writes.",
].join("\n");

/** What a kit's steering is, in one line the owner reads before approving. */
export const NOT_A_BOUNDARY =
  "Steering is guidance in the agent's own harness. It is not a security boundary.";

/**
 * The opening of every "outside the door" statement (spec section 7.6): what an agent can still do
 * that no kit prevents.
 */
export const OUTSIDE_THE_DOOR =
  "An agent with a shell can run `nimbus approvals <id>` itself and, until desktop approval ships, can still approve its own proposals. " +
  "It can also run any command its harness allows with the credentials already on this machine (gh, aws, kubectl, cloud logins, SSH keys, tokens in the environment), write files and reach the network. " +
  "A rule that matches a command's first words does not see the same command inside a script, under another spelling, behind an alias or as an HTTP call from a language runtime.";

export type AgentArgs =
  | { verb: "install"; kit: KitId; scope: KitScope | undefined; dryRun: boolean; yes: boolean }
  | { verb: "uninstall"; kit: KitId; scope: KitScope | undefined; dryRun: boolean; yes: boolean }
  | { verb: "status"; json: boolean }
  | { verb: "hook"; kit: "claude-code" };

function parseInstall(rest: string[], verb: "install" | "uninstall"): AgentArgs | undefined {
  let kit: KitId | undefined;
  let scope: KitScope | undefined;
  let dryRun = false;
  let yes = false;
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--yes") yes = true;
    else if (a === "--scope") {
      const v = rest[i + 1];
      if (scope !== undefined || (v !== "user" && v !== "project")) return undefined;
      scope = v;
      i += 1;
    } else if (isKitId(a) && kit === undefined) kit = a;
    else return undefined;
  }
  return kit === undefined ? undefined : { verb, kit, scope, dryRun, yes };
}

export function parseAgentArgs(argv: string[]): AgentArgs | undefined {
  const [verb, ...rest] = argv;
  if (verb === "install" || verb === "uninstall") return parseInstall(rest, verb);
  if (verb === "status") {
    if (rest.length === 0) return { verb: "status", json: false };
    return rest.length === 1 && rest[0] === "--json" ? { verb: "status", json: true } : undefined;
  }
  if (verb === "hook") {
    return rest.length === 1 && rest[0] === "claude-code"
      ? { verb: "hook", kit: "claude-code" }
      : undefined;
  }
  return undefined;
}

export interface AgentCmdDeps {
  /** Builds the kit environment; throws `KitRefusal` when this is not an installed `nimbus`. */
  env(): KitEnv;
  readonly tty: { readonly stdin: boolean; readonly stdout: boolean };
  ask(question: string): Promise<string>;
  out(text: string): void;
  err(text: string): void;
  apply(plan: KitPlan): Promise<ApplyResult>;
  /** The agent program's version line, or a short reason it is not known. Never throws. */
  versionOf(program: string): Promise<string>;
  /** Whether the gateway answered `capture.status`. Never throws. */
  gatewayAnswers(): Promise<boolean>;
  readStdin(): Promise<string>;
}

/** A config file can hold anything; never let it drive the terminal. Line breaks are kept. */
function printable(text: string): string {
  return text.split("\n").map(stripControlChars).join("\n");
}

function planText(plan: KitPlan, removal = false): string {
  const lines = removal
    ? [`Remove the Nimbus agent kit: ${plan.kit} (${plan.scope} scope)`, ""]
    : [
        `Nimbus agent kit: ${plan.kit} (${plan.scope} scope)`,
        `Steering: ${plan.enforcement}. ${NOT_A_BOUNDARY}`,
        "",
      ];
  const pending = pendingEdits(plan);
  for (const f of pending) {
    const kept = "the file as it is now is kept beside it as a .nimbus-bak-<time> copy";
    let heading = `Change ${printable(f.path)} (${kept})`;
    if (f.before === null) heading = `Create ${printable(f.path)}`;
    else if (f.remove === true) heading = `Delete ${printable(f.path)} (${kept})`;
    lines.push(heading, printable(unifiedDiff(f.before, f.after)), "");
  }
  if (pending.length === 0) {
    lines.push(removal ? "Nothing of this kit is installed here." : "No file needs to change.", "");
  }
  for (const m of plan.manual) {
    lines.push(
      `Run this yourself (${m.why}):`,
      `  ${printable(m.argv.map((a) => quoteForPrintedCommand(a)).join(" "))}`,
      "",
    );
  }
  for (const n of plan.notes) lines.push(`Note: ${printable(n)}`);
  if (!removal) lines.push("", AGENT_DOOR_BOUNDS, "", OUTSIDE_THE_DOOR, "");
  return lines.join("\n");
}

/**
 * Shows `plan`, then writes it after a typed `yes`. Install and uninstall share this on purpose:
 * the same prompt rules, the same backups, the same refusal with no terminal.
 */
async function showAskApply(
  plan: KitPlan,
  a: { dryRun: boolean; yes: boolean },
  deps: AgentCmdDeps,
  verb: "install" | "uninstall",
): Promise<number> {
  deps.out(`${planText(plan, verb === "uninstall")}\n`);
  const pending = pendingEdits(plan);
  if (a.dryRun) {
    deps.out("Dry run: nothing was written.\n");
    return 0;
  }
  if (pending.length === 0) return 0;
  if (!a.yes) {
    if (!(deps.tty.stdin && deps.tty.stdout)) {
      deps.err(
        `nimbus agent ${verb} changes another program's configuration and asks first. Run it in a terminal, or read \`--dry-run\` and pass \`--yes\`.\n`,
      );
      return 1;
    }
    const answer = await deps.ask("Type yes to write these changes: ");
    if (answer !== "yes") {
      deps.out("Nothing was written.\n");
      return 1;
    }
  }
  const result = await deps.apply(plan);
  for (const w of result.written) {
    let line = `Changed ${printable(w.path)} (before: ${printable(w.backup ?? "")})`;
    if (w.backup === undefined) line = `Created ${printable(w.path)}`;
    else if (w.deleted === true)
      line = `Deleted ${printable(w.path)} (before: ${printable(w.backup)})`;
    deps.out(`${line}\n`);
  }
  if (result.failure !== undefined) {
    deps.err(`${printable(result.failure.message)}\n`);
    return 1;
  }
  deps.out("Check it any time with: nimbus agent status\n");
  return 0;
}

async function runInstall(
  a: Extract<AgentArgs, { verb: "install" }>,
  deps: AgentCmdDeps,
): Promise<number> {
  const scope = a.scope ?? DEFAULT_SCOPE[a.kit];
  return showAskApply(planKit(a.kit, deps.env(), scope), a, deps, "install");
}

async function runUninstall(
  a: Extract<AgentArgs, { verb: "uninstall" }>,
  deps: AgentCmdDeps,
): Promise<number> {
  const scope = a.scope ?? DEFAULT_SCOPE[a.kit];
  return showAskApply(planKitRemoval(a.kit, deps.env(), scope), a, deps, "uninstall");
}

const VERSION_PROGRAM: Partial<Record<KitId, string>> = { "claude-code": "claude", codex: "codex" };

function statusLines(s: KitStatus, version: string | undefined): string[] {
  if (s.unreadable !== undefined) {
    return [`${s.kit} (${s.scope}): cannot tell: ${printable(s.unreadable)}`];
  }
  if (!s.installed) return [`${s.kit} (${s.scope}): not installed`];
  const agent = version === undefined ? "" : `; agent version ${version}`;
  const lines = [`${s.kit} (${s.scope}): steering ${s.enforcement}${agent}`];
  for (const c of s.components) {
    const where = printable(c.where);
    if (c.state === "manual") {
      lines.push(
        `  ${c.component}: manual (Nimbus cannot read where this lands). Command: ${where}`,
      );
    } else if (c.state === "cannot tell") {
      lines.push(`  ${c.component}: cannot tell  ${where} (${printable(c.reason ?? "")})`);
    } else {
      lines.push(`  ${c.component}: ${c.state}  ${where}`);
    }
  }
  for (const n of s.notes) lines.push(`  note: ${n}`);
  return lines;
}

/** The version of each installed kit's agent program, read once per kit. */
async function agentVersions(
  installed: readonly KitStatus[],
  deps: AgentCmdDeps,
): Promise<Map<KitId, string>> {
  const kits = [...new Set(installed.map((s) => s.kit))];
  const entries = await Promise.all(
    kits.map(async (kit): Promise<[KitId, string] | undefined> => {
      const program = VERSION_PROGRAM[kit];
      return program === undefined ? undefined : [kit, printable(await deps.versionOf(program))];
    }),
  );
  return new Map(entries.filter((e) => e !== undefined));
}

function statusJson(
  statuses: readonly KitStatus[],
  versions: Map<KitId, string>,
  gateway: string,
  attention: boolean,
): string {
  return JSON.stringify(
    {
      kits: statuses.map((s) => ({ ...s, agentVersion: versions.get(s.kit) ?? null })),
      gateway,
      needsAttention: attention,
      bounds: AGENT_DOOR_BOUNDS,
      outsideTheDoor: OUTSIDE_THE_DOOR,
    },
    null,
    2,
  );
}

function statusText(
  statuses: readonly KitStatus[],
  versions: Map<KitId, string>,
  gateway: string,
  attention: boolean,
): string {
  const shown = statuses.filter((s) => s.installed || s.unreadable !== undefined);
  const lines = statuses.some((s) => s.installed) ? [] : ["No agent kit is installed."];
  for (const s of shown) lines.push(...statusLines(s, versions.get(s.kit)));
  lines.push(
    "",
    `gateway: ${gateway}`,
    "",
    NOT_A_BOUNDARY,
    "",
    AGENT_DOOR_BOUNDS,
    "",
    OUTSIDE_THE_DOOR,
  );
  if (attention) {
    lines.push("", "Run `nimbus agent install <kit> --dry-run` to see what would change.");
  }
  return lines.join("\n");
}

async function runStatus(a: { json: boolean }, deps: AgentCmdDeps): Promise<number> {
  const statuses = allKitStatuses(deps.env());
  const versions = await agentVersions(
    statuses.filter((s) => s.installed),
    deps,
  );
  const gateway = (await deps.gatewayAnswers()) ? "running" : "not running";
  const attention = needsAttention(statuses);
  const render = a.json ? statusJson : statusText;
  deps.out(`${render(statuses, versions, gateway, attention)}\n`);
  return attention ? 1 : 0;
}

/** The hook answers, or stays silent. It never fails: a failure here must not block the agent. */
async function runHook(deps: AgentCmdDeps): Promise<number> {
  try {
    deps.out(hookOutput(decideHook(await deps.readStdin())));
  } catch {
    // No decision.
  }
  return 0;
}

export async function runAgentWith(argv: string[], deps: AgentCmdDeps): Promise<number> {
  const a = parseAgentArgs(argv);
  if (a === undefined) {
    deps.err(`${AGENT_USAGE}\n`);
    return 2;
  }
  if (a.verb === "hook") return runHook(deps);
  try {
    if (a.verb === "install") return await runInstall(a, deps);
    return a.verb === "uninstall" ? await runUninstall(a, deps) : await runStatus(a, deps);
  } catch (e) {
    if (!(e instanceof KitRefusal)) throw e;
    deps.err(`${printable(e.message)}\n`);
    return 1;
  }
}
