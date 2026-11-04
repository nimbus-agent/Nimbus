// packages/gateway/src/ipc/connector-rpc-handlers/model-writes.ts
// `connector.writesEnable|writesDisable|writesStatus`: the owner's opt-in for model connector writes.
import type { Database } from "bun:sqlite";

import {
  listModelWriteEnablement,
  modelWriteServices,
  removeModelWriteEnablement,
  setModelWriteEnablement,
  writesEnabledBy,
} from "../../connectors/connector-writes/enablement-store.ts";
import { isConnectorWriteModelAccessEnabled } from "../../connectors/connector-writes/model-write-capability.ts";
import type { ConnectorWriteWave } from "../../connectors/connector-writes/types.ts";
import type { ToolExecutor } from "../../engine/executor.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import { ConnectorRpcError } from "../connector-rpc-shared.ts";

export interface ModelWritesDeps {
  readonly db: Database;
  readonly toolExecutor: ToolExecutor | undefined;
  /** LIVE resolved policy (I22); `undefined` means "cannot tell" and refuses. */
  readonly getEnforcedPolicy: () => Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined;
  readonly now: () => number;
}

const DEFAULT_WAVE: ConnectorWriteWave = 3;

function parseWave(raw: unknown): ConnectorWriteWave {
  if (raw === undefined) return DEFAULT_WAVE;
  if (raw === 2 || raw === 3 || raw === 4) return raw;
  throw new ConnectorRpcError(-32602, "ERR_CONNECTOR_WRITES_BAD_WAVE: wave must be 2, 3 or 4");
}

function parseEligibleService(raw: unknown): string {
  if (typeof raw !== "string" || !modelWriteServices().includes(raw)) {
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

/** In a fixed order: validate, eligible service, LIVE policy, the owner's gate, then the write. */
export async function handleConnectorWritesEnable(
  rec: Record<string, unknown> | undefined,
  deps: ModelWritesDeps,
): Promise<{ service: string; maxWave: ConnectorWriteWave; writes: number }> {
  if (deps.toolExecutor === undefined) {
    throw new ConnectorRpcError(-32603, "connector.writesEnable requires a toolExecutor");
  }
  const maxWave = parseWave(rec?.["wave"]);
  const service = parseEligibleService(rec?.["service"]);
  if (!isConnectorWriteModelAccessEnabled(deps.getEnforcedPolicy())) {
    throw new ConnectorRpcError(
      -32000,
      "ERR_CONNECTOR_WRITES_POLICY: org policy does not allow model connector writes",
    );
  }
  const writes = writesEnabledBy(service, maxWave).map((r) => ({
    toolId: r.toolId,
    actionType: r.actionType,
    wave: r.wave,
  }));
  const gate = await deps.toolExecutor.gate({
    type: "connector.writes.enable",
    payload: { service, maxWave, writes },
  });
  if (gate !== "proceed") {
    throw new ConnectorRpcError(-32000, "ERR_CONNECTOR_WRITES_DECLINED: nothing was enabled");
  }
  setModelWriteEnablement(deps.db, service, maxWave, deps.now());
  return { service, maxWave, writes: writes.length };
}

/** Narrowing needs no approval; idempotent. */
export function handleConnectorWritesDisable(
  rec: Record<string, unknown> | undefined,
  deps: ModelWritesDeps,
): { removed: boolean } {
  return { removed: removeModelWriteEnablement(deps.db, parseServiceForDisable(rec?.["service"])) };
}

export function handleConnectorWritesStatus(deps: ModelWritesDeps): {
  services: Array<{
    service: string;
    enabled: boolean;
    maxWave?: ConnectorWriteWave;
    enabledAt?: number;
    writes: number;
  }>;
  policyAllows: boolean;
} {
  const enabled = new Map(listModelWriteEnablement(deps.db).map((e) => [e.service, e]));
  const services = modelWriteServices().map((service) => {
    const e = enabled.get(service);
    return e === undefined
      ? { service, enabled: false, writes: writesEnabledBy(service, 4).length }
      : {
          service,
          enabled: true,
          maxWave: e.maxWave,
          enabledAt: e.enabledAt,
          writes: writesEnabledBy(service, e.maxWave).length,
        };
  });
  return {
    services,
    policyAllows: isConnectorWriteModelAccessEnabled(deps.getEnforcedPolicy()),
  };
}
