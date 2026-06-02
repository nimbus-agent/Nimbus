import { type AdapterDeps, createProductionDeps, runMcpServerStdio } from "../mcp/adapter.ts";

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

const HELP = `nimbus mcp-server — expose the Nimbus local index to editor AIs over MCP

Usage:
  nimbus mcp-server            Print the MCP server config block to paste into your editor
  nimbus mcp-server --stdio    Run the MCP server over stdio (your editor launches this)

Read-only tools: searchIndex, getConnectorStatus, getRecentIncidents,
getRecentPullRequests, getRecentDeployments, getDoraMetrics.
The Gateway must be running (start it with: nimbus start).`;

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
    console.log(HELP);
    return;
  }
  if (parsed.kind === "config") {
    console.log(formatConfigBlock());
    return;
  }
  await deps.runStdio(deps.makeDeps());
}
