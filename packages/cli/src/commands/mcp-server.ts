import { gatewayStartCommand } from "../lib/gateway-not-running.ts";
import {
  type AdapterDeps,
  createProductionDeps,
  INDEX_TOOL_SPECS,
  runMcpServerStdio,
  TOOL_SPECS,
} from "../mcp/adapter.ts";
import { getCliPlatformPaths } from "../paths.ts";

export const MCP_SERVER_CONFIG = {
  mcpServers: {
    nimbus: {
      command: "nimbus",
      args: ["mcp-server", "--stdio"],
    },
  },
} as const;

export function formatConfigBlock(): string {
  return [
    "Add this to your editor's MCP config (e.g. mcp.json). `nimbus` must be on your PATH:",
    "",
    JSON.stringify(MCP_SERVER_CONFIG, null, 2),
  ].join("\n");
}

const HELP_WIDTH = 76;

/** Wrap a comma-joined list to `width` columns so `--help` stays readable in a narrow terminal. */
function wrapList(names: readonly string[], width: number): string {
  const lines: string[] = [];
  let line = "";
  for (const name of names) {
    const piece = line === "" ? name : `${line}, ${name}`;
    if (piece.length <= width) {
      line = piece;
      continue;
    }
    lines.push(`${line},`);
    line = name;
  }
  lines.push(line);
  return lines.join("\n");
}

/**
 * Build the help text, deriving the tool list from `TOOL_SPECS` rather than restating it.
 *
 * `--help` is the primary discovery surface for this command: an operator who sees no agent tools
 * here concludes the feature does not exist. The list was hardcoded and went stale twice — once
 * when `peekWhy` landed and again when the ten agents did — which is exactly why it is derived now.
 *
 * The degraded-gateway note is stated as POLICY, not as this gateway's observed state: `--help` is
 * answered without connecting to anything (`parseMcpServerArgs` → print → return), so the gateway's
 * `session.declareKind` support is not knowable here. Printing a live verdict would mean opening a
 * connection just to render help. The counts are derived from the spec lists, so they cannot drift.
 */
export function formatHelp(demo: boolean = false): string {
  const names = TOOL_SPECS.map((s) => s.name);
  const indexToolCount = INDEX_TOOL_SPECS.length;
  const agentToolCount = TOOL_SPECS.length - indexToolCount;
  return `nimbus mcp-server — expose the Nimbus local index to editor AIs over MCP
(read; optional capture and proposal tools)

Usage:
  nimbus mcp-server            Print the MCP server config block to paste into your editor
  nimbus mcp-server --stdio    Run the MCP server over stdio (your editor launches this)
  nimbus mcp-server --stdio --agent <name>
                               The same, and label what this agent captures or proposes
                               with <name> (lowercase letters, digits and hyphens). The
                               label is shown to you as UNVERIFIED: it is whatever the
                               agent's server entry says, and Nimbus decides nothing by it

Read-only tools (${String(names.length)}):
${wrapList(names, HELP_WIDTH)}

Every tool above is read-only. Write tools are added only when the Gateway's
[mcp_sink] is enabled in nimbus.toml, each only for the kinds you enable:
capture_note stores an agent-authored note in the LOCAL index, and
propose_decision, propose_term and propose_link queue proposals that count only
once you accept them. propose_action queues a connector action that runs only
after you approve it with \`nimbus approvals <id>\` and answer the prompt;
describe_actions tells the agent which action types you accept and, for those
you approved by name, their description and input schema (read only);
capture_status reads the state of a capture this connection submitted. You
review the rest with \`nimbus captures\`. The Gateway must be
running (start it with: ${gatewayStartCommand(demo)}).

On a Gateway too old to support session.declareKind, the ${String(agentToolCount)} agent tools are
withheld and only the ${String(indexToolCount)} index tools are served: such a Gateway cannot record an
MCP-served brief in the egress ledger, and serving one unrecorded would make
\`nimbus prove\` report a clean scope over output it never saw. Upgrade the
Gateway to get them back.`;
}

export type McpServerArgs =
  | { kind: "help" }
  | { kind: "config" }
  | { kind: "stdio"; agent?: string }
  | { kind: "usage"; message: string };

/** What `--agent` accepts: a short lowercase name, as the kits write it (`claude-code`, `codex`). */
export const AGENT_KIT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

const AGENT_USAGE =
  "--agent needs a name of 1 to 32 lowercase letters, digits and hyphens, starting with a letter or digit (for example --agent claude-code)";

export function parseMcpServerArgs(args: string[]): McpServerArgs {
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    return { kind: "help" };
  }
  const at = args.indexOf("--agent");
  const stdio = args.includes("--stdio");
  if (at === -1) {
    return stdio ? { kind: "stdio" } : { kind: "config" };
  }
  const agent = args[at + 1];
  if (agent === undefined || !AGENT_KIT_NAME_RE.test(agent)) {
    return { kind: "usage", message: AGENT_USAGE };
  }
  if (args.indexOf("--agent", at + 1) !== -1) {
    return { kind: "usage", message: "--agent may be given once" };
  }
  if (!stdio) {
    return { kind: "usage", message: "--agent is used with --stdio" };
  }
  return { kind: "stdio", agent };
}

export interface RunMcpServerDeps {
  makeDeps(): AdapterDeps;
  runStdio(deps: AdapterDeps): Promise<void>;
}

const PRODUCTION_DEPS: RunMcpServerDeps = {
  makeDeps: createProductionDeps,
  runStdio: runMcpServerStdio,
};

export async function runMcpServer(
  args: string[],
  deps: RunMcpServerDeps = PRODUCTION_DEPS,
): Promise<void> {
  const parsed = parseMcpServerArgs(args);
  if (parsed.kind === "help") {
    console.log(formatHelp(getCliPlatformPaths().demo === true));
    return;
  }
  if (parsed.kind === "config") {
    console.log(formatConfigBlock());
    return;
  }
  if (parsed.kind === "usage") {
    // Before any connection: a server entry with a bad label must fail where the owner sees it.
    console.error(`nimbus mcp-server: ${parsed.message}`);
    process.exitCode = 2;
    return;
  }
  const adapterDeps = deps.makeDeps();
  if (parsed.agent !== undefined) {
    adapterDeps.agentKit = parsed.agent;
  }
  await deps.runStdio(adapterDeps);
}
