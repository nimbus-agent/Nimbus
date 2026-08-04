import type { Database } from "bun:sqlite";

import {
  type ConnectorHealthSnapshot,
  type ConnectorHealthState,
  getAllConnectorHealth,
  getConnectorHealth,
  transitionHealth,
} from "../connectors/health.ts";
import { isOnline } from "./connectivity.ts";
import {
  type SchedulerStateRepository,
  type SchedulerStateRow,
  SqliteSchedulerStateRepository,
} from "./scheduler-state-repository.ts";
import type {
  Syncable,
  SyncContext,
  SyncResult,
  SyncSchedulerConfig,
  SyncStatus,
} from "./types.ts";
import { RateLimitError, UnauthenticatedError } from "./types.ts";

const DEFAULT_CONFIG: SyncSchedulerConfig = {
  maxConcurrentSyncs: 3,
  catchUpOnRestart: false,
  retentionDays: 90,
};

const STARTUP_NEXT_SYNC_SLACK_MS = 250;

const CONNECTIVITY_RECHECK_MS = 30_000;

const SKIP_HEALTH_STATES: ReadonlySet<ConnectorHealthState> = new Set([
  "rate_limited",
  "unauthenticated",
  "paused",
]);

type JobReason = "scheduled" | "continuation" | "force";

type Job = {
  serviceId: string;
  reason: JobReason;
};

function clampBackoffBaseMs(failures: number): number {
  const base = 5000 * 2 ** Math.max(0, failures - 1);
  return Math.min(30 * 60 * 1000, base);
}

function genericSyncErrorMessage(): string {
  return "Sync failed";
}

const MAX_SYNC_FAILURE_MSG = 2048;

function syncFailureUserMessage(err: unknown): string {
  let raw: string;
  if (err instanceof Error) {
    raw = err.message.trim() === "" ? err.name : err.message;
  } else if (typeof err === "string") {
    raw = err;
  } else {
    raw = String(err);
    if (raw === "[object Object]") {
      return genericSyncErrorMessage();
    }
  }
  const t = raw.trim();
  if (t === "") {
    return genericSyncErrorMessage();
  }
  return t.length > MAX_SYNC_FAILURE_MSG ? `${t.slice(0, MAX_SYNC_FAILURE_MSG)}…` : t;
}

function toRejectionError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  return new Error(syncFailureUserMessage(err));
}

export class SyncScheduler {
  private readonly db: Database;
  private readonly sched: SchedulerStateRepository;
  private readonly ctx: SyncContext;
  private readonly config: SyncSchedulerConfig;
  private readonly notify: ((title: string, body: string) => Promise<void>) | undefined;
  private readonly rand: () => number;
  private readonly connectivityProbeHost: string | undefined;
  private readonly isOnlineFn: () => Promise<boolean>;

  private readonly connectors = new Map<string, Syncable>();
  private readonly inFlight = new Set<string>();
  private queue: Job[] = [];
  private readonly queuedServiceIds = new Set<string>();
  private runningGlobal = 0;
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private stopped = false;

  private _online = true;
  private _connectivityRecheckHandle: ReturnType<typeof setTimeout> | null = null;

  private readonly forceWaiters = new Map<string, Array<(err?: unknown) => void>>();

  private readonly onConnectorSyncSuccess:
    | ((serviceId: string, result: SyncResult, durationMs: number) => void)
    | undefined;

  constructor(
    syncContext: SyncContext,
    config?: Partial<SyncSchedulerConfig>,
    options?: {
      notify?: (title: string, body: string) => Promise<void>;
      random?: () => number;
      onConnectorSyncSuccess?: (serviceId: string, result: SyncResult, durationMs: number) => void;
      connectivityProbeHost?: string;
      isOnline?: () => Promise<boolean>;
      initialOnline?: boolean;
      schedulerStateRepository?: SchedulerStateRepository;
    },
  ) {
    this.db = syncContext.db;
    this.sched =
      options?.schedulerStateRepository ?? new SqliteSchedulerStateRepository(syncContext.db);
    this.ctx = syncContext;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.notify = options?.notify;
    this.rand = options?.random ?? Math.random;
    this.onConnectorSyncSuccess = options?.onConnectorSyncSuccess;
    this.connectivityProbeHost = options?.connectivityProbeHost;
    this.isOnlineFn = options?.isOnline ?? (() => isOnline(this.connectivityProbeHost));
    if (options?.initialOnline !== undefined) {
      this._online = options.initialOnline;
    }
  }

  register(connector: Syncable, intervalOverrideMs?: number): void {
    const now = Date.now();
    const existing = this.sched.loadState(connector.serviceId);
    const interval = intervalOverrideMs ?? existing?.interval_ms ?? connector.defaultIntervalMs;
    const updateInterval = intervalOverrideMs !== undefined;
    this.sched.upsertRegistration(connector.serviceId, interval, now, updateInterval);
    this.connectors.set(connector.serviceId, connector);
    if (this.started) {
      this.tick();
    }
  }

  private rebuildQueuedServiceIds(): void {
    this.queuedServiceIds.clear();
    for (const j of this.queue) {
      this.queuedServiceIds.add(j.serviceId);
    }
  }

  unregister(serviceId: string): void {
    this.connectors.delete(serviceId);
    this.queue = this.queue.filter((j) => j.serviceId !== serviceId);
    this.rebuildQueuedServiceIds();
    this.resolveForceWaiters(serviceId, new Error("Connector removed"));
  }

  setInterval(serviceId: string, intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs < 1) {
      throw new Error("intervalMs must be a positive finite number");
    }
    this.sched.writeIntervalMs(serviceId, intervalMs);
  }

  start(): void {
    if (this.started || this.stopped) {
      return;
    }
    this.started = true;
    const now = Date.now();
    if (!this.config.catchUpOnRestart) {
      for (const id of this.connectors.keys()) {
        const row = this.sched.loadState(id);
        if (row?.next_sync_at != null && row.next_sync_at < now) {
          const overdueMs = now - row.next_sync_at;
          const nextAt = overdueMs <= STARTUP_NEXT_SYNC_SLACK_MS ? now : now + row.interval_ms;
          this.sched.writeNextSyncAt(id, nextAt);
        }
      }
    }
    void this.probeConnectivity();
    this.tickHandle = setInterval(() => {
      this.tick();
    }, 25);
    this.tick();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    if (this._connectivityRecheckHandle !== null) {
      clearTimeout(this._connectivityRecheckHandle);
      this._connectivityRecheckHandle = null;
    }
    while (this.runningGlobal > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  pause(serviceId: string): void {
    this.sched.writePaused(serviceId, true);
    transitionHealth(this.db, serviceId, { type: "paused" });
  }

  resume(serviceId: string): void {
    this.sched.writePaused(serviceId, false);
    transitionHealth(this.db, serviceId, { type: "resumed" });
    if (this.started) {
      this.tick();
    }
  }

  async forceSync(serviceId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const list = this.forceWaiters.get(serviceId) ?? [];
      list.push((err?: unknown) => {
        if (err === undefined) {
          resolve();
        } else {
          reject(toRejectionError(err));
        }
      });
      this.forceWaiters.set(serviceId, list);
      this.queue = this.queue.filter((j) => j.serviceId !== serviceId);
      this.queue.unshift({ serviceId, reason: "force" });
      this.rebuildQueuedServiceIds();
      this.pump();
    });
  }

  getStatus(serviceId?: string): SyncStatus[] {
    if (serviceId !== undefined && serviceId !== "" && !this.connectors.has(serviceId)) {
      return [];
    }
    const ids =
      serviceId !== undefined && serviceId !== ""
        ? [serviceId]
        : [...this.connectors.keys()].sort((a, b) => a.localeCompare(b));
    const out: SyncStatus[] = [];
    for (const id of ids) {
      const row = this.sched.loadState(id);
      if (row === null) {
        continue;
      }
      const itemCount = this.sched.countItemsForService(id);
      out.push(this.rowToStatus(id, row, itemCount));
    }
    return out;
  }

  private scheduleConnectivityRecheck(delayMs: number): void {
    if (this._connectivityRecheckHandle !== null || this.stopped) {
      return;
    }
    this._connectivityRecheckHandle = setTimeout(() => {
      this._connectivityRecheckHandle = null;
      void this.probeConnectivity();
    }, delayMs);
  }

  private async probeConnectivity(): Promise<void> {
    const online = await this.isOnlineFn();
    this._online = online;
    if (!online) {
      for (const id of this.connectors.keys()) {
        const health = getConnectorHealth(this.db, id);
        if (!SKIP_HEALTH_STATES.has(health.state) && health.state !== "error") {
          transitionHealth(this.db, id, { type: "skipped_offline" });
        }
      }
      this.scheduleConnectivityRecheck(CONNECTIVITY_RECHECK_MS);
      return;
    }
    if (this.started && !this.stopped) {
      this.tick();
    }
  }

  private getDepthForService(serviceId: string): "metadata_only" | "summary" | "full" {
    const row = this.db
      .query(`SELECT depth FROM sync_state WHERE connector_id = ?`)
      .get(serviceId) as { depth: string | null } | null | undefined;
    if (row == null) {
      return "full";
    }
    return (row.depth ?? "full") as "metadata_only" | "summary" | "full";
  }

  private rowToStatus(serviceId: string, row: SchedulerStateRow, itemCount: number): SyncStatus {
    let status: SyncStatus["status"] = "ok";
    if (row.paused === 1) {
      status = "paused";
    } else if (this.inFlight.has(serviceId)) {
      status = "syncing";
    } else if (row.status === "error") {
      status = "error";
    } else if (row.status === "backoff") {
      status = "backoff";
    }
    const health = getConnectorHealth(this.db, serviceId);
    const depth = this.getDepthForService(serviceId);
    return {
      serviceId,
      status,
      lastSyncAt: row.last_sync_at,
      nextSyncAt: row.next_sync_at,
      intervalMs: row.interval_ms,
      itemCount,
      lastError: row.error_msg,
      consecutiveFailures: row.consecutive_failures,
      healthState: health.state,
      healthRetryAfterMs: health.retryAfter === undefined ? null : health.retryAfter.getTime(),
      depth,
      enabled: status !== "paused",
    };
  }

  private healthGatePreventsDispatchSnapshot(
    health: ConnectorHealthSnapshot,
    connectorId: string,
    now: number,
    opts: { logRateLimited: boolean },
  ): boolean {
    if (!SKIP_HEALTH_STATES.has(health.state)) {
      return false;
    }
    if (health.state === "rate_limited") {
      if (health.retryAfter !== undefined && now < health.retryAfter.getTime()) {
        if (opts.logRateLimited) {
          this.ctx.logger.debug({ msg: "skipped_rate_limited", connectorId });
        }
        return true;
      }
      return false;
    }
    return true;
  }

  private healthGatePreventsDispatch(
    connectorId: string,
    now: number,
    opts: { logRateLimited: boolean },
    health?: ConnectorHealthSnapshot,
  ): boolean {
    const snap = health ?? getConnectorHealth(this.db, connectorId);
    return this.healthGatePreventsDispatchSnapshot(snap, connectorId, now, opts);
  }

  private connectorSkippedForHealth(
    connectorId: string,
    now: number,
    health?: ConnectorHealthSnapshot,
  ): boolean {
    return this.healthGatePreventsDispatch(connectorId, now, { logRateLimited: true }, health);
  }

  private tick(): void {
    if (this.stopped) {
      return;
    }
    if (!this._online) {
      this.scheduleConnectivityRecheck(CONNECTIVITY_RECHECK_MS);
      return;
    }
    const now = Date.now();
    const healthById = new Map(
      getAllConnectorHealth(this.db).map((s): [string, ConnectorHealthSnapshot] => [
        s.connectorId,
        s,
      ]),
    );
    const rowMap = new Map(
      this.sched.listAllStates().map((r): [string, SchedulerStateRow] => [r.service_id, r]),
    );
    for (const id of this.connectors.keys()) {
      const row = rowMap.get(id);
      if (row === null || row === undefined || row.paused === 1 || row.status === "error") {
        continue;
      }
      const health =
        healthById.get(id) ??
        ({
          connectorId: id,
          state: "healthy",
          backoffAttempt: 0,
        } satisfies ConnectorHealthSnapshot);
      if (this.connectorSkippedForHealth(id, now, health)) {
        continue;
      }
      if (this.inFlight.has(id)) {
        continue;
      }
      if (this.queuedServiceIds.has(id)) {
        continue;
      }
      if (row.next_sync_at != null && now >= row.next_sync_at) {
        this.queue.push({ serviceId: id, reason: "scheduled" });
        this.queuedServiceIds.add(id);
      }
    }
    this.pump();
  }

  private canStartJob(job: Job): boolean {
    if (this.inFlight.has(job.serviceId)) {
      return false;
    }
    const row = this.sched.loadState(job.serviceId);
    if (row === null) {
      return false;
    }
    if (row.paused === 1 && job.reason !== "force") {
      return false;
    }
    if (row.status === "error" && job.reason !== "force") {
      return false;
    }
    if (
      job.reason !== "force" &&
      this.healthGatePreventsDispatch(job.serviceId, Date.now(), { logRateLimited: false })
    ) {
      return false;
    }
    return true;
  }

  private pump(): void {
    if (this.stopped) {
      return;
    }
    while (this.runningGlobal < this.config.maxConcurrentSyncs && this.queue.length > 0) {
      let idx = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const j = this.queue[i];
        if (j !== undefined && this.canStartJob(j)) {
          idx = i;
          break;
        }
      }
      if (idx === -1) {
        break;
      }
      const job = this.queue[idx];
      if (job === undefined) {
        break;
      }
      this.queue.splice(idx, 1);
      this.rebuildQueuedServiceIds();
      this.inFlight.add(job.serviceId);
      this.runningGlobal++;
      void this.runJob(job).finally(() => {
        this.inFlight.delete(job.serviceId);
        this.runningGlobal--;
        this.pump();
        this.tick();
      });
    }
  }

  private resolveForceWaiters(serviceId: string, err?: unknown): void {
    const waiters = this.forceWaiters.get(serviceId);
    if (waiters === undefined) {
      return;
    }
    this.forceWaiters.delete(serviceId);
    for (const w of waiters) {
      w(err);
    }
  }

  private backoffDelayMs(failures: number): number {
    const capped = clampBackoffBaseMs(failures);
    const jitter = 0.8 + this.rand() * 0.4;
    return Math.min(30 * 60 * 1000, Math.floor(capped * jitter));
  }

  private runJobRecordSyncFailure(
    job: Job,
    row: SchedulerStateRow,
    startedAt: number,
    msg: string,
  ): void {
    const failures = row.consecutive_failures + 1;
    const durationMs = Date.now() - startedAt;
    this.sched.insertSyncTelemetry({
      service: job.serviceId,
      startedAt,
      durationMs,
      itemsUpserted: 0,
      itemsDeleted: 0,
      bytesTransferred: null,
      hadMore: false,
      errorMsg: msg,
    });
    if (failures >= 5) {
      this.sched.updateState({
        serviceId: job.serviceId,
        cursor: row.cursor,
        intervalMs: row.interval_ms,
        lastSyncAt: row.last_sync_at,
        nextSyncAt: null,
        status: "error",
        errorMsg: msg,
        consecutiveFailures: failures,
        paused: row.paused === 1,
      });
      void this.notify?.(
        "Nimbus sync failed",
        `Service "${job.serviceId}" stopped after repeated failures.`,
      );
      transitionHealth(this.db, job.serviceId, { type: "persistent_error", error: msg });
    } else {
      const delay = this.backoffDelayMs(failures);
      this.sched.updateState({
        serviceId: job.serviceId,
        cursor: row.cursor,
        intervalMs: row.interval_ms,
        lastSyncAt: row.last_sync_at,
        nextSyncAt: Date.now() + delay,
        status: "backoff",
        errorMsg: msg,
        consecutiveFailures: failures,
        paused: row.paused === 1,
      });
      transitionHealth(this.db, job.serviceId, {
        type: "transient_error",
        error: msg,
        attempt: failures,
      });
    }
    if (job.reason === "force") {
      this.resolveForceWaiters(job.serviceId, new Error(msg));
    } else {
      this.resolveForceWaiters(job.serviceId);
    }
  }

  private runJobRecordSyncSuccess(
    job: Job,
    row: SchedulerStateRow,
    startedAt: number,
    result: SyncResult,
  ): void {
    const durationMs = Date.now() - startedAt;
    const bytes =
      result.bytesTransferred !== undefined && Number.isFinite(result.bytesTransferred)
        ? Math.floor(result.bytesTransferred)
        : null;
    this.sched.insertSyncTelemetry({
      service: job.serviceId,
      startedAt,
      durationMs,
      itemsUpserted: result.itemsUpserted,
      itemsDeleted: result.itemsDeleted,
      bytesTransferred: bytes,
      hadMore: result.hasMore,
      errorMsg: null,
    });

    const now = Date.now();
    const nextInterval = now + row.interval_ms;
    const nextSyncAt: number | null = result.hasMore ? now : nextInterval;

    this.sched.updateState({
      serviceId: job.serviceId,
      cursor: result.cursor,
      intervalMs: row.interval_ms,
      lastSyncAt: now,
      nextSyncAt,
      status: "ok",
      errorMsg: null,
      consecutiveFailures: 0,
      paused: row.paused === 1,
    });

    transitionHealth(this.db, job.serviceId, { type: "sync_success" });

    if (result.hasMore) {
      this.queue.unshift({ serviceId: job.serviceId, reason: "continuation" });
      this.rebuildQueuedServiceIds();
    }

    this.resolveForceWaiters(job.serviceId);
    this.onConnectorSyncSuccess?.(job.serviceId, result, durationMs);
  }

  private recordAbortedSyncTelemetry(job: Job, startedAt: number, errorMsg: string): void {
    const durationMs = Date.now() - startedAt;
    this.sched.insertSyncTelemetry({
      service: job.serviceId,
      startedAt,
      durationMs,
      itemsUpserted: 0,
      itemsDeleted: 0,
      bytesTransferred: null,
      hadMore: false,
      errorMsg,
    });
  }

  private resolveRunJobContext(job: Job): { connector: Syncable; row: SchedulerStateRow } | null {
    const connector = this.connectors.get(job.serviceId);
    if (connector === undefined) {
      this.resolveForceWaiters(
        job.serviceId,
        job.reason === "force" ? new Error("Unknown service") : undefined,
      );
      return null;
    }
    const row = this.sched.loadState(job.serviceId);
    if (row === null) {
      this.resolveForceWaiters(
        job.serviceId,
        job.reason === "force" ? new Error("Missing scheduler state") : undefined,
      );
      return null;
    }
    if (row.paused === 1 && job.reason !== "force") {
      this.resolveForceWaiters(job.serviceId);
      return null;
    }
    if (row.status === "error" && job.reason !== "force") {
      this.resolveForceWaiters(job.serviceId);
      return null;
    }
    return { connector, row };
  }

  private async runJob(job: Job): Promise<void> {
    const ctx = this.resolveRunJobContext(job);
    if (ctx === null) {
      return;
    }
    const { connector, row } = ctx;

    const startedAt = Date.now();
    let result: SyncResult;
    try {
      const runCtx: SyncContext = {
        ...this.ctx,
        depth: this.getDepthForService(job.serviceId),
      };
      result = await connector.sync(runCtx, row.cursor);
    } catch (err) {
      if (err instanceof RateLimitError) {
        transitionHealth(this.db, job.serviceId, {
          type: "rate_limited",
          retryAfter: err.retryAfter,
        });
        this.recordAbortedSyncTelemetry(job, startedAt, err.message);
        this.resolveForceWaiters(job.serviceId, job.reason === "force" ? err : undefined);
        return;
      }
      if (err instanceof UnauthenticatedError) {
        transitionHealth(this.db, job.serviceId, { type: "unauthenticated" });
        void this.notify?.(
          "Nimbus connector lost authentication",
          `${job.serviceId} connector lost authentication. Run: nimbus connector auth ${job.serviceId}`,
        );
        this.recordAbortedSyncTelemetry(job, startedAt, err.message);
        this.resolveForceWaiters(job.serviceId, job.reason === "force" ? err : undefined);
        return;
      }
      this.runJobRecordSyncFailure(job, row, startedAt, syncFailureUserMessage(err));
      return;
    }

    this.runJobRecordSyncSuccess(job, row, startedAt, result);
  }
}
