/**
 * The agent kits' steer table (Phase 28 AD7b, spec section 7.6).
 *
 * Commands an agent could run in a shell that have an equivalent on the agent door, mapped to the
 * door's action type, plus the three commands only the owner runs. A kit turns this into whatever
 * its agent understands: a hook answer for Claude Code, `prefix_rule`s for Codex, instruction text
 * for every agent.
 *
 * This is GUIDANCE, not confinement. A rule that matches a command's leading words does not see the
 * same command inside a script, behind an alias, under another spelling or as an HTTP call from a
 * language runtime. Nothing here is a security boundary; the door's own rules are.
 *
 * It lives in the CLI, not the gateway, because install and the hook must work while the gateway is
 * stopped. `scripts/agent-kits/steer-table.test.ts` holds every `actionType` to a real,
 * model-offerable connector write row.
 */
import { AGENT_DOOR_BOUNDS } from "../lib/agent-door-bounds.ts";

/** Bumped whenever a row is added, removed or retargeted: installed kits then read as drifted. */
export const STEER_TABLE_VERSION = 1;

export interface SteerRow {
  /** The command's leading words, exactly. */
  readonly argv: readonly string[];
  /** The agent door action type to propose instead. */
  readonly actionType: string;
}

/** A command with no door equivalent is NOT listed (`kubectl delete`, `git push --force`). */
export const STEER_ROWS: readonly SteerRow[] = [
  { argv: ["gh", "pr", "merge"], actionType: "github.pr.merge" },
  { argv: ["glab", "mr", "merge"], actionType: "gitlab.mr.merge" },
  { argv: ["terraform", "apply"], actionType: "iac.terraform.apply" },
  { argv: ["kubectl", "apply"], actionType: "kubernetes.manifest.apply" },
  { argv: ["kubectl", "scale"], actionType: "kubernetes.deployment.scale" },
  { argv: ["kubectl", "rollout", "restart"], actionType: "kubernetes.rollout.restart" },
  { argv: ["aws", "lambda", "invoke"], actionType: "aws.lambda.invoke" },
];

/**
 * Commands only the owner runs (owner ruling OR-AD-6): every subcommand, so an agent can neither
 * approve, decline nor list. A deny here reduces accident, not malice.
 */
export const OWNER_COMMANDS: readonly (readonly string[])[] = [
  ["nimbus", "approvals"],
  ["nimbus", "connector", "writes"],
  ["nimbus", "captures"],
];

export function steerReason(actionType: string): string {
  return `Use the Nimbus propose_action tool with type ${actionType} instead (call describe_actions first). The owner approves it in Nimbus.`;
}

export const OWNER_COMMAND_REASON =
  "Only the owner runs this command. Propose the action through Nimbus and wait for the owner.";

export type SteerMatch =
  | { readonly kind: "steer"; readonly row: SteerRow }
  | { readonly kind: "owner"; readonly command: readonly string[] };

/** `/usr/local/bin/nimbus`, `nimbus.exe` and `"nimbus"` all name `nimbus`. */
function programName(word: string): string {
  const slash = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"));
  const base = word.slice(slash + 1).toLowerCase();
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

function startsWith(words: readonly string[], prefix: readonly string[]): boolean {
  if (words.length < prefix.length) return false;
  return prefix.every((p, i) => (i === 0 ? programName(words[0] ?? "") === p : words[i] === p));
}

/** The first table entry whose leading words these are. Owner commands are checked first. */
export function matchSteer(words: readonly string[]): SteerMatch | undefined {
  for (const command of OWNER_COMMANDS) {
    if (startsWith(words, command)) return { kind: "owner", command };
  }
  for (const row of STEER_ROWS) {
    if (startsWith(words, row.argv)) return { kind: "steer", row };
  }
  return undefined;
}

/**
 * The instruction text every kit carries, in the agent's own instructions file. One string, so no
 * kit can say less than another: every steer row, the three owner commands, and the bounds copy
 * (whose last sentence is the self-approval one).
 */
export function renderInstructions(): string {
  const lines = [
    "## Nimbus",
    "",
    "This machine runs Nimbus. Read the owner's indexed context through the Nimbus MCP tools.",
    "To change something in an outside system, PROPOSE it: call `describe_actions`, then",
    "`propose_action`. The owner approves each proposal in Nimbus; you do not.",
    "",
    "Do not run these commands. Propose the matching action instead:",
    "",
    ...STEER_ROWS.map(
      (r) => `- \`${r.argv.join(" ")}\` -> \`propose_action\` type \`${r.actionType}\``,
    ),
    "",
    "Never run these, in any form. They are the owner's commands:",
    "",
    ...OWNER_COMMANDS.map((c) => `- \`${c.join(" ")}\``),
    "",
    AGENT_DOOR_BOUNDS,
  ];
  return lines.join("\n");
}
