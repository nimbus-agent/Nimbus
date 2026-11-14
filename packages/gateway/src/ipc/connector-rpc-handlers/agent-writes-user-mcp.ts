// packages/gateway/src/ipc/connector-rpc-handlers/agent-writes-user-mcp.ts
// `connector.writesEnable` with `door: "agent"` for a user-registered MCP server (`mcp_<id>`; Phase 28
// AD5a, D-4; owner rulings OR-AD-22 to OR-AD-24; invariants I42 and I58): the owner approves, BY EXACT
// TOOL NAME and with a hash of each tool's listed definition, the tools of a server THEY registered that
// an outside agent may propose. The agent door reads the list at submit, at approval and after the
// owner's answer (`connectors/connector-writes/agent-door-runtime.ts`).
//
// The order is fixed, each step before the next; read it top to bottom:
//   1. the caller declared `cli` or `ui` and a gate exists (a person is there: OR-AD-11);
//   2. the arguments: `wave` and the scope parameters are refused; `approve` names are exact tool
//      names, de-duplicated first so a repeated name appears once in the prompt, the reply and the rows;
//      with none, the command lists the server's tools and asks nothing (OR-AD-23);
//   3. the server is registered;
//   4. policy allows `mcp_action` and `user_mcp_model_access`, from the LIVE resolved policy;
//   5. the listing, the ONLY I/O before the prompt (it starts the sandboxed third-party server, as
//      `nimbus connector tools` does);
//   6. each named tool is in the listing and hashes;
//   7. the owner's gate (`connector.writes.enable`, already in the frozen set), on the human-only
//      channel the dispatcher builds for `door: "agent"`;
//   8. ONE transaction: re-check the registration is the one that was shown, then upsert the approvals.
// It never writes the shared wave row (`raiseWriteEnablementWave`): an `mcp_*` id has no write rows.
//
// This module never names the approval table (static D49(b)): it goes through the store.
import { sha12 } from "../../connectors/connector-writes/agent-door-definition.ts";
import { definitionSha256 } from "../../connectors/connector-writes/definition-hash.ts";
import {
  type DoorApproval,
  type DoorApprovalEntry,
  listDoorApprovals,
  upsertDoorApprovals,
} from "../../connectors/connector-writes/door-approval-store.ts";
import { mcpClientToolKey } from "../../connectors/lazy-mesh/tool-map.ts";
import { isUserMcpModelAccessEnabled } from "../../connectors/user-mcp-model-capability.ts";
import {
  getUserMcpConnector,
  USER_MCP_SERVICE_ID_PATTERN,
  userMcpToolSegmentOk,
} from "../../connectors/user-mcp-store.ts";
import { MCP_ACTION_CAPABILITY } from "../../mcp-sink/capture-capability.ts";
import { constantTimeStringEqual } from "../../util/timing-safe-compare.ts";
import { ConnectorRpcError } from "../connector-rpc-shared.ts";
import {
  type AgentWritesDeps,
  refuseAgentWrites,
  refuseScopeParams,
  requireAgentEnableCaller,
  requireOwnerApproval,
} from "./agent-writes.ts";

/** What the user-MCP enable needs beyond the shared agent-door deps. */
export interface UserMcpAgentWritesDeps extends AgentWritesDeps {
  /**
   * One registered user-MCP server's STRIPPED definitions (`description` and `inputSchema` per tool,
   * keys `<serviceId>_<tool>`), or `undefined`. It may START the sandboxed server.
   */
  readonly listUserMcpDefinitions?: (
    serviceId: string,
  ) => Promise<Readonly<Record<string, unknown>> | undefined>;
  /** The registration prompt's note on a reach the OS cannot limit host by host. */
  readonly userMcpNetworkNote?: (netHosts: readonly string[]) => string | undefined;
}

/** True when `service` names a user-registered MCP server (the only ids this module serves). */
export function isUserMcpServiceParam(service: unknown): service is string {
  return typeof service === "string" && USER_MCP_SERVICE_ID_PATTERN.test(service);
}

const MAX_APPROVE_NAMES = 200;
/**
 * The most tools the list-only mode (no `--approve`) hashes and returns. The listing comes from a
 * registered third-party server and is not bounded by anything else, so the cost of a list is. Names
 * are taken in sorted order; the rest are only counted (`omitted`). `--approve` looks each named tool
 * up directly in the listing, so a tool beyond this cap can still be approved by name.
 */
export const USER_MCP_LIST_TOOLS_MAX = 200;
/** The first characters of the server's description the prompt shows per tool. */
const PROMPT_DESCRIPTION_MAX = 200;

/** How one tool stands against the owner's current approval of it. */
export type UserMcpToolState = "will_be_approved" | "already_approved" | "reapproved_changed";

export interface UserMcpToolLine {
  toolId: string;
  state: UserMcpToolState;
  sha12: string;
  /** The server's own description, cut to {@link PROMPT_DESCRIPTION_MAX} characters. */
  description: string;
}

export interface UserMcpAgentEnableReply {
  service: string;
  door: "agent";
  /** True when no `--approve` was given: the tools were listed and nothing was asked or written. */
  listOnly: boolean;
  approved: number;
  writes: Array<{ toolId: string; sha12: string }>;
  /** Every tool the server lists now, with its hash prefix and state (list mode only). */
  tools?: Array<{ toolId: string; sha12: string; state: UserMcpToolState }>;
  /** Tools the server lists that cannot be approved (a name outside the allowed alphabet). */
  notApprovable?: string[];
  /** List mode only: how many listed tools were left out past {@link USER_MCP_LIST_TOOLS_MAX}. */
  omitted?: number;
}

function stateOf(existing: DoorApproval | undefined, sha: string): UserMcpToolState {
  if (existing === undefined) return "will_be_approved";
  return existing.suspendedAt === null && constantTimeStringEqual(existing.definitionSha256, sha)
    ? "already_approved"
    : "reapproved_changed";
}

/** Step 2: exact tool names only, de-duplicated in first-seen order; `undefined` when none were given. */
function parseApproveNames(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const bad = (): never =>
    refuseAgentWrites(
      "ERR_CONNECTOR_WRITES_BAD_APPROVE",
      "for a user MCP server --approve takes exact tool names (letters, digits, _ and -; no *)",
      -32602,
    );
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_APPROVE_NAMES) return bad();
  const seen = new Set<string>();
  for (const p of raw) {
    if (typeof p !== "string" || !userMcpToolSegmentOk(`x.${p}`) || p.includes(".")) return bad();
    seen.add(p);
  }
  return [...seen];
}

/** Step 4: `mcp_action` AND `user_mcp_model_access` are on in the LIVE policy (fail closed). */
function requireUserMcpAgentPolicy(deps: AgentWritesDeps): void {
  let enforced: ReturnType<AgentWritesDeps["getEnforcedPolicy"]>;
  try {
    enforced = deps.getEnforcedPolicy();
  } catch {
    enforced = undefined;
  }
  if (
    enforced === undefined ||
    enforced.capabilitiesDisabled.has(MCP_ACTION_CAPABILITY) ||
    !isUserMcpModelAccessEnabled(enforced)
  ) {
    refuseAgentWrites(
      "ERR_CONNECTOR_WRITES_POLICY",
      "org policy does not allow outside agents to use user MCP tools (needs mcp_action and user_mcp_model_access)",
    );
  }
}

function listedDescription(entry: unknown): string {
  const d =
    typeof entry === "object" && entry !== null
      ? (entry as { description?: unknown }).description
      : undefined;
  return typeof d === "string" ? d : "";
}

/** The first `max` code points of `s`, so a cut never splits a surrogate pair. */
function cutDescription(s: string, max: number): string {
  return s.length <= max ? s : Array.from(s).slice(0, max).join("");
}

/** Every tool the listing holds, by bare name (the server's own prefix removed), sorted. */
function listedToolNames(serviceId: string, listed: Readonly<Record<string, unknown>>): string[] {
  const prefix = `${serviceId}_`;
  return Object.keys(listed)
    .filter((k) => k.startsWith(prefix) && k.length > prefix.length)
    .map((k) => k.slice(prefix.length))
    .sort((a, b) => a.localeCompare(b));
}

export async function handleUserMcpAgentWritesEnable(
  rec: Record<string, unknown> | undefined,
  deps: UserMcpAgentWritesDeps,
): Promise<UserMcpAgentEnableReply> {
  // 1. The caller: a connection that declared `cli` or `ui`, and a gate to ask.
  const executor = requireAgentEnableCaller(deps);
  // 2. The arguments.
  const service = rec?.["service"];
  if (!isUserMcpServiceParam(service)) {
    throw new ConnectorRpcError(
      -32602,
      "ERR_CONNECTOR_WRITES_UNKNOWN_SERVICE: that is not a user MCP server id",
    );
  }
  if (rec?.["wave"] !== undefined) {
    refuseAgentWrites(
      "ERR_CONNECTOR_WRITES_AGENT_USER_MCP_WAVE",
      "a user MCP server has no waves; do not pass --wave",
      -32602,
    );
  }
  refuseScopeParams(rec);
  const names = parseApproveNames(rec?.["approve"]);
  // 3. The server is registered (and which registration the owner is about to be shown).
  const registration = getUserMcpConnector(deps.db, service);
  if (registration === null) {
    throw new ConnectorRpcError(
      -32602,
      "ERR_CONNECTOR_WRITES_UNKNOWN_SERVICE: that user MCP server is not registered",
    );
  }
  // 4. Policy, from the live resolved policy.
  requireUserMcpAgentPolicy(deps);
  // 5. The listing: the only I/O before the prompt. A failure is "cannot be listed", never a guess.
  const listed = await Promise.resolve()
    .then(() => deps.listUserMcpDefinitions?.(service))
    .catch(() => undefined);
  if (listed === undefined) {
    refuseAgentWrites(
      "ERR_CONNECTOR_WRITES_AGENT_UNLISTED",
      "that server could not be started or lists no tools",
    );
  }
  const existing = new Map(listDoorApprovals(deps.db, "agent", service).map((a) => [a.toolId, a]));
  const line = (tool: string): UserMcpToolLine | undefined => {
    const entry = listed[mcpClientToolKey(service, tool)];
    const sha = definitionSha256(tool, entry);
    if (sha === undefined) return undefined;
    return {
      toolId: tool,
      state: stateOf(existing.get(tool), sha),
      sha12: sha12(sha),
      description: cutDescription(listedDescription(entry), PROMPT_DESCRIPTION_MAX),
    };
  };
  // Without --approve: say what the server lists, with the hash prefixes, and ask nothing (OR-AD-23).
  if (names === undefined) {
    const tools: NonNullable<UserMcpAgentEnableReply["tools"]> = [];
    const notApprovable: string[] = [];
    const allNames = listedToolNames(service, listed);
    const omitted = Math.max(0, allNames.length - USER_MCP_LIST_TOOLS_MAX);
    for (const tool of allNames.slice(0, USER_MCP_LIST_TOOLS_MAX)) {
      const l = userMcpToolSegmentOk(`x.${tool}`) ? line(tool) : undefined;
      if (l === undefined) notApprovable.push(tool);
      else tools.push({ toolId: l.toolId, sha12: l.sha12, state: l.state });
    }
    return {
      service,
      door: "agent",
      listOnly: true,
      approved: 0,
      writes: [],
      tools,
      ...(notApprovable.length === 0 ? {} : { notApprovable }),
      ...(omitted === 0 ? {} : { omitted }),
    };
  }
  // 6. Each named tool is in the listing and hashes.
  const lines: UserMcpToolLine[] = [];
  for (const tool of names) {
    const l = Object.hasOwn(listed, mcpClientToolKey(service, tool)) ? line(tool) : undefined;
    if (l === undefined) {
      refuseAgentWrites(
        "ERR_CONNECTOR_WRITES_AGENT_NO_MATCH",
        `the server does not list a tool named ${tool} that can be approved now`,
      );
    }
    lines.push(l);
  }
  // 7. The owner's gate: the exact tools, hashes and reach they are about to approve.
  const payload: Record<string, unknown> = {
    door: "agent",
    userMcp: true,
    service,
    registeredAt: registration.created_at,
    readPaths: jsonStrings(registration.read_paths_json),
    netHosts: jsonStrings(registration.net_hosts_json),
    ...networkNoteOf(deps, jsonStrings(registration.net_hosts_json)),
    modelAccess: registration.model_access === 1,
    tools: lines,
  };
  await requireOwnerApproval(executor, payload, deps);
  // 8. ONE transaction. The owner may have removed or re-registered the server while the prompt was
  //    open, or org policy may have changed: approvals are written only for the registration they
  //    were shown and only while policy still allows them.
  const entries: DoorApprovalEntry[] = lines.map((l) => ({
    toolId: l.toolId,
    definitionSha256: fullHash(listed, service, l.toolId),
  }));
  const now = deps.now();
  deps.db.transaction(() => {
    // Policy may have changed during the listing or the owner's prompt: read it again, now.
    requireUserMcpAgentPolicy(deps);
    const current = getUserMcpConnector(deps.db, service);
    if (current === null || current.created_at !== registration.created_at) {
      refuseAgentWrites(
        "ERR_CONNECTOR_WRITES_AGENT_CHANGED",
        "the server was removed or registered again while you were deciding; nothing was enabled",
      );
    }
    upsertDoorApprovals(deps.db, "agent", service, entries, now);
  })();
  return {
    service,
    door: "agent",
    listOnly: false,
    approved: entries.length,
    writes: lines.map((l) => ({ toolId: l.toolId, sha12: l.sha12 })),
  };
}

/** The full hash of a tool already shown to the owner (it hashed at step 6, so it hashes now). */
function fullHash(
  listed: Readonly<Record<string, unknown>>,
  service: string,
  tool: string,
): string {
  const sha = definitionSha256(tool, listed[mcpClientToolKey(service, tool)]);
  if (sha === undefined) {
    refuseAgentWrites("ERR_CONNECTOR_WRITES_AGENT_NO_MATCH", `${tool} can no longer be hashed`);
  }
  return sha;
}

function jsonStrings(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function networkNoteOf(
  deps: UserMcpAgentWritesDeps,
  hosts: readonly string[],
): { networkNote?: string } {
  if (hosts.length === 0) return {};
  try {
    const note = deps.userMcpNetworkNote?.(hosts);
    return note === undefined ? {} : { networkNote: note };
  } catch {
    return {};
  }
}
