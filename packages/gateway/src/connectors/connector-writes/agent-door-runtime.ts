// packages/gateway/src/connectors/connector-writes/agent-door-runtime.ts
// The agent door's runtime (Phase 28 AD3a-2a, D-2; invariant I58): the functions the MCP capture
// gate and the act wiring are given, built over live reads. `createAgentDoor` is the ONLY place the
// legacy proposability table (`ACTION_PROPOSABILITY`, `PROPOSABLE_WRITE_TOOLS`) is consulted for a
// first-party type (static D49(a)); `mcp-sink/` cannot import `connectors/` (D32(f)), so the gate
// receives these functions by injection.
//
// EVERY function reads its facts at the call: the shared enablement (V83), the door approval (V97),
// the Terraform directories (V85), the Kubernetes pairs (V86), the Obsidian model approval, the
// credential scopes and the LIVE resolved policy. Nothing is cached, so a change of any of them
// between a submit and an approval is seen by the approval.
//
// `verdict` is synchronous and does no connector I/O. It decides, in this order:
//   1. a user-MCP type: `classifyActionType`, unchanged, with no basis and the `userMcp` marker;
//   2. no row: the legacy table's answer, unchanged (a type no row routes to is never `approved`);
//   3. the tool's approval is SUSPENDED: `suspended` (never a legacy case, D-AD-15);
//   4. `agentOffered`: `proposable` with basis `approved` (and `boundInput` for a bound row);
//   5. a type the legacy table accepts: `proposable` with a legacy basis (the deprecation window,
//      OR-AD-9; the seven mail sends carry their own basis);
//   6. otherwise `denied` with a fixed class that says which condition failed.
import type { Database } from "bun:sqlite";

import { serviceOf } from "../../engine/service-of.ts";
import type {
  ActionBasis,
  ActionDescription,
  ActionVerdict,
} from "../../mcp-sink/capture-types.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import {
  type ClassifyContext,
  classifyActionType,
  PROPOSABLE_WRITE_TOOLS,
  proposableWriteTool,
} from "../proposable-actions.ts";
import { USER_MCP_SERVICE_ID_PATTERN } from "../user-mcp-store.ts";
import {
  AGENT_DOOR_MAIL_SEND_TOOL_IDS,
  type AgentOfferFacts,
  agentDoorPolicyAllows,
  agentDoorRow,
  agentOffered,
} from "./agent-door.ts";
import { checkAgentToolDefinition } from "./agent-door-definition.ts";
import { type DescribeScope, describeApprovedWrite } from "./agent-door-describe.ts";
import { legacyNoticeFor } from "./agent-door-legacy.ts";
import { getDoorApproval } from "./door-approval-store.ts";
import {
  getModelWriteEnablement,
  isObsidianWriteGrantApproved,
  OBSIDIAN_APPEND_TOOL_ID,
} from "./enablement-store.ts";
import { getIacGrants } from "./iac-grants.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { getK8sGrants } from "./k8s-grants.ts";
import { beforeReaderMissing, prepareToolMissing } from "./listed-support.ts";
import { isModelOfferableRow, MODEL_NEVER_OFFERED_TOOL_IDS } from "./model-offerable.ts";
import {
  actDoorRefusal,
  CHATOPS_CHANNEL_REFUSAL,
  isChatopsDestinationRow,
  modelWriteRefusal,
  type TribalKbConfig,
} from "./model-write-refusals.ts";
import { scopeAvailable } from "./model-write-source.ts";
import { scopeGatedReason } from "./scope-gated.ts";
import type { ConnectorWriteRow } from "./types.ts";

/** The most types `capture.status` advertises. */
const ACCEPTED_TYPES_MAX = 200;

/** What the runtime reads; every member is read at the call. */
export interface AgentDoorDeps {
  readonly db: Database;
  /** The LIVE resolved policy (I22); `undefined`, or a throw, is "cannot tell" and refuses. */
  readonly enforcedPolicy: () => EnforcedPolicy | undefined;
  /** One first-party server's raw listing, or `undefined` (late-bound to the mesh in production). */
  readonly listServerTools: (
    service: string,
  ) => Promise<Readonly<Record<string, unknown>> | undefined>;
  /** The `[tribal]` KB destinations, read per call; a throw refuses a KB-capable row. */
  readonly tribalKbConfig: () => TribalKbConfig | undefined;
  /** What `classifyActionType` needs for a user-MCP type. */
  readonly classifyContext: ClassifyContext;
  readonly isServiceConfigured: (service: string) => Promise<boolean>;
  readonly now: () => number;
  /** Credential scopes per service, for the scope-gated writes; absent makes no claim. */
  readonly grantedScopes?: () => Readonly<Record<string, string | undefined>> | undefined;
  /** Test seam; production uses the write table. */
  readonly rows?: readonly ConnectorWriteRow[];
}

/** The answer of {@link AgentDoor.verifyDefinition}: the shape the capture gate is injected with. */
export type DefinitionVerification =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "ERR_AGENT_TOOL_SUSPENDED" | "ERR_CAPTURE_ACTION_NOT_PROPOSABLE";
      readonly detail: string;
    };

export interface AgentDoor {
  /** Synchronous, database reads only: never lists a connector. */
  verdict(actionType: string): ActionVerdict;
  /** The destination refusal for the basis the verdict gave (`undefined` allows; a throw refuses). */
  refusal(
    actionType: string,
    input: Readonly<Record<string, unknown>>,
    basis: ActionBasis | undefined,
  ): string | undefined;
  /** Lists the action's service once and checks the approved tool's definition against it. */
  verifyDefinition(actionType: string): Promise<DefinitionVerification>;
  /** The types `capture.status` advertises now: approved and legacy, configured, sorted. */
  acceptedTypes(): Promise<readonly string[]>;
  /**
   * What `capture.describe` returns (AD3a-2b). `undefined`: the summary, from database and Vault
   * reads only, never a listing. Named types: one entry each, in order; an approved type is listed
   * (its service once per call) and described only after the SAME post-listing check
   * `verifyDefinition` runs, so a described type has passed, in this call, what a submit checks.
   */
  describe(actionTypes: readonly string[] | undefined): Promise<readonly ActionDescription[]>;
}

/** The fixed texts of a refused definition check; none echoes a stored or listed value. */
export const DEFINITION_REFUSALS = Object.freeze({
  suspended:
    "this write's definition changed since the owner approved it for agents; it stays refused until the owner approves it again by name",
  changing: "this write's approval changed while it was being checked; try again",
  unlisted: "the connector for this write could not be listed now",
  notListed: "the connector does not list this write now",
  drifted: "the connector's schema for this write no longer matches what the owner was shown",
  support: "the connector does not list what this write needs to show the owner its current state",
  notApproved: "this write is not approved for agents",
});

/** The fixed text of a type `capture.describe` does not describe (OR-AD-17). */
export const DESCRIBE_USER_MCP_REASON =
  "tools of servers you registered are not described here yet; read them from that server";

/** The class of a `denied` verdict, one fixed string per condition (R-9: it says which one failed). */
export const AGENT_DENIED_CLASSES = Object.freeze({
  neverOffered: "agent_never_offered",
  notOfferable: "agent_not_offerable",
  policy: "agent_policy",
  notEnabled: "agent_not_enabled",
  wave: "agent_wave",
  notApproved: "agent_not_approved",
  noScope: "agent_no_scope",
  unroutable: "agent_unroutable",
});

function isUserMcpType(actionType: string): boolean {
  return USER_MCP_SERVICE_ID_PATTERN.test(serviceOf(actionType));
}

export function createAgentDoor(deps: AgentDoorDeps): AgentDoor {
  const rows = deps.rows ?? CONNECTOR_WRITE_ROWS;

  const livePolicy = (): EnforcedPolicy | undefined => {
    try {
      return deps.enforcedPolicy();
    } catch {
      return undefined;
    }
  };

  const grantedScopes = (): Readonly<Record<string, string | undefined>> | undefined => {
    try {
      return deps.grantedScopes?.();
    } catch {
      return undefined;
    }
  };

  const factsOf = (row: ConnectorWriteRow): AgentOfferFacts => {
    const service = serviceOf(row.actionType);
    const scopes = grantedScopes();
    return {
      enablement: getModelWriteEnablement(deps.db, service),
      approval: getDoorApproval(deps.db, "agent", service, row.toolId),
      enforced: livePolicy(),
      hasWorkdir: safeCount(() => getIacGrants(deps.db).workdirs.length) > 0,
      hasK8sPair: safeCount(() => getK8sGrants(deps.db).length) > 0,
      obsidianModelGrant: isObsidianWriteGrantApproved(deps.db),
      ...(scopes === undefined ? {} : { grantedScopes: scopes }),
      rows,
    };
  };

  const legacyClassification = (actionType: string): ActionVerdict =>
    classifyActionType(actionType, deps.classifyContext);

  /** Why a row the legacy table does not accept is refused: the first failing condition. */
  const deniedClassFor = (row: ConnectorWriteRow, facts: AgentOfferFacts): string => {
    if (MODEL_NEVER_OFFERED_TOOL_IDS.has(row.toolId)) return AGENT_DENIED_CLASSES.neverOffered;
    if (!isModelOfferableRow(row)) return AGENT_DENIED_CLASSES.notOfferable;
    if (!agentDoorPolicyAllows(facts.enforced)) return AGENT_DENIED_CLASSES.policy;
    const e = facts.enablement;
    if (e === undefined) return AGENT_DENIED_CLASSES.notEnabled;
    if (row.wave > e.maxWave) return AGENT_DENIED_CLASSES.wave;
    if (facts.approval === undefined) return AGENT_DENIED_CLASSES.notApproved;
    if (
      !scopeAvailable(row, facts.hasWorkdir, facts.hasK8sPair) ||
      scopeGatedReason(row.toolId, facts.grantedScopes) !== undefined ||
      (row.toolId === OBSIDIAN_APPEND_TOOL_ID && !facts.obsidianModelGrant)
    ) {
      return AGENT_DENIED_CLASSES.noScope;
    }
    return AGENT_DENIED_CLASSES.unroutable;
  };

  const verdict = (actionType: string): ActionVerdict => {
    // 1. A user-MCP type: the legacy classifier, unchanged, no basis. A proposable one carries the
    //    explicit marker the gate requires of a basis-less verdict (it refuses any other).
    if (isUserMcpType(actionType)) {
      const classified = legacyClassification(actionType);
      return classified.kind === "proposable" ? { ...classified, userMcp: true } : classified;
    }
    // 2. No row routes to the type: the legacy table's own answer (never `approved`).
    const row = agentDoorRow(actionType, rows);
    if (row === undefined) {
      const named = rows.some((r) => r.actionType === actionType);
      if (named) return { kind: "denied", class: AGENT_DENIED_CLASSES.unroutable };
      const legacy = legacyClassification(actionType);
      return legacy.kind === "proposable"
        ? { kind: "proposable", basis: "legacy_unapproved" }
        : legacy;
    }
    const facts = factsOf(row);
    // 3. A suspended approval is a suspension, never a legacy case (D-AD-15).
    if (facts.approval !== undefined && facts.approval.suspendedAt !== null) {
      return { kind: "suspended" };
    }
    // 4. The owner approved it for agents by name and every condition holds.
    // Only a bound row (a commit, an apply) may queue a payload over the ordinary cap.
    if (agentOffered(row, facts)) {
      return row.bound === undefined
        ? { kind: "proposable", basis: "approved" }
        : { kind: "proposable", basis: "approved", boundInput: true };
    }
    // 5. The deprecation window: a type the earlier act door accepted (OR-AD-9, OR-AD-15).
    const legacy = legacyClassification(actionType);
    if (legacy.kind === "proposable") {
      return {
        kind: "proposable",
        basis: AGENT_DOOR_MAIL_SEND_TOOL_IDS.has(row.toolId)
          ? "legacy_mail_send"
          : "legacy_unapproved",
      };
    }
    // 6. Refused, with the condition that failed.
    return { kind: "denied", class: deniedClassFor(row, facts) };
  };

  const refusal = (
    actionType: string,
    input: Readonly<Record<string, unknown>>,
    basis: ActionBasis | undefined,
  ): string | undefined => {
    if (basis === undefined) return undefined;
    if (basis === "approved") return approvedRefusal(actionType, input);
    return legacyRefusal(actionType, input);
  };

  // The model door's check, with the same live ChatOps bindings and KB config (the shape of
  // `model-write-source.ts` `refusal`). A KB accessor that throws propagates: the gate refuses.
  const approvedRefusal = (
    actionType: string,
    input: Readonly<Record<string, unknown>>,
  ): string | undefined => {
    const row = agentDoorRow(actionType, rows);
    if (row === undefined) return DEFINITION_REFUSALS.notApproved;
    let chatops: EnforcedPolicy["chatops"] | undefined;
    try {
      chatops = deps.enforcedPolicy()?.chatops;
    } catch (err) {
      if (isChatopsDestinationRow(row.toolId)) return CHATOPS_CHANNEL_REFUSAL;
      throw err;
    }
    return modelWriteRefusal(row.toolId, input, { chatops, kb: deps.tribalKbConfig() });
  };

  // The act door's refusal exactly as it ran before AD3a-2a (`createActionDestinationRefusal`): the
  // routing table's tool, a policy or KB accessor that throws read as "cannot tell".
  const legacyRefusal = (
    actionType: string,
    input: Readonly<Record<string, unknown>>,
  ): string | undefined => {
    const tool = proposableWriteTool(actionType);
    if (tool === undefined) return undefined;
    let chatops: EnforcedPolicy["chatops"] | undefined;
    try {
      chatops = deps.enforcedPolicy()?.chatops;
    } catch {
      chatops = undefined;
    }
    let kb: TribalKbConfig | undefined;
    let kbUnreadable = false;
    try {
      kb = deps.tribalKbConfig();
    } catch {
      kbUnreadable = true;
    }
    return actDoorRefusal(tool, input, { chatops, kb, kbUnreadable });
  };

  const refused = (
    code: "ERR_AGENT_TOOL_SUSPENDED" | "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
    detail: string,
  ): DefinitionVerification => ({ ok: false, code, detail });

  const verifyDefinition = async (actionType: string): Promise<DefinitionVerification> => {
    const row = agentDoorRow(actionType, rows);
    const service = serviceOf(actionType);
    const approval =
      row === undefined ? undefined : getDoorApproval(deps.db, "agent", service, row.toolId);
    if (row === undefined || approval === undefined) {
      return refused("ERR_CAPTURE_ACTION_NOT_PROPOSABLE", DEFINITION_REFUSALS.notApproved);
    }
    if (approval.suspendedAt !== null) {
      return refused("ERR_AGENT_TOOL_SUSPENDED", DEFINITION_REFUSALS.suspended);
    }
    // One listing for the service, and the LAST thing a submit does (every other refusal is free of
    // connector I/O). A listing that fails marks nothing.
    const listed = await deps.listServerTools(service).catch(() => undefined);
    return verifyListed(row, service, listed);
  };

  // The post-listing half of the definition check, shared by a submit (`verifyDefinition`) and a
  // describe: one function, so a described type has passed exactly what a submit checks. It has NO
  // await inside, so the re-read of the approval and the comparison cannot be separated.
  const verifyListed = (
    row: ConnectorWriteRow,
    service: string,
    listed: Readonly<Record<string, unknown>> | undefined,
  ): DefinitionVerification => {
    if (listed === undefined) {
      return refused("ERR_CAPTURE_ACTION_NOT_PROPOSABLE", DEFINITION_REFUSALS.unlisted);
    }
    // The listing awaited: the owner may have removed, suspended or re-approved the tool meanwhile
    // (and this is also the post-answer recheck). Re-read the store, with no await between that read
    // and the comparison, and judge the listing against the row as it stands now.
    const fresh = getDoorApproval(deps.db, "agent", service, row.toolId);
    if (fresh === undefined) {
      return refused("ERR_CAPTURE_ACTION_NOT_PROPOSABLE", DEFINITION_REFUSALS.notApproved);
    }
    if (fresh.suspendedAt !== null) {
      return refused("ERR_AGENT_TOOL_SUSPENDED", DEFINITION_REFUSALS.suspended);
    }
    const check = checkAgentToolDefinition(deps, fresh, listed, row);
    switch (check.kind) {
      case "changed":
      case "unreadable":
        return check.suspension === undefined
          ? refused("ERR_CAPTURE_ACTION_NOT_PROPOSABLE", DEFINITION_REFUSALS.changing)
          : refused("ERR_AGENT_TOOL_SUSPENDED", DEFINITION_REFUSALS.suspended);
      case "missing":
        return refused("ERR_CAPTURE_ACTION_NOT_PROPOSABLE", DEFINITION_REFUSALS.notListed);
      case "drifted":
        return refused("ERR_CAPTURE_ACTION_NOT_PROPOSABLE", DEFINITION_REFUSALS.drifted);
      case "ok":
        break;
    }
    // Spec 5.4 and I54: a Wave 4 write needs its current-state reader (and a bound write its
    // prepare tool) in the listing, as the model door requires before it offers the row.
    if (
      row.wave === 4 &&
      (beforeReaderMissing(row, service, listed) || prepareToolMissing(row, service, listed))
    ) {
      return refused("ERR_CAPTURE_ACTION_NOT_PROPOSABLE", DEFINITION_REFUSALS.support);
    }
    return { ok: true };
  };

  /**
   * Every first-party type of a configured service whose verdict is `proposable` or `suspended`,
   * sorted. Sequential on purpose: a configured-ness check is a Vault read (a `secret-tool` spawn
   * on Linux).
   */
  const configuredTypes = async (): Promise<
    readonly { readonly type: string; readonly verdict: ActionVerdict }[]
  > => {
    const types = new Set<string>([
      ...rows.map((r) => r.actionType),
      ...Object.keys(PROPOSABLE_WRITE_TOOLS),
    ]);
    const out: { type: string; verdict: ActionVerdict }[] = [];
    const configured = new Map<string, boolean>();
    for (const type of [...types].sort((a, b) => a.localeCompare(b))) {
      const v = verdict(type);
      if (v.kind !== "proposable" && v.kind !== "suspended") continue;
      const service = serviceOf(type);
      if (!configured.has(service)) {
        configured.set(service, await deps.isServiceConfigured(service)); // NOSONAR S9382: each check is a Vault read
      }
      if (configured.get(service) === true) out.push({ type, verdict: v });
    }
    return out;
  };

  const userMcpPatterns = (): readonly string[] =>
    deps.classifyContext.userMcpModelAccessAllowed()
      ? [...deps.classifyContext.modelAccessServices()].map((id) => `${id}.*`)
      : [];

  const acceptedTypes = async (): Promise<readonly string[]> => {
    const out = (await configuredTypes())
      .filter((t) => t.verdict.kind === "proposable")
      .map((t) => t.type);
    out.push(...userMcpPatterns());
    return out.toSorted((a, b) => a.localeCompare(b)).slice(0, ACCEPTED_TYPES_MAX);
  };

  // ---- describe (AD3a-2b) ------------------------------------------------------------------------

  /** The approved Terraform directories and Kubernetes pairs, each read at the call; none on a throw. */
  const describeScope = (): DescribeScope => ({
    workdirs: safeList(() => getIacGrants(deps.db).workdirs),
    k8sPairs: safeList(() => getK8sGrants(deps.db)),
  });

  /** The summary line of an approved row: its wave, whether the owner types a confirmation, whether it is bound. */
  const approvedSummary = (
    type: string,
    row: ConnectorWriteRow,
  ): Extract<ActionDescription, { state: "approved" }> => ({
    actionType: type,
    state: "approved",
    wave: row.wave,
    typedConfirm: row.confirm !== undefined,
    bound: row.bound !== undefined,
  });

  /** A suspended or legacy type, or an approved one in the summary (no description, no schema). */
  const summaryEntry = (type: string, v: ActionVerdict): ActionDescription => {
    if (v.kind === "suspended") {
      return { actionType: type, state: "suspended", reason: DEFINITION_REFUSALS.suspended };
    }
    const row =
      v.kind === "proposable" && v.basis === "approved" ? agentDoorRow(type, rows) : undefined;
    return row === undefined
      ? { actionType: type, state: "legacy", deprecation: legacyNoticeFor(type) }
      : approvedSummary(type, row);
  };

  /** The summary: database and Vault reads only, never a listing. */
  const describeSummary = async (): Promise<readonly ActionDescription[]> => {
    const entries = (await configuredTypes()).map((t) => summaryEntry(t.type, t.verdict));
    for (const pattern of userMcpPatterns()) {
      entries.push({ actionType: pattern, state: "undescribed", reason: DESCRIBE_USER_MCP_REASON });
    }
    return entries
      .toSorted((a, b) => a.actionType.localeCompare(b.actionType))
      .slice(0, ACCEPTED_TYPES_MAX);
  };

  /** What one call has already learned: a service's configured-ness and its one listing. */
  interface DescribeCall {
    readonly configured: Map<string, boolean>;
    readonly listings: Map<string, Readonly<Record<string, unknown>> | undefined>;
  }

  const describeApproved = async (type: string, call: DescribeCall): Promise<ActionDescription> => {
    const row = agentDoorRow(type, rows);
    const service = serviceOf(type);
    const approval =
      row === undefined ? undefined : getDoorApproval(deps.db, "agent", service, row.toolId);
    if (row === undefined || approval === undefined) {
      return { actionType: type, state: "unavailable", reason: DEFINITION_REFUSALS.notApproved };
    }
    if (approval.suspendedAt !== null) {
      return { actionType: type, state: "suspended", reason: DEFINITION_REFUSALS.suspended };
    }
    if (!call.listings.has(service)) {
      call.listings.set(service, await deps.listServerTools(service).catch(() => undefined)); // NOSONAR S9382: one listing per service
    }
    const listed = call.listings.get(service);
    const verified = verifyListed(row, service, listed);
    if (!verified.ok) {
      return {
        actionType: type,
        state: verified.code === "ERR_AGENT_TOOL_SUSPENDED" ? "suspended" : "unavailable",
        reason: verified.detail,
      };
    }
    const entry = listed?.[mcpClientToolKey(service, row.toolId)];
    return { ...approvedSummary(type, row), ...describeApprovedWrite(row, entry, describeScope()) };
  };

  const describeOne = async (type: string, call: DescribeCall): Promise<ActionDescription> => {
    // 1. A user-registered server's tool: not described until AD5 (OR-AD-17); nothing is started.
    if (isUserMcpType(type)) {
      return { actionType: type, state: "undescribed", reason: DESCRIBE_USER_MCP_REASON };
    }
    // 2. The verdict, from database reads only.
    const v = verdict(type);
    if (v.kind === "suspended") return summaryEntry(type, v);
    if (v.kind !== "proposable") {
      const why = v.kind === "denied" ? v.class : "unknown action type";
      return { actionType: type, state: "not_proposable", reason: `cannot be proposed (${why})` };
    }
    // 3. The service is configured on this machine (the submit path's step 5b).
    const service = serviceOf(type);
    if (!call.configured.has(service)) {
      call.configured.set(service, await deps.isServiceConfigured(service)); // NOSONAR S9382: a Vault read per service
    }
    if (call.configured.get(service) !== true) {
      return {
        actionType: type,
        state: "unavailable",
        reason: `${service} is not configured on this machine`,
      };
    }
    // 4. The deprecation window: the fixed line, never a schema and never a listing (OR-AD-18).
    if (v.basis !== "approved") return summaryEntry(type, v);
    // 5. An approved type: listed once per service and judged by the submit path's own check.
    return describeApproved(type, call);
  };

  const describe = async (
    actionTypes: readonly string[] | undefined,
  ): Promise<readonly ActionDescription[]> => {
    if (actionTypes === undefined) return describeSummary();
    const call: DescribeCall = { configured: new Map(), listings: new Map() };
    const out: ActionDescription[] = [];
    // Sequential, in request order: one listing per service, and a stable reply order.
    for (const type of new Set(actionTypes)) out.push(await describeOne(type, call)); // NOSONAR S9382
    return out;
  };

  return { verdict, refusal, verifyDefinition, acceptedTypes, describe };
}

function safeList<T>(read: () => readonly T[]): readonly T[] {
  try {
    return read();
  } catch {
    return [];
  }
}

function safeCount(read: () => number): number {
  try {
    return read();
  } catch {
    return 0;
  }
}
