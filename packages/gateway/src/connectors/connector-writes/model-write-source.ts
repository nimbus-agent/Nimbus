// packages/gateway/src/connectors/connector-writes/model-write-source.ts
// The production `ConnectorWriteToolSource` (ruling D1) for the model's connector-write door
// (`engine/connector-write-agent-tools.ts`). Built in `gateway-main.ts`. Every read is live: the
// owner's enablement (V83), the RESOLVED org policy (I22, fail-closed) and offerability (M1).
import type { Database } from "bun:sqlite";

import type { ConnectorWriteToolSource } from "../../engine/connector-write-agent-tools.ts";
import { serviceOf } from "../../engine/service-of.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import { getModelWriteEnablement, listModelWriteEnablement } from "./enablement-store.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import { isConnectorWriteModelAccessEnabled } from "./model-write-capability.ts";
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
}

function policyAllows(deps: ModelWriteSourceDeps): boolean {
  try {
    return isConnectorWriteModelAccessEnabled(deps.enforcedPolicy?.());
  } catch {
    return false;
  }
}

export function createModelWriteToolSource(deps: ModelWriteSourceDeps): ConnectorWriteToolSource {
  const rows = deps.rows ?? CONNECTOR_WRITE_ROWS;
  return {
    offerableEnabledRows: () => {
      if (!policyAllows(deps)) return [];
      const out: ConnectorWriteRow[] = [];
      for (const e of listModelWriteEnablement(deps.db)) {
        for (const r of rows) {
          if (
            serviceOf(r.actionType) === e.service &&
            r.wave <= e.maxWave &&
            isModelOfferableRow(r)
          ) {
            out.push(r);
          }
        }
      }
      return out;
    },
    listServerTools: deps.listServerTools,
    toolsEpoch: deps.toolsEpoch,
    recheck: (row) => {
      if (!policyAllows(deps) || !isModelOfferableRow(row)) return false;
      const e = getModelWriteEnablement(deps.db, serviceOf(row.actionType));
      return e !== undefined && row.wave <= e.maxWave;
    },
    warn: deps.warn,
  };
}
