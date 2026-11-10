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
import { getIacGrants } from "./iac-grants.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { getK8sGrants } from "./k8s-grants.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import { isConnectorWriteModelAccessEnabled } from "./model-write-capability.ts";
import {
  CHATOPS_CHANNEL_REFUSAL,
  isChatopsDestinationRow,
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
  /**
   * The canonical working directories the owner approved for the iac connector (D2), read per
   * call. Absent: the stored V85 workdir grants, read fresh on every call (never cached past an
   * `enable` or `disable`; `gateway-main` passes nothing). Empty or a throw: the Terraform apply
   * is not offered (no directory to pick).
   */
  readonly approvedWorkdirs?: () => readonly string[];
  /**
   * The (context, namespace) pairs the owner approved for the Kubernetes apply (D3a, V86), read per
   * call. Absent: the stored grants, read fresh on every call. Empty or a throw: the Kubernetes
   * apply is not offered (no pair to pick from).
   */
  readonly approvedK8sPairs?: () => ReadonlyArray<{
    readonly context: string;
    readonly namespace: string;
  }>;
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
  if (e === undefined) return false;
  return (
    serviceOf(row.actionType) === e.service &&
    row.wave <= e.maxWave &&
    isModelOfferableRow(row) &&
    e.approvedToolIds.has(row.toolId)
  );
}

/** The approved working directories, or none (fail closed on a throw). */
function workdirsOf(deps: ModelWriteSourceDeps): readonly string[] {
  try {
    return deps.approvedWorkdirs === undefined
      ? getIacGrants(deps.db).workdirs
      : deps.approvedWorkdirs();
  } catch {
    return [];
  }
}

/** The approved Kubernetes (context, namespace) pairs, or none (fail closed on a throw). */
function k8sPairsOf(
  deps: ModelWriteSourceDeps,
): ReadonlyArray<{ readonly context: string; readonly namespace: string }> {
  try {
    return deps.approvedK8sPairs === undefined ? getK8sGrants(deps.db) : deps.approvedK8sPairs();
  } catch {
    return [];
  }
}

/**
 * A Terraform row can be offered only while there is an approved directory to name (D2), and a
 * Kubernetes row (D3a apply, D3c restart and scale) only while the owner approved at least one
 * (context, namespace) pair.
 */
function directoryAvailable(deps: ModelWriteSourceDeps, row: ConnectorWriteRow): boolean {
  // Every Kubernetes row (the apply, the restart, the scale) needs an approved pair to name.
  if (serviceOf(row.actionType) === "kubernetes") return k8sPairsOf(deps).length > 0;
  return row.bound?.prepare.settle !== "iac-terraform" || workdirsOf(deps).length > 0;
}

export function createModelWriteToolSource(deps: ModelWriteSourceDeps): ConnectorWriteToolSource {
  const rows = deps.rows ?? CONNECTOR_WRITE_ROWS;
  return {
    approvedWorkdirs: () => workdirsOf(deps),
    approvedK8sPairs: () => k8sPairsOf(deps),
    offerableEnabledRows: () => {
      if (!policyAllows(deps)) return [];
      const out: ConnectorWriteRow[] = [];
      for (const e of listModelWriteEnablement(deps.db)) {
        for (const r of rows) {
          if (offeredUnder(e, r) && directoryAvailable(deps, r)) out.push(r);
        }
      }
      return out;
    },
    listServerTools: deps.listServerTools,
    toolsEpoch: deps.toolsEpoch,
    recheck: (row) => {
      if (!policyAllows(deps)) return false;
      return (
        offeredUnder(getModelWriteEnablement(deps.db, serviceOf(row.actionType)), row) &&
        directoryAvailable(deps, row)
      );
    },
    // F3/F4 and OR1 (`modelWriteRefusal`: ChatOps channel, broadcast mention, knowledge base): the
    // ChatOps bindings come from the SAME live enforced policy the offer reads; a throw or an
    // unreadable policy refuses a ChatOps-platform post.
    refusal: (row, input) => {
      let chatops: EnforcedPolicy["chatops"] | undefined;
      try {
        chatops = deps.enforcedPolicy?.()?.chatops;
      } catch (err) {
        // Only a ChatOps-platform row gets the ChatOps text; any other row's throw propagates and
        // the door answers with its generic destination refusal.
        if (isChatopsDestinationRow(row.toolId)) return CHATOPS_CHANNEL_REFUSAL;
        throw err;
      }
      return modelWriteRefusal(row.toolId, input, { chatops, kb: deps.getTribalKbConfig?.() });
    },
    warn: deps.warn,
  };
}
