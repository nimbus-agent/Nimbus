// packages/gateway/src/ipc/connector-rpc-handlers/model-writes.ts
// `connector.writesEnable|writesDisable|writesStatus`: the owner's opt-in for model connector writes.
import { removeDoorApprovals } from "../../connectors/connector-writes/door-approval-store.ts";
import {
  getModelWriteEnablement,
  listModelWriteEnablement,
  modelWriteServices,
  OBSIDIAN_APPEND_TOOL_ID,
  offerableWritesEnabledBy,
  removeModelWriteEnablement,
  setModelWriteEnablement,
  writesEnabledBy,
} from "../../connectors/connector-writes/enablement-store.ts";
import {
  getIacGrants,
  type IacGrants,
  type IacPathDeps,
  removeIacGrants,
  setIacGrants,
} from "../../connectors/connector-writes/iac-grants.ts";
import {
  getK8sGrants,
  type K8sGrant,
  removeK8sGrants,
  setK8sGrants,
} from "../../connectors/connector-writes/k8s-grants.ts";
import type { KubeFs } from "../../connectors/connector-writes/kubeconfig-facts.ts";
import { isModelOfferableRow } from "../../connectors/connector-writes/model-offerable.ts";
import { isConnectorWriteModelAccessEnabled } from "../../connectors/connector-writes/model-write-capability.ts";
import { scopeGatedReason } from "../../connectors/connector-writes/scope-gated.ts";
import type {
  ConnectorWriteRow,
  ConnectorWriteWave,
} from "../../connectors/connector-writes/types.ts";
import type { ReachRunner } from "../../extensions/extension-reach.ts";
import { ConnectorRpcError } from "../connector-rpc-shared.ts";
import {
  type AgentEnableReply,
  type AgentWritesDeps,
  handleAgentWritesEnable,
  parseWriteDoor,
} from "./agent-writes.ts";
import {
  handleUserMcpAgentWritesEnable,
  isUserMcpServiceParam,
  type UserMcpAgentEnableReply,
} from "./agent-writes-user-mcp.ts";
import { enableGrantsOf, IAC_SERVICE, KUBERNETES_SERVICE } from "./model-writes-grants.ts";

/**
 * The model door's deps: the members it shares with the agent door (`AgentWritesDeps`, which documents
 * them; an absent `clientKind` reads as `unknown`) plus its own below.
 */
export interface ModelWritesDeps
  extends Pick<
    AgentWritesDeps,
    | "db"
    | "toolExecutor"
    | "getEnforcedPolicy"
    | "now"
    | "rows"
    | "grantedScopes"
    | "listServerTools"
    | "clientKind"
    | "agentAnswerWasNonHuman"
    | "listUserMcpDefinitions"
    | "userMcpNetworkNote"
  > {
  /**
   * Called after the `obsidian` opt-in changes (an approved enable, any disable): the mesh stops the
   * Obsidian slot so its next spawn reads the new grant, and on Windows revokes its ACEs. Must
   * never reject (`LazyConnectorMesh.restartObsidian`). Absent: nothing restarts.
   */
  readonly onObsidianGrantChanged?: () => Promise<void>;
  /**
   * The filesystem facts the approved-directory rule reads (D2, V85). Absent: `enable iac` is
   * refused (it cannot canonicalise a directory it cannot see).
   */
  readonly iacPathDeps?: IacPathDeps;
  /**
   * The sandbox runner the iac children will run under; the enable prompt's host line is read from
   * its live posture. Absent: the prompt makes no per-host claim.
   */
  readonly sandboxRunner?: ReachRunner;
  /**
   * D3a: the kubeconfig path the Vault holds for the `kubernetes` connector (`kubernetes.kubeconfig`),
   * and the filesystem its facts are read from. Absent: `enable kubernetes` is refused (it cannot
   * read a kubeconfig it cannot see).
   */
  readonly readKubeconfigPath?: () => Promise<string | undefined>;
  readonly kubeFs?: KubeFs;
  /** The OS the gateway runs on (the Windows local-cluster warning); default `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /**
   * What approving the Obsidian append would let its sandbox write now (`LazyConnectorMesh.
   * obsidianWriteScope`), shown in the enable prompt. Absent: the prompt says the folders are unknown.
   */
  readonly obsidianWriteScope?: () => {
    readonly roots: readonly string[];
    /** Per vault, its daily-note file pattern (`<vault>/<daily folder>/<format>.md`). */
    readonly notes: readonly string[];
    readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  };
}

/** The service whose opt-in also decides a sandbox write grant (I15, OR-B4-1). */
const OBSIDIAN_SERVICE = "obsidian";

/**
 * How the enable prompt marks one write (F7): offered under the CURRENT opt-in, offerable now but
 * offered only once this prompt is approved, or not offerable yet (approving does not offer it).
 */
export type EnableWriteState = "already_approved" | "newly_offerable" | "not_offerable";

const DEFAULT_WAVE: ConnectorWriteWave = 3;

function parseWave(raw: unknown): ConnectorWriteWave {
  if (raw === undefined) return DEFAULT_WAVE;
  if (raw === 2 || raw === 3 || raw === 4) return raw;
  throw new ConnectorRpcError(-32602, "ERR_CONNECTOR_WRITES_BAD_WAVE: wave must be 2, 3 or 4");
}

function parseEligibleService(
  raw: unknown,
  rows: readonly ConnectorWriteRow[] | undefined,
): string {
  if (typeof raw !== "string" || !modelWriteServices(rows).includes(raw)) {
    throw new ConnectorRpcError(
      -32602,
      "ERR_CONNECTOR_WRITES_UNKNOWN_SERVICE: that service has no connector writes",
    );
  }
  return raw;
}

function parseServiceForDisable(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ConnectorRpcError(-32602, "ERR_CONNECTOR_WRITES_UNKNOWN_SERVICE: service required");
  }
  return raw;
}

/** The Obsidian write scope for the prompt, only when approving would grant it; never throws. */
function obsidianScopeFor(
  service: string,
  writes: readonly { readonly toolId: string; readonly offerable: boolean }[],
  deps: ModelWritesDeps,
): ReturnType<NonNullable<ModelWritesDeps["obsidianWriteScope"]>> | undefined {
  if (service !== OBSIDIAN_SERVICE || deps.obsidianWriteScope === undefined) return undefined;
  if (!writes.some((w) => w.toolId === OBSIDIAN_APPEND_TOOL_ID && w.offerable)) return undefined;
  try {
    return deps.obsidianWriteScope();
  } catch {
    return undefined; // the prompt then says the folders are not known
  }
}

/** Each write the enable would cover, and how the prompt marks it (F7). */
function enableWriteLines(
  service: string,
  maxWave: ConnectorWriteWave,
  deps: ModelWritesDeps,
  existing: ReturnType<typeof getModelWriteEnablement>,
) {
  return writesEnabledBy(service, maxWave, deps.rows).map((r) => {
    const reason = scopeGatedReason(r.toolId, deps.grantedScopes);
    const offerable = isModelOfferableRow(r) && reason === undefined;
    let state: EnableWriteState = "not_offerable";
    if (offerable) {
      state =
        existing?.approvedToolIds.has(r.toolId) === true ? "already_approved" : "newly_offerable";
    }
    return {
      toolId: r.toolId,
      actionType: r.actionType,
      wave: r.wave,
      offerable,
      state,
      ...(reason === undefined ? {} : { reason }),
    };
  });
}

/** In a fixed order: validate, eligible service, LIVE policy, the owner's gate, then the write. */
export async function handleConnectorWritesEnable(
  rec: Record<string, unknown> | undefined,
  deps: ModelWritesDeps,
): Promise<
  | { service: string; maxWave: ConnectorWriteWave; writes: number }
  | AgentEnableReply
  | UserMcpAgentEnableReply
> {
  if (parseWriteDoor(rec?.["door"]) === "agent") {
    // A user-registered MCP server has its own enable (AD5a): no waves, no write rows, exact tool names.
    return isUserMcpServiceParam(rec?.["service"])
      ? handleUserMcpAgentWritesEnable(rec, deps)
      : handleAgentWritesEnable(rec, deps);
  }
  if (rec?.["approve"] !== undefined) {
    throw new ConnectorRpcError(
      -32602,
      "ERR_CONNECTOR_WRITES_BAD_APPROVE: --approve belongs to --door agent",
    );
  }
  if (deps.toolExecutor === undefined) {
    throw new ConnectorRpcError(-32603, "connector.writesEnable requires a toolExecutor");
  }
  const maxWave = parseWave(rec?.["wave"]);
  const service = parseEligibleService(rec?.["service"], deps.rows);
  if (!isConnectorWriteModelAccessEnabled(deps.getEnforcedPolicy())) {
    throw new ConnectorRpcError(
      -32000,
      "ERR_CONNECTOR_WRITES_POLICY: org policy does not allow model connector writes",
    );
  }
  // Read BEFORE the gate: the prompt says which writes the current opt-in already offers.
  const existing = getModelWriteEnablement(deps.db, service);
  const writes = enableWriteLines(service, maxWave, deps, existing);
  const grants = await enableGrantsOf(service, rec, maxWave, deps);
  // The approved directories and clouds are named in the prompt the owner approves (D2, I15).
  const payload: Record<string, unknown> = { service, maxWave, writes, ...grants.promptScope };
  // The Obsidian widening is named in the prompt the owner approves (I15, OR-B4-1).
  const scope = obsidianScopeFor(service, writes, deps);
  if (scope !== undefined) payload["fileWriteScope"] = scope;
  const gate = await deps.toolExecutor.gate({ type: "connector.writes.enable", payload });
  if (gate !== "proceed") {
    throw new ConnectorRpcError(-32000, "ERR_CONNECTOR_WRITES_DECLINED: nothing was enabled");
  }
  // The approved set is exactly the offerable-now writes the owner just saw listed (V84).
  const approved = writes.filter((w) => w.offerable).map((w) => w.toolId);
  setModelWriteEnablement(deps.db, service, maxWave, deps.now(), approved);
  if (grants.iacGrants !== undefined) setIacGrants(deps.db, grants.iacGrants, deps.now());
  if (grants.k8sGrants !== undefined) setK8sGrants(deps.db, grants.k8sGrants, deps.now());
  // After the row: the restart's next spawn reads the grant from it.
  if (service === OBSIDIAN_SERVICE) await deps.onObsidianGrantChanged?.();
  return { service, maxWave, writes: writes.length };
}

/** Narrowing needs no approval; idempotent. Disabling `obsidian` also withdraws its write grant now. */
export async function handleConnectorWritesDisable(
  rec: Record<string, unknown> | undefined,
  deps: ModelWritesDeps,
): Promise<{ removed: boolean }> {
  const door = parseWriteDoor(rec?.["door"]);
  const service = parseServiceForDisable(rec?.["service"]);
  // The agent door's list alone: the shared wave and the model's approvals are left as they are.
  if (door === "agent") return { removed: removeDoorApprovals(deps.db, service, "agent") > 0 };
  let removed = removeModelWriteEnablement(deps.db, service);
  // Disabling a service withdraws the agent door's approvals of it too (narrowing needs no approval).
  if (removeDoorApprovals(deps.db, service) > 0) removed = true;
  // Disabling `iac` drops the approved directories and clouds too (narrowing needs no approval).
  if (service === IAC_SERVICE && removeIacGrants(deps.db)) removed = true;
  // Disabling `kubernetes` drops the approved contexts and namespaces too.
  if (service === KUBERNETES_SERVICE && removeK8sGrants(deps.db)) removed = true;
  if (service === OBSIDIAN_SERVICE) await deps.onObsidianGrantChanged?.();
  return { removed };
}

/**
 * Per service: `offerable` is what the model is offered now (offerable AND approved by name, V84)
 * and `awaitingApproval` is what is offerable now but not approved (re-enable to approve it). A
 * service that is not enabled has nothing approved, so its offerable writes all await approval.
 */
export function handleConnectorWritesStatus(deps: ModelWritesDeps): {
  services: Array<{
    service: string;
    enabled: boolean;
    maxWave?: ConnectorWriteWave;
    enabledAt?: number;
    /** `iac` only: the approved directories, clouds, regions and extra hosts. */
    iacGrants?: IacGrants;
    /** `kubernetes` only: the approved (context, namespace) pairs with their server and form. */
    k8sGrants?: K8sGrant[];
    writes: number;
    offerable: number;
    awaitingApproval: number;
    /** Offerable rows whose credential lacks a scope the connector needs to list them (SA2). */
    notOffered?: Array<{ toolId: string; reason: string }>;
  }>;
  policyAllows: boolean;
} {
  const enabled = new Map(listModelWriteEnablement(deps.db).map((e) => [e.service, e]));
  const services = modelWriteServices(deps.rows).map((service) => {
    const e = enabled.get(service);
    const maxWave = e?.maxWave ?? 4;
    const gated: Array<{ toolId: string; reason: string }> = [];
    const offerableNow = offerableWritesEnabledBy(service, maxWave, deps.rows).filter((r) => {
      const reason = scopeGatedReason(r.toolId, deps.grantedScopes);
      if (reason !== undefined) gated.push({ toolId: r.toolId, reason });
      return reason === undefined;
    });
    const approved = offerableNow.filter((r) => e?.approvedToolIds.has(r.toolId) === true).length;
    const counts = {
      writes: writesEnabledBy(service, maxWave, deps.rows).length,
      offerable: approved,
      awaitingApproval: offerableNow.length - approved,
    };
    let extra: Record<string, unknown> = gated.length > 0 ? { notOffered: gated } : {};
    if (service === IAC_SERVICE) extra = { ...extra, iacGrants: getIacGrants(deps.db) };
    if (service === KUBERNETES_SERVICE) extra = { ...extra, k8sGrants: getK8sGrants(deps.db) };
    return e === undefined
      ? { service, enabled: false, ...counts, ...extra }
      : { service, enabled: true, maxWave: e.maxWave, enabledAt: e.enabledAt, ...counts, ...extra };
  });
  return {
    services,
    policyAllows: isConnectorWriteModelAccessEnabled(deps.getEnforcedPolicy()),
  };
}
