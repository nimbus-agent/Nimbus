import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { incidentIdFor } from "./incident-id.ts";
import type { IncidentRecordV1 } from "./incident-record-types.ts";

/**
 * The ONLY writer of `incident_record` and `incident_record_version` (Phase 10 IC3, static D46(d)). It imports
 * nothing from `incident/` but its types and the id function, and nothing from `index/` at all, so
 * `index/local-index.ts` can call the erase function without an import cycle.
 *
 * Every function uses bound parameters (I9, I14). Versions are deleted explicitly before their record: the
 * foreign-key cascade is a backstop, never the mechanism (`PRAGMA foreign_keys` is set per connection).
 * Functions that delete open no transaction of their own beyond a nested savepoint, so an eraser's caller
 * owns the commit.
 */

export type UpsertOutcome = "created" | "updated" | "unchanged";

export type UpsertInput = {
  /** The assembled record; its `version` is IGNORED (the store assigns it inside its transaction). */
  readonly record: IncidentRecordV1;
  readonly markdown: string;
  readonly recordSha256: string;
  /** The distinct services of the trigger and every cited item (a sorted list). */
  readonly citedServices: readonly string[];
  readonly nowMs: number;
};

export type UpsertResult = {
  readonly outcome: UpsertOutcome;
  readonly recordId: string;
  readonly version: number;
  readonly status: string;
};

export type RecordRow = {
  readonly id: string;
  readonly trigger_item_id: string;
  readonly trigger_service: string;
  readonly trigger_type: string;
  readonly service: string | null;
  readonly title: string;
  readonly severity: string | null;
  readonly opened_at_ms: number | null;
  readonly status: "open" | "closed" | "unknown";
  readonly version: number;
  readonly assembled_at_ms: number;
  readonly checked_at_ms: number;
  readonly record_sha256: string;
  readonly cited_services: string;
  readonly record_json: string;
  readonly markdown: string;
};

export type VersionRow = {
  readonly version: number;
  readonly assembled_at_ms: number;
  readonly record_sha256: string;
};

const RECORD_COLUMNS =
  "id, trigger_item_id, trigger_service, trigger_type, service, title, severity, opened_at_ms, status, version, assembled_at_ms, checked_at_ms, record_sha256, cited_services, record_json, markdown";

type ExistingRow = { id: string; version: number; status: string; same: number };

function insertVersion(
  db: Database,
  recordId: string,
  version: number,
  input: UpsertInput,
  json: string,
): void {
  dbRun(
    db,
    `INSERT INTO incident_record_version (record_id, version, assembled_at_ms, record_sha256, cited_services, record_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [recordId, version, input.nowMs, input.recordSha256, JSON.stringify(input.citedServices), json],
  );
}

function insertRecord(db: Database, id: string, input: UpsertInput, json: string): void {
  const t = input.record.trigger;
  dbRun(
    db,
    `INSERT INTO incident_record (id, trigger_item_id, trigger_service, trigger_type, service, title, severity,
       opened_at_ms, status, version, assembled_at_ms, checked_at_ms, record_sha256, cited_services, record_json, markdown)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      t.itemId,
      t.service,
      t.type,
      input.record.binding.service,
      t.title,
      t.severity,
      t.opened.ms,
      t.status,
      input.nowMs,
      input.nowMs,
      input.recordSha256,
      JSON.stringify(input.citedServices),
      json,
      input.markdown,
    ],
  );
}

function updateRecord(
  db: Database,
  id: string,
  version: number,
  input: UpsertInput,
  json: string,
): void {
  const t = input.record.trigger;
  dbRun(
    db,
    `UPDATE incident_record SET service = ?, title = ?, severity = ?, opened_at_ms = ?, status = ?, version = ?,
       assembled_at_ms = ?, checked_at_ms = ?, record_sha256 = ?, cited_services = ?, record_json = ?, markdown = ?
     WHERE id = ?`,
    [
      input.record.binding.service,
      t.title,
      t.severity,
      t.opened.ms,
      t.status,
      version,
      input.nowMs,
      input.nowMs,
      input.recordSha256,
      JSON.stringify(input.citedServices),
      json,
      input.markdown,
      id,
    ],
  );
}

/**
 * Insert, update or touch the record of one trigger item, in ONE transaction. No row: version 1. The same
 * `record_sha256`: NO new version and `version`, `assembled_at_ms` and `record_json` untouched, but
 * `checked_at_ms` is set (so a closed record is not re-selected for ever). A different hash: the row is
 * updated and version N+1 is inserted, N read inside the transaction. Version N's `record_json` is immutable.
 */
export function upsertIncidentRecord(db: Database, input: UpsertInput): UpsertResult {
  const tx = db.transaction((): UpsertResult => {
    const itemId = input.record.trigger.itemId;
    const existing = db
      .query(
        `SELECT id, version, status, (record_sha256 = ?) AS same FROM incident_record WHERE trigger_item_id = ?`,
      )
      .get(input.recordSha256, itemId) as ExistingRow | null;
    if (existing === null) {
      const id = incidentIdFor(itemId);
      const json = JSON.stringify({ ...input.record, version: 1 });
      insertRecord(db, id, input, json);
      insertVersion(db, id, 1, input, json);
      return { outcome: "created", recordId: id, version: 1, status: input.record.trigger.status };
    }
    if (existing.same === 1) {
      dbRun(db, "UPDATE incident_record SET checked_at_ms = ? WHERE id = ?", [
        input.nowMs,
        existing.id,
      ]);
      return {
        outcome: "unchanged",
        recordId: existing.id,
        version: existing.version,
        status: existing.status,
      };
    }
    const next = existing.version + 1;
    const json = JSON.stringify({ ...input.record, version: next });
    updateRecord(db, existing.id, next, input, json);
    insertVersion(db, existing.id, next, input, json);
    return {
      outcome: "updated",
      recordId: existing.id,
      version: next,
      status: input.record.trigger.status,
    };
  });
  return tx();
}

export function getByTriggerItem(db: Database, triggerItemId: string): RecordRow | null {
  return db
    .query(`SELECT ${RECORD_COLUMNS} FROM incident_record WHERE trigger_item_id = ?`)
    .get(triggerItemId) as RecordRow | null;
}

export function getById(db: Database, id: string): RecordRow | null {
  return db
    .query(`SELECT ${RECORD_COLUMNS} FROM incident_record WHERE id = ?`)
    .get(id) as RecordRow | null;
}

export type ListFilter = {
  readonly open?: boolean;
  readonly service?: string;
  /** The trigger source (`pagerduty`, `jira`, ...). */
  readonly source?: string;
  readonly limit: number;
};

/** Newest first by open time, then id; a record with no open time sorts last (SQLite orders NULL smallest). */
export function listRecords(db: Database, f: ListFilter): RecordRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.open === true) {
    where.push("status = 'open'");
  }
  if (f.service !== undefined) {
    where.push("service = ?");
    params.push(f.service);
  }
  if (f.source !== undefined) {
    where.push("trigger_service = ?");
    params.push(f.source);
  }
  const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  return db
    .query(
      `SELECT ${RECORD_COLUMNS} FROM incident_record ${clause} ORDER BY opened_at_ms DESC, id ASC LIMIT ?`,
    )
    .all(...params, f.limit) as RecordRow[];
}

export function versionsOf(db: Database, recordId: string): VersionRow[] {
  return db
    .query(
      `SELECT version, assembled_at_ms, record_sha256 FROM incident_record_version
        WHERE record_id = ? ORDER BY version ASC`,
    )
    .all(recordId) as VersionRow[];
}

/** The parsed `record_json` of one stored version, or null. */
export function versionJson(db: Database, recordId: string, version: number): string | null {
  const row = db
    .query("SELECT record_json FROM incident_record_version WHERE record_id = ? AND version = ?")
    .get(recordId, version) as { record_json: string } | null;
  return row === null ? null : row.record_json;
}

function deleteRecordsByIds(db: Database, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const json = JSON.stringify(ids);
  // Versions first: no orphan remains even with foreign keys off.
  dbRun(
    db,
    "DELETE FROM incident_record_version WHERE record_id IN (SELECT value FROM json_each(?))",
    [json],
  );
  dbRun(db, "DELETE FROM incident_record WHERE id IN (SELECT value FROM json_each(?))", [json]);
}

export const INCIDENT_PRUNE_BATCH = 500;

/**
 * One batch of retention: records older than `cutoffMs` by the TWO-ARM rule (an open time older than the
 * cutoff, or no open time and an assembly older than it; never a `COALESCE`, which defeats the index),
 * versions first. Returns the deleted trigger item ids (the pushed-brief wrapper needs them).
 */
export function pruneIncidentRecords(
  db: Database,
  cutoffMs: number,
  limit: number = INCIDENT_PRUNE_BATCH,
): string[] {
  const tx = db.transaction((): string[] => {
    const rows = db
      .query(
        `SELECT id, trigger_item_id FROM incident_record
          WHERE (opened_at_ms IS NOT NULL AND opened_at_ms < ?1) OR (opened_at_ms IS NULL AND assembled_at_ms < ?1)
          ORDER BY id LIMIT ?2`,
      )
      .all(cutoffMs, limit) as { id: string; trigger_item_id: string }[];
    deleteRecordsByIds(
      db,
      rows.map((r) => r.id),
    );
    return rows.map((r) => r.trigger_item_id);
  });
  return tx();
}

/** `json_each` over a value that may not be valid JSON: an invalid value reads as an empty list (the NOT json_valid arm deletes it). */
const SAFE_LIST = (col: string): string =>
  `json_each(CASE WHEN json_valid(${col}) THEN ${col} ELSE '[]' END)`;

const CITES_SQL = `
  r.trigger_service = ?1
  OR NOT json_valid(r.cited_services)
  OR EXISTS (SELECT 1 FROM ${SAFE_LIST("r.cited_services")} j WHERE j.value = ?1)
  OR EXISTS (
    SELECT 1 FROM incident_record_version v
     WHERE v.record_id = r.id
       AND (NOT json_valid(v.cited_services)
            OR EXISTS (SELECT 1 FROM ${SAFE_LIST("v.cited_services")} j WHERE j.value = ?1)))`;

type EraseRow = { id: string; trigger_item_id: string };

function citingRecords(db: Database, service: string): EraseRow[] {
  return db
    .query(`SELECT r.id, r.trigger_item_id FROM incident_record r WHERE ${CITES_SQL} ORDER BY r.id`)
    .all(service) as EraseRow[];
}

/** What an erasure of `service` would delete, read-only (the `data delete` dry run). */
export function recordsCitingService(db: Database, service: string): readonly EraseRow[] {
  return citingRecords(db, service);
}

export type EraseRecordsResult = {
  readonly recordIds: readonly string[];
  readonly triggerItemIds: readonly string[];
};

/**
 * Delete every record that cites `service`: its own trigger service, the service in the record's own
 * `cited_services`, in ANY version's `cited_services` (a later version may have stopped citing it while an
 * earlier version's JSON and the Markdown pushed from it still hold its titles), or a `cited_services` that
 * is not valid JSON (fail closed). Versions first. Opens no transaction of its own beyond a savepoint.
 */
export function eraseIncidentRecordsForService(db: Database, service: string): EraseRecordsResult {
  const tx = db.transaction((): EraseRecordsResult => {
    const rows = citingRecords(db, service);
    const ids = rows.map((r) => r.id);
    deleteRecordsByIds(db, ids);
    return { recordIds: ids, triggerItemIds: rows.map((r) => r.trigger_item_id) };
  });
  return tx();
}
