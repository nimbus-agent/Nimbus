import { isAbsolute, resolve } from "node:path";

export type AddMcpRequest = {
  serviceId: string;
  argv: string[];
  readPaths: string[];
  netHosts: string[];
  modelAccess: boolean;
};

export const ADD_MCP_USAGE =
  "Usage: nimbus connector add --mcp <mcp_id> [--read <path>]... [--net <host[:port]>]... [--model] -- <command> [args...]\n" +
  "Example: nimbus connector add --mcp mcp_echo -- /abs/path/echo/dist/echo";

function usageError(): Error {
  return new Error(ADD_MCP_USAGE);
}

/** A command with a path separator but no root is relative to the CLI's cwd; a bare name is left for the gateway's PATH. */
function resolveCommand(command: string, cwd: string): string {
  const hasSeparator = command.includes("/") || command.includes("\\");
  return hasSeparator && !isAbsolute(command) ? resolve(cwd, command) : command;
}

type Grants = Pick<AddMcpRequest, "readPaths" | "netHosts" | "modelAccess">;

/** Parses the grant flags that precede the `--`; any unknown flag or missing value is a usage error. */
function parseGrantFlags(flags: readonly string[], cwd: string): Grants {
  const grants: Grants = { readPaths: [], netHosts: [], modelAccess: false };
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--model") {
      grants.modelAccess = true;
      continue;
    }
    if (flag !== "--read" && flag !== "--net") throw usageError();
    const value = flags[++i];
    if (value === undefined || value === "" || value.startsWith("-")) throw usageError();
    if (flag === "--read") grants.readPaths.push(resolve(cwd, value));
    else grants.netHosts.push(value);
  }
  return grants;
}

/** Splits the remainder after the id into its grant flags and the command (see `parseAddMcpArgs`). */
function splitFlagsAndCommand(rest: readonly string[]): { flags: string[]; command: string[] } {
  const flagForm = rest[0]?.startsWith("-") === true;
  if (!flagForm) return { flags: [], command: [...rest] };
  const sep = rest.indexOf("--");
  if (sep === -1) throw usageError();
  return { flags: rest.slice(0, sep), command: rest.slice(sep + 1) };
}

/**
 * `tail` is everything after `--mcp`. When the first token after the id is a flag (or the `--`
 * itself), grants are the flags before the FIRST `--` and everything after it is the command
 * verbatim. Otherwise the whole remainder is the command (legacy form) — including any `--` the
 * command carries itself, so `mcp_x npx -y pkg -- --stdio` keeps all five tokens as argv.
 */
export function parseAddMcpArgs(tail: readonly string[], cwd: string): AddMcpRequest {
  const serviceId = tail[0]?.trim() ?? "";
  if (serviceId === "" || serviceId.startsWith("-")) throw usageError();
  const { flags, command } = splitFlagsAndCommand(tail.slice(1));
  const grants = parseGrantFlags(flags, cwd);
  const first = command[0];
  if (first === undefined || first.trim() === "") throw usageError();
  return {
    serviceId,
    argv: [resolveCommand(first, cwd), ...command.slice(1)],
    ...grants,
  };
}
