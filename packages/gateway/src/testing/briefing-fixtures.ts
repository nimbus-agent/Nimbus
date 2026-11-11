import type { Database } from "bun:sqlite";
import type { ConnectorServiceId } from "../connectors/connector-catalog.ts";
import { createStubVault, syncTestContext } from "../connectors/connector-sync-test-helpers.ts";
import { mapGoogleCalendarEvent } from "../connectors/google-calendar-event-mapping.ts";
import { mapOutlookCalendarEvent } from "../connectors/outlook-calendar-mapping.ts";
import { dbRun } from "../db/write.ts";
import { replaceWorkSnapshotRows } from "../index/work-snapshot-store.ts";

/**
 * Seeds for the morning briefing's tests. Calendar rows go through the REAL mappers; the other rows are
 * written by the production `upsertItem` capability with the metadata keys the real writers emit
 * (the key inventory is in the MB5 plan, and the acceptance test drives the real syncables).
 */

const vault = createStubVault({});

export type SeedItem = {
  readonly service: ConnectorServiceId;
  readonly type: string;
  readonly externalId: string;
  readonly title: string;
  readonly url?: string | null;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
};

/** Writes one `item` row through the sync capability set and returns its id. */
export function seedItem(db: Database, it: SeedItem): string {
  const ctx = syncTestContext(db, vault, it.service);
  ctx.upsertItem({
    service: it.service,
    type: it.type,
    externalId: it.externalId,
    title: it.title,
    bodyPreview: "",
    url: it.url ?? null,
    canonicalUrl: it.url ?? null,
    modifiedAt: it.modifiedAt,
    metadata: it.metadata,
    syncedAt: it.modifiedAt,
  } as never);
  const row = db
    .query("SELECT id FROM item WHERE service = ? AND external_id = ?")
    .get(it.service, it.externalId) as { id: string } | null;
  if (row === null) throw new Error(`seed failed for ${it.service}:${it.externalId}`);
  return row.id;
}

export function seedGoogleEvent(
  db: Database,
  raw: Record<string, unknown>,
  zone = "Europe/London",
): string {
  const row = mapGoogleCalendarEvent(raw, {
    calendarId: "primary",
    calendarName: "Me",
    zone,
    syncedAt: 1,
  });
  if (row === null) throw new Error("google event did not map");
  return seedItem(db, { ...row, service: "google_calendar" } as SeedItem);
}

export function seedOutlookEvent(
  db: Database,
  raw: Record<string, unknown>,
  zone = "Europe/London",
): string {
  const m = mapOutlookCalendarEvent(raw, { zone, syncedAt: 1 });
  if (m.kind !== "row") throw new Error("outlook event did not map");
  return seedItem(db, { ...m.row, service: "outlook" } as SeedItem);
}

export function setSnapshot(
  db: Database,
  service: string,
  relation: "assigned" | "review_requested" | "authored_open",
  externalIds: readonly string[],
  nowMs: number,
): void {
  replaceWorkSnapshotRows(db, service, relation, externalIds, nowMs);
}

export function markSynced(db: Database, connectorId: string, lastSyncAt: number | null): void {
  dbRun(
    db,
    "INSERT INTO sync_state (connector_id, last_sync_at) VALUES (?, ?) ON CONFLICT (connector_id) DO UPDATE SET last_sync_at = excluded.last_sync_at",
    [connectorId, lastSyncAt],
  );
}
