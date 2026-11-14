// packages/gateway/src/engine/user-mcp-call-block.ts
// The per-call block of an outside agent's proposal for a tool of a user-registered MCP server
// (Phase 28 AD5a, D-6; invariants I42 and I28). Pure display: it says that the code is third-party
// code the owner registered, which server and tool, the sandbox reach, whether the owner approved
// the tool for agents by name (and the definition it was approved at), and the server's own
// description of the tool, marked UNVERIFIED.
//
// Every variable string goes through `escapeUnverifiedLine`, so none can start a new prompt line,
// close its quotes or imitate one of the gateway's fixed lines. The facts come from the agent
// door (`UserMcpCallFacts`); nothing here selects a tool or reaches the connector call (I3).
import { sanitisePreviewText } from "../connectors/connector-writes/sanitise.ts";
import { escapeUnverifiedLine } from "./proposer-block.ts";
import type { UserMcpCallFacts } from "./types.ts";

/** The most characters of the server's description the owner is shown (the model door's own cap). */
export const USER_MCP_DESCRIPTION_SHOWN_MAX = 1000;

/** The most lines each list shows before "and N more". */
const LIST_LINES_MAX = 20;

/** The fixed last line: a user MCP tool has no typed preview and no before-state reader. */
export const USER_MCP_NO_BEFORE_STATE_LINE = "No before-state is available for a user MCP tool.";

const NO_WRITE_LINE = "  write: none beyond its own sandbox directory";

/** The first `max` code points of `s`: a cut never splits a surrogate pair. */
function cutCodePoints(s: string, max: number): string {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join("");
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** `  <label>: <value>` lines, capped, or one `none` line for an empty list. */
function listLines(label: string, values: readonly string[]): string[] {
  if (values.length === 0) return [`  ${label}: none`];
  const lines = values
    .slice(0, LIST_LINES_MAX)
    .map((v) => `  ${label}: ${escapeUnverifiedLine(v)}`);
  if (values.length > LIST_LINES_MAX) {
    lines.push(`  ${label}: and ${values.length - LIST_LINES_MAX} more`);
  }
  return lines;
}

/** The block's lines, in order; the executor puts them before the verbatim input. */
export function userMcpCallLines(f: UserMcpCallFacts): string[] {
  const lines = [
    `User MCP server: ${escapeUnverifiedLine(f.serviceId)} (third-party code you registered on ${iso(f.registeredAt)})`,
    "Sandbox reach:",
    ...listLines("read", f.readPaths),
    ...listLines("net", f.netHosts),
  ];
  if (f.networkNote !== undefined) {
    lines.push(`  net note: ${escapeUnverifiedLine(f.networkNote)}`);
  }
  if (f.writePaths.length === 0) lines.push(NO_WRITE_LINE);
  else lines.push(...listLines("write", f.writePaths));
  lines.push(`Tool: ${escapeUnverifiedLine(f.tool)}`);
  if (f.approval === null) {
    lines.push("Not approved for outside agents by name.");
  } else {
    lines.push(
      `Approved for outside agents on ${iso(f.approval.approvedAt)}, definition ${f.approval.definitionSha256.slice(0, 12)}`,
      `Tool description (the server's own text, UNVERIFIED): "${escapeUnverifiedLine(cutCodePoints(f.approval.description, USER_MCP_DESCRIPTION_SHOWN_MAX))}"`,
    );
  }
  lines.push(USER_MCP_NO_BEFORE_STATE_LINE);
  return lines;
}

/**
 * The structured copy the desktop reads (`details.userMcp`), escaped with the preview sanitiser.
 * It carries the first twelve hex characters of the approved hash, never the whole hash.
 */
export function userMcpCallDetails(f: UserMcpCallFacts): Record<string, unknown> {
  return {
    serviceId: sanitisePreviewText(f.serviceId),
    tool: sanitisePreviewText(f.tool),
    registeredAt: f.registeredAt,
    readPaths: f.readPaths.slice(0, LIST_LINES_MAX).map(sanitisePreviewText),
    netHosts: f.netHosts.slice(0, LIST_LINES_MAX).map(sanitisePreviewText),
    ...(f.networkNote === undefined ? {} : { networkNote: sanitisePreviewText(f.networkNote) }),
    writePaths: f.writePaths.slice(0, LIST_LINES_MAX).map(sanitisePreviewText),
    approved: f.approval !== null,
    ...(f.approval === null
      ? {}
      : {
          approvedAt: f.approval.approvedAt,
          definitionSha12: f.approval.definitionSha256.slice(0, 12),
          description: sanitisePreviewText(
            cutCodePoints(f.approval.description, USER_MCP_DESCRIPTION_SHOWN_MAX),
          ),
        }),
  };
}
