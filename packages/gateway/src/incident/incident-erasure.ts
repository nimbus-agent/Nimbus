import type { Database } from "bun:sqlite";
import {
  countPushedBriefsForErasure,
  deletePushedBriefsForErasure,
} from "../oncall-push/push-store.ts";
import { noteErasure } from "./erasure-generation.ts";
import {
  eraseIncidentRecordsForService,
  INCIDENT_PRUNE_BATCH,
  pruneIncidentRecords,
  recordsCitingService,
} from "./incident-store.ts";
import { deleteProposalsForRecords } from "./proposal-store.ts";
import { deleteRunbookStepsForRecords } from "./runbook-step-store.ts";

/**
 * The one place that deletes incident records and the pushed briefs built from them (Phase 10 IC3, design I,
 * I57 (a)). An OWNER erasure (`connector remove`, `nimbus data delete`) calls `eraseIncidentDataForService`
 * inside the transaction each already opens, so a failure anywhere rolls the item delete back too. Retention
 * calls `pruneIncidentRecordsWithBriefs`, so a pruned record never leaves its brief behind where a later
 * erasure could not find it. No engine pass erases anything.
 */

export type IncidentErasure = {
  readonly recordsDeleted: number;
  readonly pushedBriefsDeleted: number;
  /** Remediation proposals of the erased records (IC5a); an OWNER erasure deletes them, retention keeps them. */
  readonly proposalsDeleted?: number;
  /** Runbook step state of the erased records (IC6); an OWNER erasure deletes it, retention keeps it. */
  readonly runbookStepsDeleted?: number;
};

/**
 * Delete every record that cites `service` (any version), its versions, and the pushed briefs tied to
 * them by `incident_id = trigger_item_id`, plus every pushed brief whose key begins with `<service>:`.
 * Opens only a nested savepoint; the caller's transaction owns the commit.
 */
export function eraseIncidentDataForService(db: Database, service: string): IncidentErasure {
  const tx = db.transaction((): IncidentErasure => {
    noteErasure(); // an assembly that gathered evidence before this must not write it after
    const erased = eraseIncidentRecordsForService(db, service);
    const pushedBriefsDeleted = deletePushedBriefsForErasure(db, {
      triggerItemIds: erased.triggerItemIds,
      service,
    });
    const proposalsDeleted = deleteProposalsForRecords(db, erased.recordIds);
    const runbookStepsDeleted = deleteRunbookStepsForRecords(db, erased.recordIds);
    return {
      recordsDeleted: erased.recordIds.length,
      pushedBriefsDeleted,
      proposalsDeleted,
      runbookStepsDeleted,
    };
  });
  return tx();
}

/** Read-only preview of `eraseIncidentDataForService` by the same predicates (the dry run). */
export function previewIncidentErasure(db: Database, service: string): IncidentErasure {
  const rows = recordsCitingService(db, service);
  const pushedBriefsDeleted = countPushedBriefsForErasure(db, {
    triggerItemIds: rows.map((r) => r.trigger_item_id),
    service,
  });
  return { recordsDeleted: rows.length, pushedBriefsDeleted };
}

export const INCIDENT_PRUNE_MAX_BATCHES = 40;

export type PruneRun = { readonly recordsDeleted: number; readonly batches: number };

/**
 * Retention: delete records older than `cutoffMs` in batches, each batch and ITS pushed briefs in ONE
 * transaction (the brief delete is the id arm only).
 */
export function pruneIncidentRecordsWithBriefs(
  db: Database,
  cutoffMs: number,
  batch: number = INCIDENT_PRUNE_BATCH,
  maxBatches: number = INCIDENT_PRUNE_MAX_BATCHES,
): PruneRun {
  let recordsDeleted = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const tx = db.transaction((): number => {
      const ids = pruneIncidentRecords(db, cutoffMs, batch);
      if (ids.length > 0) deletePushedBriefsForErasure(db, { triggerItemIds: ids });
      return ids.length;
    });
    const n = tx();
    batches += 1;
    recordsDeleted += n;
    if (n < batch) break;
  }
  return { recordsDeleted, batches };
}
