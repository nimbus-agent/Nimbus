// packages/gateway/src/connectors/connector-writes/door-approval-store.ts
// The owner's per-door approval list for connector writes (V97 `connector_write_door_approval`,
// Phase 28 AD3a-1, static rule D49(b)): which write tools the owner approved BY NAME for an outside
// agent, each with the SHA-256 of the tool's listed definition at approval. This module is the ONLY
// one that names the table (besides its DDL file); every write goes through `dbRun` (I14).
//
// A suspension is sticky: `markDoorToolSuspended` sets it once and only a re-approval
// (`upsertDoorApprovals`) clears it, so a server that changes a definition and changes it back does
// not un-suspend itself.
import type { Database } from "bun:sqlite";

import { dbRun } from "../../db/write.ts";

/** The doors an approval list can belong to. The column has no value CHECK; the type is the guard. */
export type WriteDoor = "agent";

export interface DoorApprovalEntry {
  readonly toolId: string;
  /** Lower-case hex SHA-256 of the listed definition (64 characters). */
  readonly definitionSha256: string;
}

export interface DoorApproval extends DoorApprovalEntry {
  readonly service: string;
  readonly door: WriteDoor;
  readonly approvedAt: number;
  /** When a listing first disagreed with the approved hash, or `null` while the approval stands. */
  readonly suspendedAt: number | null;
  /** The hash observed then; `null` when the tool was no longer listed or its schema unreadable. */
  readonly suspendedSha256: string | null;
}

interface DoorApprovalDbRow {
  service: string;
  door: string;
  tool_id: string;
  approved_at: number;
  definition_sha256: string;
  suspended_at: number | null;
  suspended_sha256: string | null;
}

const COLUMNS =
  "service, door, tool_id, approved_at, definition_sha256, suspended_at, suspended_sha256";

function fromDb(r: DoorApprovalDbRow): DoorApproval {
  return {
    service: r.service,
    door: r.door as WriteDoor,
    toolId: r.tool_id,
    approvedAt: r.approved_at,
    definitionSha256: r.definition_sha256,
    suspendedAt: r.suspended_at,
    suspendedSha256: r.suspended_sha256,
  };
}

/** Every approval of `door` (of `service` when given), sorted by service then tool id. */
export function listDoorApprovals(
  db: Database,
  door: WriteDoor,
  service?: string,
): readonly DoorApproval[] {
  const rows =
    service === undefined
      ? db
          .query(
            `SELECT ${COLUMNS} FROM connector_write_door_approval WHERE door = ? ORDER BY service, tool_id`,
          )
          .all(door)
      : db
          .query(
            `SELECT ${COLUMNS} FROM connector_write_door_approval WHERE door = ? AND service = ? ORDER BY service, tool_id`,
          )
          .all(door, service);
  return (rows as DoorApprovalDbRow[]).map(fromDb);
}

export function getDoorApproval(
  db: Database,
  door: WriteDoor,
  service: string,
  toolId: string,
): DoorApproval | undefined {
  const r = db
    .query(
      `SELECT ${COLUMNS} FROM connector_write_door_approval WHERE door = ? AND service = ? AND tool_id = ?`,
    )
    .get(door, service, toolId) as DoorApprovalDbRow | null;
  return r === null ? undefined : fromDb(r);
}

/** Replace the service's whole list for `door` (one transaction): the owner approved exactly these. */
export function replaceDoorApprovals(
  db: Database,
  door: WriteDoor,
  service: string,
  entries: readonly DoorApprovalEntry[],
  now: number,
): void {
  db.transaction(() => {
    dbRun(db, "DELETE FROM connector_write_door_approval WHERE door = ? AND service = ?", [
      door,
      service,
    ]);
    for (const e of entries) {
      dbRun(
        db,
        `INSERT INTO connector_write_door_approval (${COLUMNS})
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
        [service, door, e.toolId, now, e.definitionSha256],
      );
    }
  })();
}

/**
 * Approve (or re-approve) the given tools and keep every other row: the new hash and time replace
 * the old, and both suspension columns are cleared.
 */
export function upsertDoorApprovals(
  db: Database,
  door: WriteDoor,
  service: string,
  entries: readonly DoorApprovalEntry[],
  now: number,
): void {
  db.transaction(() => {
    for (const e of entries) {
      dbRun(
        db,
        `INSERT INTO connector_write_door_approval (${COLUMNS})
         VALUES (?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(service, door, tool_id) DO UPDATE SET approved_at = excluded.approved_at,
           definition_sha256 = excluded.definition_sha256, suspended_at = NULL, suspended_sha256 = NULL`,
        [service, door, e.toolId, now, e.definitionSha256],
      );
    }
  })();
}

/** Drop a service's approvals (of one door, or of every door). The count removed. */
export function removeDoorApprovals(db: Database, service: string, door?: WriteDoor): number {
  return door === undefined
    ? dbRun(db, "DELETE FROM connector_write_door_approval WHERE service = ?", [service]).changes
    : dbRun(db, "DELETE FROM connector_write_door_approval WHERE service = ? AND door = ?", [
        service,
        door,
      ]).changes;
}

/**
 * Mark an approval suspended: ONE conditional UPDATE, so the first observation wins and a repeat is a
 * no-op. `approvedSha` is the approved hash the observation was compared against: a row re-approved
 * since (another hash) is not touched. `observedSha` is `null` for a tool that is no longer listed or
 * whose schema cannot be read. True when this call set the mark.
 */
export function markDoorToolSuspended(
  db: Database,
  door: WriteDoor,
  service: string,
  toolId: string,
  approvedSha: string,
  observedSha: string | null,
  now: number,
): boolean {
  return (
    dbRun(
      db,
      `UPDATE connector_write_door_approval SET suspended_at = ?, suspended_sha256 = ?
       WHERE door = ? AND service = ? AND tool_id = ? AND definition_sha256 = ?
         AND suspended_at IS NULL`,
      [now, observedSha, door, service, toolId, approvedSha],
    ).changes === 1
  );
}
