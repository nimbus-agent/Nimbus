// packages/gateway/src/ipc/connector-rpc-handlers/agent-writes.ts
// `connector.writesEnable|writesStatus` with `door: "agent"` (Phase 28 AD3a-1; spec 2026-11-13 § 7.3):
// the owner approves, BY NAME and with a hash of each tool's listed definition, the connector writes
// an outside agent may propose (invariant I58). The agent door reads this list at submit, at
// approval and after the owner's answer (`connector-writes/agent-door-runtime.ts`).
//
// This module never names the approval table (static D49(b)): every read and write goes through
// `connectors/connector-writes/door-approval-store.ts`.
import type { Database } from "bun:sqlite";

import {
  type AgentApprovableRow,
  agentApprovableRows,
  agentDoorPolicyAllows,
} from "../../connectors/connector-writes/agent-door.ts";
import {
  checkAgentToolDefinition,
  type DoorSuspension,
  sha12,
  suspensionFromRow,
} from "../../connectors/connector-writes/agent-door-definition.ts";
import { LEGACY_LIST_HEADER } from "../../connectors/connector-writes/agent-door-legacy.ts";
import {
  type DoorApproval,
  type DoorApprovalEntry,
  listDoorApprovals,
  replaceDoorApprovals,
  upsertDoorApprovals,
} from "../../connectors/connector-writes/door-approval-store.ts";
import {
  getModelWriteEnablement,
  isObsidianWriteGrantApproved,
  modelWriteServices,
  raiseWriteEnablementWave,
} from "../../connectors/connector-writes/enablement-store.ts";
import { getIacGrants } from "../../connectors/connector-writes/iac-grants.ts";
import { CONNECTOR_WRITE_ROWS } from "../../connectors/connector-writes/index.ts";
import { getK8sGrants } from "../../connectors/connector-writes/k8s-grants.ts";
import { CONNECTOR_WRITE_MODEL_ACCESS_CAPABILITY } from "../../connectors/connector-writes/model-write-capability.ts";
import type {
  ConnectorWriteRow,
  ConnectorWriteWave,
} from "../../connectors/connector-writes/types.ts";
import { USER_MCP_MODEL_ACCESS_CAPABILITY } from "../../connectors/user-mcp-model-capability.ts";
import { USER_MCP_SERVICE_ID_PATTERN } from "../../connectors/user-mcp-store.ts";
import type { ToolExecutor } from "../../engine/executor.ts";
import { MCP_ACTION_CAPABILITY } from "../../mcp-sink/capture-capability.ts";
import { APPROVER_BY_KIND } from "../../mcp-sink/capture-client-policy.ts";
import { CaptureStore } from "../../mcp-sink/capture-store.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import { ConnectorRpcError } from "../connector-rpc-shared.ts";
import type { ClientKind } from "../server/client-kind.ts";

/** What the agent-door handlers need; `ModelWritesDeps` carries all of it (structurally). */
export interface AgentWritesDeps {
  readonly db: Database;
  readonly toolExecutor: ToolExecutor | undefined;
  /** LIVE resolved policy (I22); `undefined` means "cannot tell" and refuses. */
  readonly getEnforcedPolicy: () => Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined;
  readonly now: () => number;
  /** Test seam; production uses the write table. */
  readonly rows?: readonly ConnectorWriteRow[];
  readonly grantedScopes?: Readonly<Record<string, string | undefined>>;
  /** The connector's raw tool listing keyed `mcpClientToolKey(service, toolId)`. */
  readonly listServerTools?: (
    service: string,
  ) => Promise<Readonly<Record<string, unknown>> | undefined>;
  /** The connection's declared kind (`ctx.getClientKind`), never a param. */
  readonly clientKind?: ClientKind;
  /** True once the human-only consent wrapper turned a non-human approval into a decline. */
  readonly agentAnswerWasNonHuman?: () => boolean;
  /**
   * AD5a: one registered user-MCP server's STRIPPED definitions (keys `<serviceId>_<tool>`), or
   * `undefined`. It may START the sandboxed server, so it is called only by the enable (after the
   * caller, arguments, registration and policy steps) and by a live `status` for a connection that
   * declared `cli` or `ui`.
   */
  readonly listUserMcpDefinitions?: (
    serviceId: string,
  ) => Promise<Readonly<Record<string, unknown>> | undefined>;
  /** AD5a: the registration prompt's note on a reach the OS cannot limit host by host. */
  readonly userMcpNetworkNote?: (netHosts: readonly string[]) => string | undefined;
}

/** Fixed text of a decline whose answer did not come from a person. */
const NON_HUMAN_DECLINE =
  "the approval did not come from a person at a terminal (--yes, a script and an old client cannot approve); nothing was enabled";

/** The scope parameters of the model door's `enable iac|kubernetes`, which this door never takes. */
const SCOPE_PARAMS = ["workdirs", "clouds", "regions", "net", "k8sGrants"] as const;

const MAX_APPROVE_PATTERNS = 200;

type Rec = Record<string, unknown> | undefined;

/** The door a `connector.writes*` call names: absent and `"model"` are the model's, `"agent"` is ours. */
export function parseWriteDoor(raw: unknown): "model" | "agent" {
  if (raw === undefined || raw === "model") return "model";
  if (raw === "agent") return "agent";
  throw new ConnectorRpcError(-32602, "ERR_CONNECTOR_WRITES_BAD_DOOR: door must be model or agent");
}

function refuse(code: string, message: string, rpcCode = -32000): never {
  throw new ConnectorRpcError(rpcCode, `${code}: ${message}`);
}

/** {@link refuse} for the sibling user-MCP enable (`agent-writes-user-mcp.ts`). */
export function refuseAgentWrites(code: string, message: string, rpcCode = -32000): never {
  return refuse(code, message, rpcCode);
}

/** Step 1: a gate to ask, and a connection that declared `cli` or `ui` (it says a person is there). */
export function requireAgentEnableCaller(deps: AgentWritesDeps): ToolExecutor {
  if (deps.toolExecutor === undefined) {
    throw new ConnectorRpcError(-32603, "connector.writesEnable requires a toolExecutor");
  }
  if (!APPROVER_BY_KIND[deps.clientKind ?? "unknown"]) {
    refuse(
      "ERR_CONNECTOR_WRITES_AGENT_CLIENT",
      "approving writes for outside agents needs a terminal or desktop connection that declared itself",
    );
  }
  return deps.toolExecutor;
}

/** One approve pattern: an exact tool id, or a prefix ending in ONE trailing `*`. */
function parseApprovePatterns(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const bad = (): never =>
    refuse(
      "ERR_CONNECTOR_WRITES_BAD_APPROVE",
      "approve takes tool ids, or a prefix ending in one *",
      -32602,
    );
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_APPROVE_PATTERNS) return bad();
  for (const p of raw) {
    if (typeof p !== "string" || p === "" || p === "*") return bad();
    const stars = p.split("*").length - 1;
    if (stars > 1 || (stars === 1 && !p.endsWith("*"))) return bad();
  }
  return raw as string[];
}

function matchesPattern(toolId: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => (p.endsWith("*") ? toolId.startsWith(p.slice(0, -1)) : toolId === p));
}

type PromptState = "already_approved" | "will_be_approved" | "reapproved_changed";

function approvalState(existing: DoorApproval | undefined, sha: string): PromptState {
  if (existing === undefined) return "will_be_approved";
  return existing.suspendedAt === null && existing.definitionSha256 === sha
    ? "already_approved"
    : "reapproved_changed";
}

interface PromptWrite extends Record<string, unknown> {
  toolId: string;
  actionType: string;
  wave: ConnectorWriteWave;
  typedConfirm: boolean;
  bound: boolean;
  state: PromptState | "not_approvable";
  sha12?: string;
  reason?: string;
}

function promptWrite(
  r: AgentApprovableRow,
  existing: ReadonlyMap<string, DoorApproval>,
): PromptWrite {
  const base = {
    toolId: r.row.toolId,
    actionType: r.row.actionType,
    wave: r.row.wave,
    typedConfirm: r.row.confirm !== undefined,
    bound: r.row.bound !== undefined,
  };
  return r.state === "approvable"
    ? {
        ...base,
        state: approvalState(existing.get(r.row.toolId), r.definitionSha256),
        sha12: sha12(r.definitionSha256),
      }
    : { ...base, state: "not_approvable", reason: r.reason };
}

/** The facts the approvable-rows function reads: grants and the Obsidian model approval. */
function approvableContext(deps: AgentWritesDeps, listed: Readonly<Record<string, unknown>>) {
  return {
    ...(deps.rows === undefined ? {} : { rows: deps.rows }),
    listed,
    approvedWorkdirs: getIacGrants(deps.db).workdirs,
    approvedK8sPairs: getK8sGrants(deps.db),
    ...(deps.grantedScopes === undefined ? {} : { grantedScopes: deps.grantedScopes }),
    obsidianModelGrant: isObsidianWriteGrantApproved(deps.db),
  };
}

function parseWave(raw: unknown): ConnectorWriteWave {
  if (raw === undefined) return 3;
  if (raw === 2 || raw === 3 || raw === 4) return raw;
  throw new ConnectorRpcError(-32602, "ERR_CONNECTOR_WRITES_BAD_WAVE: wave must be 2, 3 or 4");
}

/** Which of the rows the owner is shown, and which of those are approved if they say yes. */
function selectRows(
  all: readonly AgentApprovableRow[],
  patterns: readonly string[] | undefined,
): { shown: readonly AgentApprovableRow[]; chosen: readonly AgentApprovableRow[] } {
  const approvable = all.filter((r) => r.state === "approvable");
  if (approvable.length === 0) {
    refuse(
      "ERR_CONNECTOR_WRITES_AGENT_NOTHING",
      "no write of this service can be approved for agents now",
    );
  }
  if (patterns === undefined) return { shown: all, chosen: approvable };
  const chosen = approvable.filter((r) => matchesPattern(r.row.toolId, patterns));
  if (chosen.length === 0) {
    refuse("ERR_CONNECTOR_WRITES_AGENT_NO_MATCH", "no approvable write matches --approve");
  }
  return { shown: all.filter((r) => matchesPattern(r.row.toolId, patterns)), chosen };
}

export interface AgentEnableReply {
  service: string;
  door: "agent";
  maxWave: ConnectorWriteWave;
  approved: number;
  writes: Array<{ toolId: string; sha12: string }>;
  /** Tool ids a replacing enable deleted (AD3a-2a); empty for an enable that only adds. */
  removed: string[];
}

/**
 * In a fixed order, each step before the next: the caller, the arguments, policy, the connector's
 * listing (the only I/O before the prompt), the rows, the owner's gate, then ONE transaction.
 */
export async function handleAgentWritesEnable(
  rec: Rec,
  deps: AgentWritesDeps,
): Promise<AgentEnableReply> {
  const executor = requireAgentEnableCaller(deps);
  const maxWave = parseWave(rec?.["wave"]);
  const service = requireEligibleService(rec?.["service"], deps.rows);
  refuseScopeParams(rec);
  const patterns = parseApprovePatterns(rec?.["approve"]);
  requireAgentPolicy(deps);
  const listed = await deps.listServerTools?.(service);
  if (listed === undefined) {
    refuse(
      "ERR_CONNECTOR_WRITES_AGENT_UNLISTED",
      "that connector is not configured or lists no tools; connect it first",
    );
  }
  const all = agentApprovableRows(service, maxWave, approvableContext(deps, listed));
  const { shown, chosen } = selectRows(all, patterns);
  const existing = new Map(listDoorApprovals(deps.db, "agent", service).map((a) => [a.toolId, a]));
  const writes = shown.map((r) => promptWrite(r, existing));
  const sharedFrom = sharedWaveBefore(deps.db, service, maxWave);
  // A replace (no --approve) deletes every earlier approval it does not carry over: say so.
  const removes =
    patterns === undefined ? removalsOf(existing, chosen, all, maxWave, deps.rows) : [];
  const payload: Record<string, unknown> = {
    door: "agent",
    service,
    maxWave,
    ...(sharedFrom === undefined ? {} : { raisesSharedWaveFrom: sharedFrom }),
    writes,
    ...(removes.length === 0 ? {} : { removes }),
  };
  await requireOwnerApproval(executor, payload, deps);
  const entries: DoorApprovalEntry[] = chosen.flatMap((r) =>
    r.state === "approvable"
      ? [{ toolId: r.row.toolId, definitionSha256: r.definitionSha256 }]
      : [],
  );
  const now = deps.now();
  deps.db.transaction(() => {
    raiseWriteEnablementWave(deps.db, service, maxWave, now);
    if (patterns === undefined) replaceDoorApprovals(deps.db, "agent", service, entries, now);
    else upsertDoorApprovals(deps.db, "agent", service, entries, now);
  })();
  return {
    service,
    door: "agent",
    maxWave: getModelWriteEnablement(deps.db, service)?.maxWave ?? maxWave,
    approved: entries.length,
    writes: entries.map((e) => ({ toolId: e.toolId, sha12: sha12(e.definitionSha256) })),
    removed: removes.map((x) => x.toolId),
  };
}

/** One approval a replacing enable would delete, with the fixed reason it goes. */
interface Removal {
  toolId: string;
  wave: number;
  why: "above_wave" | "not_approvable" | "gone";
  reason?: string;
}

function removalsOf(
  existing: ReadonlyMap<string, DoorApproval>,
  chosen: readonly AgentApprovableRow[],
  all: readonly AgentApprovableRow[],
  maxWave: ConnectorWriteWave,
  rows: readonly ConnectorWriteRow[] | undefined,
): Removal[] {
  const kept = new Set(chosen.map((r) => r.row.toolId));
  const out: Removal[] = [];
  for (const toolId of [...existing.keys()].sort((a, b) => a.localeCompare(b))) {
    if (kept.has(toolId)) continue;
    const known = all.find((r) => r.row.toolId === toolId);
    const row = known?.row ?? (rows ?? CONNECTOR_WRITE_ROWS).find((r) => r.toolId === toolId);
    if (row === undefined) {
      out.push({ toolId, wave: 0, why: "gone" });
    } else if (row.wave > maxWave) {
      out.push({ toolId, wave: row.wave, why: "above_wave" });
    } else if (known?.state === "not_approvable") {
      out.push({ toolId, wave: row.wave, why: "not_approvable", reason: known.reason });
    } else {
      out.push({ toolId, wave: row.wave, why: "gone" });
    }
  }
  return out;
}

/** The shared wave's current value when this enable raises it, `null` when it creates the row. */
function sharedWaveBefore(db: Database, service: string, maxWave: ConnectorWriteWave) {
  const current = getModelWriteEnablement(db, service);
  if (current === undefined) return null;
  return current.maxWave < maxWave ? current.maxWave : undefined;
}

export function refuseScopeParams(rec: Rec): void {
  if (SCOPE_PARAMS.some((k) => rec?.[k] !== undefined)) {
    refuse(
      "ERR_CONNECTOR_WRITES_AGENT_SCOPE",
      "--door agent takes no directory, cloud or namespace; it reads the ones you approved for the model",
      -32602,
    );
  }
}

function requireAgentPolicy(deps: AgentWritesDeps): void {
  if (!agentDoorPolicyAllows(deps.getEnforcedPolicy())) {
    refuse(
      "ERR_CONNECTOR_WRITES_POLICY",
      "org policy does not allow agent connector writes (needs connector_write_model_access and mcp_action)",
    );
  }
}

export async function requireOwnerApproval(
  executor: ToolExecutor,
  payload: Record<string, unknown>,
  deps: AgentWritesDeps,
): Promise<void> {
  const gate = await executor.gate({ type: "connector.writes.enable", payload });
  if (gate === "proceed") return;
  const why = deps.agentAnswerWasNonHuman?.() === true ? NON_HUMAN_DECLINE : "nothing was enabled";
  refuse("ERR_CONNECTOR_WRITES_DECLINED", why);
}

function requireEligibleService(raw: unknown, rows: readonly ConnectorWriteRow[] | undefined) {
  if (typeof raw !== "string" || !modelWriteServices(rows).includes(raw)) {
    throw new ConnectorRpcError(
      -32602,
      "ERR_CONNECTOR_WRITES_UNKNOWN_SERVICE: that service has no connector writes",
    );
  }
  return raw;
}

// ---- status -----------------------------------------------------------------------------------

/** One suspended tool, as `connector.writesStatus` reports it (the definition module's type). */
export type AgentSuspendedTool = DoorSuspension;

export interface AgentStatusService {
  service: string;
  /** AD5a: true for a user-registered MCP server (`mcp_<id>`); absent for a first-party connector. */
  userMcp?: true;
  approved: number;
  suspended: AgentSuspendedTool[];
  /**
   * Approved tools the live listing omits (OR-AD-14): refused while missing, NOT suspended, no
   * audit row; they work again when the connector lists them with the approved definition.
   */
  notListed?: string[];
  unverified?: string;
}

/** Proposals accepted under the deprecation window in the last 30 days (D-7); `null` when none. */
export interface AgentLegacyReport {
  sinceMs: number;
  total: number;
  byType: Record<string, number>;
  notice: string;
}

export interface AgentStatusReply {
  policyAllows: boolean;
  /** False when the connection did not declare cli or ui: the stored view, no listing, no mark. */
  checked: boolean;
  /** Which of the two capabilities the door needs the organisation's policy has turned off (OR-AD-15). */
  lockedOff: string[];
  legacy: AgentLegacyReport | null;
  /** Present only while no approval exists: the one command that makes one. */
  hint?: string;
  services: AgentStatusService[];
}

const NO_APPROVALS_HINT =
  "To approve connector writes for outside agents, run: nimbus connector writes enable <service> --door agent";
async function statusOfService(
  deps: AgentWritesDeps,
  service: string,
  approvals: readonly DoorApproval[],
  live: boolean,
): Promise<AgentStatusService> {
  // Sequential on purpose: a listing may start the connector (the model door's reason, too).
  // A listing that fails is the same as one that is not there: unverified, nothing marked.
  // A user MCP server is listed by its own lister (AD5a): the first-party one refuses a service with
  // no write row. Either way the check below is the same shared helper.
  const userMcp = USER_MCP_SERVICE_ID_PATTERN.test(service);
  const lister = userMcp ? deps.listUserMcpDefinitions : deps.listServerTools;
  const listed = live
    ? await Promise.resolve()
        .then(() => lister?.(service))
        .catch(() => undefined)
    : undefined;
  const suspended: AgentSuspendedTool[] = [];
  const notListed: string[] = [];
  let unchanged = 0;
  for (const a of approvals) {
    if (a.suspendedAt !== null) {
      suspended.push(suspensionFromRow(a));
      continue;
    }
    if (listed === undefined) {
      unchanged++;
      continue;
    }
    // The ONE mark-and-audit helper (`agent-door-definition.ts`), shared with the submit, approval
    // and veto paths: a first mismatch is marked sticky with one audit row.
    const check = checkAgentToolDefinition(deps, a, listed);
    if (check.kind === "changed" || check.kind === "unreadable") {
      if (check.suspension === undefined) unchanged++;
      else suspended.push(check.suspension);
      continue;
    }
    if (check.kind === "missing") notListed.push(a.toolId);
    unchanged++;
  }
  return {
    service,
    ...(userMcp ? { userMcp: true as const } : {}),
    approved: unchanged,
    suspended,
    ...(notListed.length === 0 ? {} : { notListed }),
    ...(live && listed === undefined ? { unverified: "its tools could not be listed" } : {}),
  };
}

/** The capabilities of the two the agent door needs that the resolved policy has disabled. */
function lockedOffOf(enforced: Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined): string[] {
  if (enforced === undefined) return [];
  return [
    CONNECTOR_WRITE_MODEL_ACCESS_CAPABILITY,
    MCP_ACTION_CAPABILITY,
    USER_MCP_MODEL_ACCESS_CAPABILITY,
  ].filter((c) => enforced.capabilitiesDisabled.has(c));
}

/** The window `status` counts legacy proposals over. */
export const LEGACY_WINDOW_MS = 30 * 24 * 3_600_000;

function legacyReport(deps: AgentWritesDeps): AgentLegacyReport | null {
  const sinceMs = deps.now() - LEGACY_WINDOW_MS;
  const { total, byType } = new CaptureStore(deps.db).legacyActionTypesSince(sinceMs);
  if (total === 0) return null;
  return { sinceMs, total, byType: { ...byType }, notice: LEGACY_LIST_HEADER };
}

/**
 * Per service that has an agent approval: re-derive each approved tool's hash from a live listing.
 * The one read that writes: a first mismatch is marked (sticky, narrows only) with one audit row.
 */
export async function handleAgentWritesStatus(deps: AgentWritesDeps): Promise<AgentStatusReply> {
  const all = listDoorApprovals(deps.db, "agent");
  const byService = new Map<string, DoorApproval[]>();
  for (const a of all) byService.set(a.service, [...(byService.get(a.service) ?? []), a]);
  // The live check lists connectors and writes the sticky mark, so it runs only for a connection
  // that declared cli or ui (R-5); any other kind gets the stored view.
  const live = APPROVER_BY_KIND[deps.clientKind ?? "unknown"];
  const services: AgentStatusService[] = [];
  for (const [service, approvals] of byService) {
    services.push(await statusOfService(deps, service, approvals, live)); // NOSONAR S9382: sequential listings
  }
  return {
    policyAllows: agentDoorPolicyAllows(deps.getEnforcedPolicy()),
    checked: live,
    lockedOff: lockedOffOf(deps.getEnforcedPolicy()),
    legacy: legacyReport(deps),
    ...(all.length === 0 ? { hint: NO_APPROVALS_HINT } : {}),
    services,
  };
}
