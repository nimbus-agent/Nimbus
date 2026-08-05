import {
  type AdapterDeps,
  createProductionDeps,
  runMcpServerStdio,
  TOOL_SPECS,
} from "../mcp/adapter.ts";

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
 */
export function formatHelp(): string {
  const names = TOOL_SPECS.map((s) => s.name);
  return `nimbus mcp-server — expose the Nimbus local index to editor AIs over MCP

Usage:
  nimbus mcp-server            Print the MCP server config block to paste into your editor
  nimbus mcp-server --stdio    Run the MCP server over stdio (your editor launches this)

Read-only tools (${String(names.length)}):
${wrapList(names, HELP_WIDTH)}

Every tool is read-only: none reaches a write or HITL-gated action. The Gateway
must be running (start it with: nimbus start).`;
}

export type McpServerArgs = { kind: "help" } | { kind: "config" } | { kind: "stdio" };

export function parseMcpServerArgs(args: string[]): McpServerArgs {
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    return { kind: "help" };
  }
  if (args.includes("--stdio")) {
    return { kind: "stdio" };
  }
  return { kind: "config" };
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
    console.log(formatHelp());
    return;
  }
  if (parsed.kind === "config") {
    console.log(formatConfigBlock());
    return;
  }
  await deps.runStdio(deps.makeDeps());
}
