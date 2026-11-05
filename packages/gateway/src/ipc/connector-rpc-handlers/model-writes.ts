// packages/gateway/src/ipc/connector-rpc-handlers/model-writes.ts
// `connector.writesEnable|writesDisable|writesStatus`: the owner's opt-in for model connector writes.
import type { Database } from "bun:sqlite";

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
import { isModelOfferableRow } from "../../connectors/connector-writes/model-offerable.ts";
import { isConnectorWriteModelAccessEnabled } from "../../connectors/connector-writes/model-write-capability.ts";
import type {
  ConnectorWriteRow,
  ConnectorWriteWave,
} from "../../connectors/connector-writes/types.ts";
import type { ToolExecutor } from "../../engine/executor.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import { ConnectorRpcError } from "../connector-rpc-shared.ts";

export interface ModelWritesDeps {
  readonly db: Database;
  readonly toolExecutor: ToolExecutor | undefined;
  /** LIVE resolved policy (I22); `undefined` means "cannot tell" and refuses. */
  readonly getEnforcedPolicy: () => Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined;
  readonly now: () => number;
  /** Test seam; production uses the write table. */
  readonly rows?: readonly ConnectorWriteRow[];
  /**
   * Called after the `obsidian` opt-in changes (an approved enable, any disable): the mesh stops the
   * Obsidian slot so its next spawn reads the new grant, and on Windows revokes its ACEs. Must
   * never reject (`LazyConnectorMesh.restartObsidian`). Absent: nothing restarts.
   */
  readonly onObsidianGrantChanged?: () => Promise<void>;
  /**
   * What approving the Obsidian append would let its sandbox write now (`LazyConnectorMesh.
   * obsidianWriteScope`), shown in the enable prompt. Absent: the prompt says the folders are unknown.
   */
  readonly obsidianWriteScope?: () => {
    readonly roots: readonly string[];
    readonly vaults: readonly string[];
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

/** In a fixed order: validate, eligible service, LIVE policy, the owner's gate, then the write. */
export async function handleConnectorWritesEnable(
  rec: Record<string, unknown> | undefined,
  deps: ModelWritesDeps,
): Promise<{ service: string; maxWave: ConnectorWriteWave; writes: number }> {
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
  const writes = writesEnabledBy(service, maxWave, deps.rows).map((r) => {
    const offerable = isModelOfferableRow(r);
    let state: EnableWriteState = "not_offerable";
    if (offerable) {
      state =
        existing?.approvedToolIds.has(r.toolId) === true ? "already_approved" : "newly_offerable";
    }
    return { toolId: r.toolId, actionType: r.actionType, wave: r.wave, offerable, state };
  });
  const payload: Record<string, unknown> = { service, maxWave, writes };
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
  // After the row: the restart's next spawn reads the grant from it.
  if (service === OBSIDIAN_SERVICE) await deps.onObsidianGrantChanged?.();
  return { service, maxWave, writes: writes.length };
}

/** Narrowing needs no approval; idempotent. Disabling `obsidian` also withdraws its write grant now. */
export async function handleConnectorWritesDisable(
  rec: Record<string, unknown> | undefined,
  deps: ModelWritesDeps,
): Promise<{ removed: boolean }> {
  const service = parseServiceForDisable(rec?.["service"]);
  const removed = removeModelWriteEnablement(deps.db, service);
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
    writes: number;
    offerable: number;
    awaitingApproval: number;
  }>;
  policyAllows: boolean;
} {
  const enabled = new Map(listModelWriteEnablement(deps.db).map((e) => [e.service, e]));
  const services = modelWriteServices(deps.rows).map((service) => {
    const e = enabled.get(service);
    const maxWave = e?.maxWave ?? 4;
    const offerableNow = offerableWritesEnabledBy(service, maxWave, deps.rows);
    const approved = offerableNow.filter((r) => e?.approvedToolIds.has(r.toolId) === true).length;
    const counts = {
      writes: writesEnabledBy(service, maxWave, deps.rows).length,
      offerable: approved,
      awaitingApproval: offerableNow.length - approved,
    };
    return e === undefined
      ? { service, enabled: false, ...counts }
      : { service, enabled: true, maxWave: e.maxWave, enabledAt: e.enabledAt, ...counts };
  });
  return {
    services,
    policyAllows: isConnectorWriteModelAccessEnabled(deps.getEnforcedPolicy()),
  };
}
