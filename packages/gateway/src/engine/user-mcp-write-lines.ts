// packages/gateway/src/engine/user-mcp-write-lines.ts
// How a user MCP server's WRITE directories are shown to the owner (I15; Phase 28 AD5b). Pure
// display, used by every prompt that concerns such a server: the registration prompt, the agent
// door's enable prompt, and the per-call prompt on all three doors.
//
// Every variable string goes through `escapeUnverifiedLine`, so a directory name cannot start a new
// prompt line or imitate one of the gateway's fixed lines. A server with no write directory adds
// nothing here, so every prompt for such a server is byte-identical to what it was before AD5b.
import { escapeUnverifiedLine } from "./proposer-block.ts";

/** The header of the block; the same words on every door. */
export const USER_MCP_WRITE_HEADER =
  "WRITE ACCESS: this server's code can create and change files under:";

/** What "write" means on this OS (owner ruling OR-AD-31: Windows is create and modify only). */
export function userMcpWriteOsLine(platform: string): string {
  return platform === "win32"
    ? "On Windows it cannot delete or rename there."
    : "It can also delete and rename there.";
}

/** The fixed warning, the same on every door. */
export const USER_MCP_WRITE_WARNING_LINES: readonly string[] = Object.freeze([
  "This is third-party code. Nimbus does not read, check or undo what it writes.",
  "Do not run git, open the folder in an editor that runs workspace code, or run a build there unless you trust this server.",
]);

/**
 * The write block for a non-empty list of directories: the header, one line per directory, what
 * write means on this OS, and the warning. Empty for an empty list.
 */
export function userMcpWriteLines(dirs: readonly string[], platform: string): string[] {
  if (dirs.length === 0) return [];
  return [
    USER_MCP_WRITE_HEADER,
    ...dirs.map((d) => `  write: ${escapeUnverifiedLine(d)}`),
    userMcpWriteOsLine(platform),
    ...USER_MCP_WRITE_WARNING_LINES,
  ];
}

function stringList(v: unknown): readonly string[] | undefined {
  return Array.isArray(v) && v.every((x): x is string => typeof x === "string") ? v : undefined;
}

function listLines(label: string, values: readonly string[]): string[] {
  return values.length === 0
    ? [`  ${label}: none`]
    : values.map((v) => `  ${label}: ${escapeUnverifiedLine(v)}`);
}

/**
 * The purpose-built registration prompt of a `connector.addMcp` that carries a write directory:
 * exactly the resolved registration that will be stored, then the write block, then how long the
 * grant lasts. `undefined` when the payload carries no write directory (the registration then keeps
 * the prompt it always had) or is not the shape the handler builds.
 */
export function addMcpWritePromptLines(
  payload: Record<string, unknown> | undefined,
): string[] | undefined {
  const writePaths = stringList(payload?.["writePaths"]);
  if (writePaths === undefined || writePaths.length === 0) return undefined;
  const serviceId = payload?.["serviceId"];
  const command = payload?.["command"];
  const args = stringList(payload?.["args"]);
  const readPaths = stringList(payload?.["readPaths"]);
  const netHosts = stringList(payload?.["netHosts"]);
  const platform = payload?.["writePlatform"];
  if (
    typeof serviceId !== "string" ||
    typeof command !== "string" ||
    typeof platform !== "string" ||
    args === undefined ||
    readPaths === undefined ||
    netHosts === undefined
  ) {
    return undefined;
  }
  const lines = [
    `Register a user MCP server: ${escapeUnverifiedLine(serviceId)}`,
    `Command: ${escapeUnverifiedLine(command)}`,
    ...(args.length === 0
      ? ["Arguments: none"]
      : ["Arguments:", ...args.map((a) => `  ${escapeUnverifiedLine(a)}`)]),
    "Sandbox reach:",
    ...listLines("read", readPaths),
    ...listLines("net", netHosts),
  ];
  const note = payload?.["networkNote"];
  if (typeof note === "string") lines.push(`  net note: ${escapeUnverifiedLine(note)}`);
  lines.push(
    `Offered to the model: ${payload?.["modelAccess"] === true ? "yes" : "no"}`,
    "",
    ...userMcpWriteLines(writePaths, platform),
    `The grant lasts until you remove the server: nimbus connector remove ${escapeUnverifiedLine(serviceId)}`,
  );
  return lines;
}
