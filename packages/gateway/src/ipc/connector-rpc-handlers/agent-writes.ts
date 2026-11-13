// packages/gateway/src/ipc/connector-rpc-handlers/agent-writes.ts
// `connector.writesEnable|writesStatus` with `door: "agent"` (Phase 28 AD3a-1; spec 2026-11-13 § 7.3):
// the owner approves, BY NAME and with a hash of each tool's listed definition, the connector writes
// an outside agent may later propose. Nothing here is read by the agent door yet (AD3a-2): what an
// agent can propose is unchanged, and every reply says so (`AGENT_DOOR_NOT_ENFORCED_NOTICE`).
//
// This module never names the approval table (static D49(b)): every read and write goes through
// `connectors/connector-writes/door-approval-store.ts`.
import type { Database } from "bun:sqlite";

import {
  AGENT_DOOR_NOT_ENFORCED_NOTICE,
  type AgentApprovableRow,
  agentApprovableRows,
  agentDoorPolicyAllows,
} from "../../connectors/connector-writes/agent-door.ts";
import { definitionSha256 } from "../../connectors/connector-writes/definition-hash.ts";
import {
  type DoorApproval,
  type DoorApprovalEntry,
  getDoorApproval,
  listDoorApprovals,
  markDoorToolSuspended,
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
import { getK8sGrants } from "../../connectors/connector-writes/k8s-grants.ts";
import type {
  ConnectorWriteRow,
  ConnectorWriteWave,
} from "../../connectors/connector-writes/types.ts";
import { mcpClientToolKey } from "../../connectors/lazy-mesh/tool-map.ts";
import { appendAuditEntry } from "../../db/audit-chain.ts";
import type { ToolExecutor } from "../../engine/executor.ts";
import { APPROVER_BY_KIND } from "../../mcp-sink/capture-client-policy.ts";
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

/** Step 1: a gate to ask, and a connection that declared `cli` or `ui` (it says a person is there). */
function requireAgentEnableCaller(deps: AgentWritesDeps): ToolExecutor {
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

function sha12(sha: string): string {
  return sha.slice(0, 12);
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
  notice: string;
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
  const payload: Record<string, unknown> = {
    door: "agent",
    service,
    maxWave,
    ...(sharedFrom === undefined ? {} : { raisesSharedWaveFrom: sharedFrom }),
    writes,
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
    notice: AGENT_DOOR_NOT_ENFORCED_NOTICE,
  };
}

/** The shared wave's current value when this enable raises it, `null` when it creates the row. */
function sharedWaveBefore(db: Database, service: string, maxWave: ConnectorWriteWave) {
  const current = getModelWriteEnablement(db, service);
  if (current === undefined) return null;
  return current.maxWave < maxWave ? current.maxWave : undefined;
}

function refuseScopeParams(rec: Rec): void {
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

async function requireOwnerApproval(
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

export interface AgentSuspendedTool {
  toolId: string;
  approvedAt: number;
  approvedSha12: string;
  /** The hash observed when the listing first disagreed; `null` when there was none to hash. */
  nowSha12: string | null;
  reason?: string;
}

export interface AgentStatusService {
  service: string;
  approved: number;
  suspended: AgentSuspendedTool[];
  unverified?: string;
}

export interface AgentStatusReply {
  policyAllows: boolean;
  notice: string;
  /** Present only while no approval exists: the one command that makes one. */
  hint?: string;
  services: AgentStatusService[];
}

const NO_APPROVALS_HINT =
  "To approve connector writes for outside agents, run: nimbus connector writes enable <service> --door agent";
const GONE_REASON = "no longer listed";
const UNREADABLE_NOW_REASON = "its input schema can no longer be read";
const STORED_GONE_REASON = "no longer listed, or its input schema cannot be read";

function suspendedFromRow(a: DoorApproval): AgentSuspendedTool {
  return {
    toolId: a.toolId,
    approvedAt: a.approvedAt,
    approvedSha12: sha12(a.definitionSha256),
    nowSha12: a.suspendedSha256 === null ? null : sha12(a.suspendedSha256),
    ...(a.suspendedSha256 === null ? { reason: STORED_GONE_REASON } : {}),
  };
}

/** What a live listing says about one approved, not yet suspended tool: a mismatch, or `undefined`. */
function observe(
  a: DoorApproval,
  listed: Readonly<Record<string, unknown>>,
): { sha: string | null; reason?: string } | undefined {
  const key = mcpClientToolKey(a.service, a.toolId);
  if (!Object.hasOwn(listed, key)) return { sha: null, reason: GONE_REASON };
  const sha = definitionSha256(a.toolId, listed[key]);
  if (sha === undefined) return { sha: null, reason: UNREADABLE_NOW_REASON };
  return sha === a.definitionSha256 ? undefined : { sha };
}

/**
 * Mark the approval the listing was compared against, and write its one audit row, in ONE transaction:
 * either both commit or neither does (a failed append leaves the tool unmarked, so a later status
 * observes it again). `undefined` when the approval changed underneath (re-approved with another
 * hash or removed), which is not a suspension.
 */
function recordSuspension(
  deps: AgentWritesDeps,
  a: DoorApproval,
  seen: { sha: string | null; reason?: string },
): AgentSuspendedTool | undefined {
  const now = deps.now();
  const entry: AgentSuspendedTool = {
    toolId: a.toolId,
    approvedAt: a.approvedAt,
    approvedSha12: sha12(a.definitionSha256),
    nowSha12: seen.sha === null ? null : sha12(seen.sha),
    ...(seen.reason === undefined ? {} : { reason: seen.reason }),
  };
  // The first observation wins: a repeat marks nothing and writes no second audit row.
  const marked = deps.db.transaction(() => {
    if (
      !markDoorToolSuspended(
        deps.db,
        "agent",
        a.service,
        a.toolId,
        a.definitionSha256,
        seen.sha,
        now,
      )
    ) {
      return false;
    }
    appendAuditEntry(deps.db, {
      actionType: "connector.writes.agent.suspend",
      hitlStatus: "not_required",
      actionJson: JSON.stringify({
        service: a.service,
        toolId: a.toolId,
        approvedSha12: entry.approvedSha12,
        nowSha12: entry.nowSha12,
      }),
      timestamp: now,
    });
    return true;
  })();
  if (marked) return entry;
  // Not marked by this call: another observer suspended the same approval (report it from the stored
  // columns), or the owner re-approved or removed it since the snapshot (nothing to report).
  const current = getDoorApproval(deps.db, "agent", a.service, a.toolId);
  return current !== undefined &&
    current.suspendedAt !== null &&
    current.definitionSha256 === a.definitionSha256
    ? suspendedFromRow(current)
    : undefined;
}

async function statusOfService(
  deps: AgentWritesDeps,
  service: string,
  approvals: readonly DoorApproval[],
): Promise<AgentStatusService> {
  // Sequential on purpose: a listing may start the connector (the model door's reason, too).
  // A listing that fails is the same as one that is not there: unverified, nothing marked.
  const listed = await deps.listServerTools?.(service).catch(() => undefined);
  const suspended: AgentSuspendedTool[] = [];
  let unchanged = 0;
  for (const a of approvals) {
    if (a.suspendedAt !== null) {
      suspended.push(suspendedFromRow(a));
      continue;
    }
    const seen = listed === undefined ? undefined : observe(a, listed);
    if (seen === undefined) {
      unchanged++;
      continue;
    }
    const entry = recordSuspension(deps, a, seen);
    if (entry === undefined) unchanged++;
    else suspended.push(entry);
  }
  return {
    service,
    approved: unchanged,
    suspended,
    ...(listed === undefined ? { unverified: "its tools could not be listed" } : {}),
  };
}

/**
 * Per service that has an agent approval: re-derive each approved tool's hash from a live listing.
 * The one read that writes: a first mismatch is marked (sticky, narrows only) with one audit row.
 */
export async function handleAgentWritesStatus(deps: AgentWritesDeps): Promise<AgentStatusReply> {
  const all = listDoorApprovals(deps.db, "agent");
  const byService = new Map<string, DoorApproval[]>();
  for (const a of all) byService.set(a.service, [...(byService.get(a.service) ?? []), a]);
  const services: AgentStatusService[] = [];
  for (const [service, approvals] of byService) {
    services.push(await statusOfService(deps, service, approvals));
  }
  return {
    policyAllows: agentDoorPolicyAllows(deps.getEnforcedPolicy()),
    notice: AGENT_DOOR_NOT_ENFORCED_NOTICE,
    ...(all.length === 0 ? { hint: NO_APPROVALS_HINT } : {}),
    services,
  };
}
