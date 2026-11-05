// packages/gateway/src/connectors/connector-writes/model-write-source.ts
// The production `ConnectorWriteToolSource` (ruling D1) for the model's connector-write door
// (`engine/connector-write-agent-tools.ts`). Built in `gateway-main.ts`. Every read is live: the
// owner's enablement (V83) and its approved set (V84), the RESOLVED org policy (I22, fail-closed)
// and offerability (M1).
import type { Database } from "bun:sqlite";

import type { ConnectorWriteToolSource } from "../../engine/connector-write-agent-tools.ts";
import { serviceOf } from "../../engine/service-of.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import {
  getModelWriteEnablement,
  listModelWriteEnablement,
  type ModelWriteEnablement,
} from "./enablement-store.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import { isConnectorWriteModelAccessEnabled } from "./model-write-capability.ts";
import {
  CHATOPS_CHANNEL_REFUSAL,
  modelWriteRefusal,
  type TribalKbConfig,
} from "./model-write-refusals.ts";
import type { ConnectorWriteRow } from "./types.ts";

export interface ModelWriteSourceDeps {
  readonly db: Database;
  /** `platform.enforcedPolicy`; absent, or a throw, or `undefined` ⇒ nothing is offered. */
  readonly enforcedPolicy: (() => EnforcedPolicy | undefined) | undefined;
  readonly listServerTools: ConnectorWriteToolSource["listServerTools"];
  readonly toolsEpoch: ConnectorWriteToolSource["toolsEpoch"];
  readonly warn: ConnectorWriteToolSource["warn"];
  /** Test seam; production uses the write table. */
  readonly rows?: readonly ConnectorWriteRow[];
  /**
   * The `[tribal]` knowledge-base destinations (F4), read per call. Absent or `undefined`: no KB
   * is configured, so nothing is refused for it. A throw refuses the call (fail closed).
   */
  readonly getTribalKbConfig?: () => TribalKbConfig | undefined;
}

function policyAllows(deps: ModelWriteSourceDeps): boolean {
  try {
    return isConnectorWriteModelAccessEnabled(deps.enforcedPolicy?.());
  } catch {
    return false;
  }
}

/**
 * The ONE predicate the listing and the per-call recheck share: `row` belongs to the enabled
 * service, its wave is at or below the opt-in's, it is offerable now, AND the owner approved its
 * tool id by name (V84 re-consent). A pre-V84 opt-in has an empty approved set: nothing offered.
 */
function offeredUnder(e: ModelWriteEnablement | undefined, row: ConnectorWriteRow): boolean {
  return (
    e !== undefined &&
    serviceOf(row.actionType) === e.service &&
    row.wave <= e.maxWave &&
    isModelOfferableRow(row) &&
    e.approvedToolIds.has(row.toolId)
  );
}

export function createModelWriteToolSource(deps: ModelWriteSourceDeps): ConnectorWriteToolSource {
  const rows = deps.rows ?? CONNECTOR_WRITE_ROWS;
  return {
    offerableEnabledRows: () => {
      if (!policyAllows(deps)) return [];
      const out: ConnectorWriteRow[] = [];
      for (const e of listModelWriteEnablement(deps.db)) {
        for (const r of rows) {
          if (offeredUnder(e, r)) out.push(r);
        }
      }
      return out;
    },
    listServerTools: deps.listServerTools,
    toolsEpoch: deps.toolsEpoch,
    recheck: (row) => {
      if (!policyAllows(deps)) return false;
      return offeredUnder(getModelWriteEnablement(deps.db, serviceOf(row.actionType)), row);
    },
    // F3/F4: the ChatOps bindings come from the SAME live enforced policy the offer reads; a
    // throw or an unreadable policy refuses a ChatOps-platform post.
    refusal: (row, input) => {
      let chatops: EnforcedPolicy["chatops"] | undefined;
      try {
        chatops = deps.enforcedPolicy?.()?.chatops;
      } catch {
        return CHATOPS_CHANNEL_REFUSAL;
      }
      return modelWriteRefusal(row.toolId, input, { chatops, kb: deps.getTribalKbConfig?.() });
    },
    warn: deps.warn,
  };
}
