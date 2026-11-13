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
import type { ActionBasis, ActionVerdict } from "../../mcp-sink/capture-types.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
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
    // Spec § 5.4 and I54: a Wave 4 write needs its current-state reader (and a bound write its
    // prepare tool) in the listing, as the model door requires before it offers the row.
    if (
      row.wave === 4 &&
      (beforeReaderMissing(row, service, listed) || prepareToolMissing(row, service, listed))
    ) {
      return refused("ERR_CAPTURE_ACTION_NOT_PROPOSABLE", DEFINITION_REFUSALS.support);
    }
    return { ok: true };
  };

  const acceptedTypes = async (): Promise<readonly string[]> => {
    const types = new Set<string>([
      ...rows.map((r) => r.actionType),
      ...Object.keys(PROPOSABLE_WRITE_TOOLS),
    ]);
    const out: string[] = [];
    const configured = new Map<string, boolean>();
    // Sequential on purpose: a configured-ness check is a Vault read (a `secret-tool` spawn on Linux).
    for (const type of [...types].sort((a, b) => a.localeCompare(b))) {
      if (verdict(type).kind !== "proposable") continue;
      const service = serviceOf(type);
      if (!configured.has(service)) {
        configured.set(service, await deps.isServiceConfigured(service)); // NOSONAR S9382: each check is a Vault read
      }
      if (configured.get(service) === true) out.push(type);
    }
    if (deps.classifyContext.userMcpModelAccessAllowed()) {
      for (const id of deps.classifyContext.modelAccessServices()) out.push(`${id}.*`);
    }
    return out.toSorted((a, b) => a.localeCompare(b)).slice(0, ACCEPTED_TYPES_MAX);
  };

  return { verdict, refusal, verifyDefinition, acceptedTypes };
}

function safeCount(read: () => number): number {
  try {
    return read();
  } catch {
    return 0;
  }
}
