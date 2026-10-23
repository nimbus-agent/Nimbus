import type { Database } from "bun:sqlite";

import {
  clearSchedulerCursor,
  countItemsForService,
  insertSyncTelemetry,
  listAllSchedulerStates,
  loadSchedulerState,
  type PersistedSchedulerStatus,
  type SchedulerStateRow,
  setIntervalMs,
  setNextSyncAt,
  setPaused,
  setSchedulerCursor,
  updateSchedulerState,
  upsertSchedulerRegistration,
} from "./scheduler-store.ts";

export type { SchedulerStateRow } from "./scheduler-store.ts";

export type SchedulerTelemetryInsert = Parameters<typeof insertSyncTelemetry>[1];

export interface SchedulerStateRepository {
  loadState(serviceId: string): SchedulerStateRow | null;
  listAllStates(): SchedulerStateRow[];
  upsertRegistration(
    serviceId: string,
    intervalMs: number,
    now: number,
    updateInterval: boolean,
  ): void;
  writeIntervalMs(serviceId: string, intervalMs: number): void;
  writeNextSyncAt(serviceId: string, nextSyncAt: number | null): void;
  writePaused(serviceId: string, paused: boolean): void;
  /** The cursor alone: a rate-limited / unauthenticated run's `resumeCursor`. */
  writeCursor(serviceId: string, cursor: string): void;
  /** The cursor back to NULL: a `connector.sync --full` run starts from nothing. */
  clearCursor(serviceId: string): void;
  updateState(params: {
    serviceId: string;
    cursor: string | null;
    intervalMs: number;
    lastSyncAt: number | null;
    nextSyncAt: number | null;
    status: PersistedSchedulerStatus;
    errorMsg: string | null;
    consecutiveFailures: number;
    paused: boolean;
  }): void;
  insertSyncTelemetry(row: SchedulerTelemetryInsert): void;
  countItemsForService(serviceId: string): number;
}

export class SqliteSchedulerStateRepository implements SchedulerStateRepository {
  constructor(private readonly db: Database) {}

  loadState(serviceId: string): SchedulerStateRow | null {
    return loadSchedulerState(this.db, serviceId);
  }

  listAllStates(): SchedulerStateRow[] {
    return listAllSchedulerStates(this.db);
  }

  upsertRegistration(
    serviceId: string,
    intervalMs: number,
    now: number,
    updateInterval: boolean,
  ): void {
    upsertSchedulerRegistration(this.db, serviceId, intervalMs, now, updateInterval);
  }

  writeIntervalMs(serviceId: string, intervalMs: number): void {
    setIntervalMs(this.db, serviceId, intervalMs);
  }

  writeNextSyncAt(serviceId: string, nextSyncAt: number | null): void {
    setNextSyncAt(this.db, serviceId, nextSyncAt);
  }

  writePaused(serviceId: string, paused: boolean): void {
    setPaused(this.db, serviceId, paused);
  }

  writeCursor(serviceId: string, cursor: string): void {
    setSchedulerCursor(this.db, serviceId, cursor);
  }

  clearCursor(serviceId: string): void {
    clearSchedulerCursor(this.db, serviceId);
  }

  updateState(params: {
    serviceId: string;
    cursor: string | null;
    intervalMs: number;
    lastSyncAt: number | null;
    nextSyncAt: number | null;
    status: PersistedSchedulerStatus;
    errorMsg: string | null;
    consecutiveFailures: number;
    paused: boolean;
  }): void {
    updateSchedulerState(this.db, params);
  }

  insertSyncTelemetry(row: SchedulerTelemetryInsert): void {
    insertSyncTelemetry(this.db, row);
  }

  countItemsForService(serviceId: string): number {
    return countItemsForService(this.db, serviceId);
  }
}
