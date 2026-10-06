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

/**
 * `tail` is everything after `--mcp`. When the first token after the id is a flag (or the `--`
 * itself), grants are the flags before the FIRST `--` and everything after it is the command
 * verbatim. Otherwise the whole remainder is the command (legacy form) — including any `--` the
 * command carries itself, so `mcp_x npx -y pkg -- --stdio` keeps all five tokens as argv.
 */
export function parseAddMcpArgs(tail: readonly string[], cwd: string): AddMcpRequest {
  const serviceId = tail[0]?.trim() ?? "";
  if (serviceId === "" || serviceId.startsWith("-")) throw usageError();
  const rest = tail.slice(1);
  const flagForm = rest[0]?.startsWith("-") === true;
  const sep = flagForm ? rest.indexOf("--") : -1;

  const readPaths: string[] = [];
  const netHosts: string[] = [];
  let modelAccess = false;
  let command: string[];

  if (sep === -1) {
    if (flagForm) throw usageError();
    command = rest;
  } else {
    command = rest.slice(sep + 1);
    const flags = rest.slice(0, sep);
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i];
      if (flag === "--model") {
        modelAccess = true;
      } else if (flag === "--read" || flag === "--net") {
        const value = flags[++i];
        if (value === undefined || value === "" || value.startsWith("-")) throw usageError();
        if (flag === "--read") readPaths.push(resolve(cwd, value));
        else netHosts.push(value);
      } else {
        throw usageError();
      }
    }
  }

  const first = command[0];
  if (first === undefined || first.trim() === "") throw usageError();
  return {
    serviceId,
    argv: [resolveCommand(first, cwd), ...command.slice(1)],
    readPaths,
    netHosts,
    modelAccess,
  };
}
