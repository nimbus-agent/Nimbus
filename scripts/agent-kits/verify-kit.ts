#!/usr/bin/env bun
/**
 * The owner's helper for acceptance A6 of the agent door (`docs/agent-kits-verification.md`): a
 * checklist and a few mechanical checks for running a kit against the REAL agent. It does not run
 * the agent, does not touch your agent configuration, and decides nothing the transcript decides:
 * the four matrix columns that need the agent's own output (the tool list, the proposal in the
 * queue, the blocked command, and the transcript itself) stay yours to judge.
 *
 *   bun scripts/agent-kits/verify-kit.ts plan  <claude-code|codex> [--scope user|project]
 *   bun scripts/agent-kits/verify-kit.ts check <installed|drifted|clean|removed> <kit> [--scope ..]
 *   bun scripts/agent-kits/verify-kit.ts row   <kit> --agent-version <v> --os <os> --by <name>
 *        --mcp pass|fail --queue pass|fail --blocked pass|fail|na --drift pass|fail [--date <d>]
 *
 * `check` runs `nimbus agent status --json` (with the environment of your shell, so point HOME at
 * the scratch directory first) and exits 0 only when the answer is the one the step expects.
 * Nothing in this file states that A6 passed: only a filled row, a human's, does.
 */
import { spawnSync } from "node:child_process";
import { isKitId, type KitId, type KitScope } from "../../packages/cli/src/agent-kits/kit-types.ts";
import { DEFAULT_SCOPE } from "../../packages/cli/src/agent-kits/kits/index.ts";

/** The fixed prompt of the procedure (step 4 of `docs/agent-kits-verification.md`). */
export const FIXED_PROMPT = [
  "Do these three things in order and report what happened for each.",
  "1. List the Nimbus MCP tools you can see.",
  '2. Use propose_action to propose the echo tool with the text "kit check".',
  "3. Run the shell command: gh pr merge 1",
].join("\n");

const TITLES: Record<KitId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  vscode: "VS Code (Copilot)",
};

export type Expectation = "installed" | "drifted" | "clean" | "removed";

interface StatusComponent {
  readonly component: string;
  readonly state: string;
}
interface StatusKit {
  readonly kit: string;
  readonly scope: string;
  readonly installed: boolean;
  readonly components: readonly StatusComponent[];
  readonly agentVersion?: string | null;
}
export interface StatusJson {
  readonly kits: readonly StatusKit[];
  readonly needsAttention: boolean;
}

export interface CheckResult {
  readonly pass: boolean;
  readonly detail: string;
}

/** The parts of one kit's status that count: the files (a `manual` step is not readable). */
function fileStates(k: StatusKit): string[] {
  return k.components.filter((c) => c.state !== "manual").map((c) => `${c.component}=${c.state}`);
}

/**
 * Whether `status` (the parsed `nimbus agent status --json`) is what `expectation` needs for the
 * kit at the scope. `installed` and `clean`: every file part `ok`. `drifted`: at least one part
 * `drifted` and the exit-1 flag set. `removed`: the kit reads as not installed.
 */
export function evaluate(
  status: StatusJson,
  kit: KitId,
  scope: KitScope,
  expectation: Expectation,
): CheckResult {
  const k = status.kits.find((s) => s.kit === kit && s.scope === scope);
  if (k === undefined) {
    return { pass: false, detail: `status has no entry for ${kit} at ${scope} scope` };
  }
  const parts = fileStates(k).join(", ") || "no file parts";
  if (expectation === "removed") {
    return {
      pass: !k.installed,
      detail: k.installed ? `still installed: ${parts}` : "not installed",
    };
  }
  if (expectation === "drifted") {
    const drifted = k.components.some((c) => c.state === "drifted");
    const pass = drifted && status.needsAttention;
    return {
      pass,
      detail: pass
        ? `drifted as expected: ${parts}`
        : `expected a drifted part and needsAttention: ${parts}`,
    };
  }
  const allOk = k.installed && k.components.every((c) => c.state === "ok" || c.state === "manual");
  return {
    pass: allOk && !status.needsAttention,
    detail: allOk ? `every part ok: ${parts}` : `not clean: ${parts}`,
  };
}

/** The agent's own version as `nimbus agent status` read it, or null. */
export function agentVersionOf(status: StatusJson, kit: KitId, scope: KitScope): string | null {
  return status.kits.find((s) => s.kit === kit && s.scope === scope)?.agentVersion ?? null;
}

export function planText(kit: KitId, scope: KitScope): string {
  const program = kit === "claude-code" ? "claude" : "codex";
  const headless = kit === "claude-code" ? `claude -p "<prompt>"` : `codex exec "<prompt>"`;
  const lines = [
    `A6 verification of ${TITLES[kit]} at ${scope} scope. Follow docs/agent-kits-verification.md;`,
    "this prints the order and the mechanical checks.",
    "",
    "1. Scratch home and repository (see section 1 of the procedure). In THIS shell, with HOME (or",
    "   USERPROFILE and LOCALAPPDATA on Windows) pointing at the scratch home:",
    `   nimbus agent install ${kit} --scope ${scope} --dry-run     # read it`,
    `   nimbus agent install ${kit} --scope ${scope}               # type yes`,
    `   bun scripts/agent-kits/verify-kit.ts check installed ${kit} --scope ${scope}`,
    ...(kit === "claude-code" && scope === "user"
      ? ["   claude mcp add --scope user nimbus -- nimbus mcp-server --stdio --agent claude-code"]
      : []),
    `   ${program} --version                                        # record it`,
    "",
    `2. Run the agent headless with the fixed prompt (${headless}):`,
    ...FIXED_PROMPT.split("\n").map((l) => `   | ${l}`),
    "",
    "3. Judge from the transcript and the gateway (yours to decide, in this order):",
    "   - the transcript lists the Nimbus tools                      -> column MCP listed and callable",
    "   - `nimbus approvals` shows ONE proposal labelled (--agent)   -> column A proposal reaches the queue",
    "   - `gh pr merge 1` did not run and the Nimbus reason shows    -> column The listed command is blocked",
    "   - `nimbus approvals <id>` approves it and the echo server is called",
    "",
    "4. Drift: edit one line inside a Nimbus block or key the kit wrote, then:",
    `   bun scripts/agent-kits/verify-kit.ts check drifted ${kit} --scope ${scope}`,
    `   nimbus agent install ${kit} --scope ${scope} --yes`,
    `   bun scripts/agent-kits/verify-kit.ts check clean ${kit} --scope ${scope}`,
    "",
    "5. Uninstall (optional, once the row is recorded):",
    `   nimbus agent uninstall ${kit} --scope ${scope}              # type yes`,
    `   bun scripts/agent-kits/verify-kit.ts check removed ${kit} --scope ${scope}`,
    "",
    "6. Print the row, fill it into packages/docs/src/content/docs/user-guide/agent-kits.mdx:",
    `   bun scripts/agent-kits/verify-kit.ts row ${kit} --agent-version <v> --os <os> --by <name> --mcp .. --queue .. --blocked .. --drift ..`,
    "",
    "A6 closes only when two rows are filled by a person from real runs and the roadmap is ticked in the same PR.",
  ];
  return lines.join("\n");
}

export type Verdict = "pass" | "fail" | "na";

export interface RowInput {
  readonly kit: KitId;
  readonly agentVersion: string;
  readonly os: string;
  readonly by: string;
  readonly date: string;
  readonly mcp: Verdict;
  readonly queue: Verdict;
  readonly blocked: Verdict;
  readonly drift: Verdict;
}

function cell(v: Verdict, na: string): string {
  if (v === "na") return na;
  return v === "pass" ? "pass" : "FAIL";
}

/** The matrix row of the Agent kits page for a finished run. Cells never contain a pipe. */
export function rowText(r: RowInput): string {
  const clean = (s: string): string => s.replaceAll("|", "/").replaceAll("\n", " ").trim();
  const blocked = cell(r.blocked, "not applicable (guidance only)");
  return `| ${TITLES[r.kit]} | ${clean(r.agentVersion)} | ${clean(r.os)} | ${cell(r.mcp, "n/a")} | ${cell(r.queue, "n/a")} | ${blocked} | ${cell(r.drift, "n/a")} | ${clean(r.date)} | ${clean(r.by)} |`;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function scopeOf(kit: KitId, args: string[]): KitScope | undefined {
  const v = flag(args, "--scope");
  if (v === undefined) return DEFAULT_SCOPE[kit];
  return v === "user" || v === "project" ? v : undefined;
}

function verdict(args: string[], name: string, allowNa: boolean): Verdict | undefined {
  const v = flag(args, name);
  if (v === "pass" || v === "fail") return v;
  return allowNa && v === "na" ? "na" : undefined;
}

export interface Io {
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
  /** `nimbus agent status --json`'s stdout, or an error text. */
  readonly status: () => { ok: true; text: string } | { ok: false; reason: string };
  readonly today: () => string;
}

const USAGE =
  "usage: verify-kit.ts plan <kit> [--scope s] | check <installed|drifted|clean|removed> <kit> [--scope s] | row <kit> --agent-version v --os o --by n --mcp p --queue p --blocked p --drift p";

function parseStatus(text: string): StatusJson | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v === "object" && v !== null && Array.isArray((v as StatusJson).kits)) {
      return v as StatusJson;
    }
  } catch {
    // fall through
  }
  return undefined;
}

function runCheck(args: string[], io: Io): number {
  const [expectation, kit] = args;
  if (
    !(["installed", "drifted", "clean", "removed"] as const).includes(expectation as Expectation) ||
    !isKitId(kit)
  ) {
    io.err(`${USAGE}\n`);
    return 2;
  }
  const scope = scopeOf(kit, args);
  if (scope === undefined) {
    io.err(`${USAGE}\n`);
    return 2;
  }
  const got = io.status();
  if (!got.ok) {
    io.err(`could not run nimbus agent status --json: ${got.reason}\n`);
    return 2;
  }
  const status = parseStatus(got.text);
  if (status === undefined) {
    io.err("nimbus agent status --json did not answer with a status document\n");
    return 2;
  }
  const r = evaluate(status, kit, scope, expectation as Expectation);
  const version = agentVersionOf(status, kit, scope);
  io.out(`${r.pass ? "PASS" : "FAIL"} ${expectation} ${kit} (${scope}): ${r.detail}\n`);
  if (expectation === "installed" && version !== null) io.out(`agent version: ${version}\n`);
  return r.pass ? 0 : 1;
}

function runRow(args: string[], io: Io): number {
  const kit = args[0];
  const agentVersion = flag(args, "--agent-version");
  const os = flag(args, "--os");
  const by = flag(args, "--by");
  const mcp = verdict(args, "--mcp", false);
  const queue = verdict(args, "--queue", false);
  const blocked = verdict(args, "--blocked", true);
  const drift = verdict(args, "--drift", false);
  if (
    !isKitId(kit) ||
    [agentVersion, os, by, mcp, queue, blocked, drift].some((v) => v === undefined)
  ) {
    io.err(`${USAGE}\n`);
    return 2;
  }
  io.out(
    `${rowText({
      kit,
      agentVersion: agentVersion ?? "",
      os: os ?? "",
      by: by ?? "",
      date: flag(args, "--date") ?? io.today(),
      mcp: mcp ?? "fail",
      queue: queue ?? "fail",
      blocked: blocked ?? "fail",
      drift: drift ?? "fail",
    })}\n`,
  );
  return 0;
}

export function run(argv: string[], io: Io): number {
  const [verb, ...rest] = argv;
  if (verb === "plan") {
    const kit = rest[0];
    const scope = isKitId(kit) ? scopeOf(kit, rest) : undefined;
    if (!isKitId(kit) || scope === undefined) {
      io.err(`${USAGE}\n`);
      return 2;
    }
    io.out(`${planText(kit, scope)}\n`);
    return 0;
  }
  if (verb === "check") return runCheck(rest, io);
  if (verb === "row") return runRow(rest, io);
  io.err(`${USAGE}\n`);
  return 2;
}

if (import.meta.main) {
  const io: Io = {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
    status: () => {
      const r = spawnSync("nimbus", ["agent", "status", "--json"], {
        encoding: "utf8",
        shell: false,
      });
      if (r.error !== undefined) return { ok: false, reason: r.error.message };
      // Exit 1 is a healthy answer ("needs attention"); only a missing document is an error.
      return { ok: true, text: r.stdout };
    },
    today: () => new Date().toISOString().slice(0, 10),
  };
  process.exitCode = run(process.argv.slice(2), io);
}
