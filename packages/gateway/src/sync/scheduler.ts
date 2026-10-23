import type { Database } from "bun:sqlite";
import type { ConnectorServiceId } from "../connectors/connector-catalog.ts";
import {
  type ConnectorHealthSnapshot,
  type ConnectorHealthState,
  getAllConnectorHealth,
  getConnectorHealth,
  transitionHealth,
} from "../connectors/health.ts";
import { isOnline } from "./connectivity.ts";
import { isConnectorConfigured } from "./connector-configured.ts";
import {
  type SchedulerStateRepository,
  type SchedulerStateRow,
  SqliteSchedulerStateRepository,
} from "./scheduler-state-repository.ts";
import { statusLastError } from "./status-last-error.ts";
import { buildSyncCapabilities } from "./sync-capabilities.ts";
import type {
  Syncable,
  SyncContext,
  SyncResult,
  SyncRuntimeContext,
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

type ForceWaiter = (err?: unknown) => void;

/**
 * One unit of scheduled work. Only FORCE jobs carry `waiters`: a `forceSync` request is owned by
 * the job queued for it, so it is settled by that job's outcome and by nothing else — a scheduled
 * or continuation run that happens to be in flight when the request arrives never settles it.
 */
type Job = {
  serviceId: string;
  reason: JobReason;
  /** The `forceSync` callers this job answers. Present on force jobs only. */
  waiters?: ForceWaiter[];
  /** Clear the persisted cursor right before this job loads its state (`connector.sync --full`). */
  clearCursor?: boolean;
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

/** `sync_telemetry.items_dropped` for a successful run: the three `dropped` counts summed, else 0. */
function droppedTotal(result: SyncResult): number {
  const d = result.dropped;
  if (d === undefined) return 0;
  const sum = d.undeclaredType + d.malformed + d.oversized;
  return Number.isFinite(sum) && sum > 0 ? Math.floor(sum) : 0;
}

function toRejectionError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  return new Error(syncFailureUserMessage(err));
}

/**
 * Why `connector` cannot run at all right now, or `null` — exactly the reason `runJob` pauses a
 * service with. A preflight that throws is a refusal too (fail closed). Exported so a caller that
 * resumes a service (the migration engine's accept) can record the SAME pause before the first run.
 */
export function preflightRefusal(connector: { preflight?: () => string | null }): string | null {
  try {
    return connector.preflight?.() ?? null;
  } catch (err) {
    return `preflight failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export class SyncDisabledError extends Error {
  constructor(serviceId: string) {
    super(`ERR_SYNC_DISABLED: syncing is disabled in this gateway, so ${serviceId} cannot sync`);
    this.name = "SyncDisabledError";
  }
}

export class SyncScheduler {
  private readonly db: Database;
  private readonly sched: SchedulerStateRepository;
  private readonly ctx: SyncRuntimeContext;
  private readonly config: SyncSchedulerConfig;
  private readonly notify: ((title: string, body: string) => Promise<void>) | undefined;
  private readonly rand: () => number;
  private readonly connectivityProbeHost: string | undefined;
  private readonly isOnlineFn: () => Promise<boolean>;

  private readonly connectors = new Map<string, Syncable>();
  private readonly inFlight = new Set<string>();
  /** The job currently running per service; set and cleared alongside `inFlight`. */
  private readonly running = new Map<string, Job>();
  private queue: Job[] = [];
  private readonly queuedServiceIds = new Set<string>();
  private runningGlobal = 0;
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private stopped = false;

  private _online = true;
  private _connectivityRecheckHandle: ReturnType<typeof setTimeout> | null = null;

  /**
   * One-shot cold-start floors (epoch ms) per service, set by an owner-initiated
   * `index.rebody --since`. In-memory ONLY: a restart drops a pending backfill
   * back to the connector's own 30-day floor, which is the safe direction —
   * the user can ask again, and nothing silently keeps re-walking history.
   */
  private readonly historyFloors = new Map<string, number>();

  private readonly onConnectorSyncSuccess:
    | ((serviceId: string, result: SyncResult, durationMs: number) => void)
    | undefined;
  private readonly appendSyncEgress:
    | ((row: { destination: string; sourceType: "sync"; method: string }) => void)
    | undefined;
  private readonly syncDisabled: boolean;

  constructor(
    syncContext: SyncRuntimeContext,
    config?: Partial<SyncSchedulerConfig>,
    options?: {
      notify?: (title: string, body: string) => Promise<void>;
      random?: () => number;
      onConnectorSyncSuccess?: (serviceId: string, result: SyncResult, durationMs: number) => void;
      connectivityProbeHost?: string;
      isOnline?: () => Promise<boolean>;
      initialOnline?: boolean;
      schedulerStateRepository?: SchedulerStateRepository;
      /**
       * Appends ONE `sync` egress row per RUN, immediately before `connector.sync(...)` in
       * `runJob`. Optional so existing tests/callers construct unchanged; when absent, this
       * scheduler instance appends nothing — an omitted closure is that explicit "no egress from
       * here" decision, the same shape as `NULL_EGRESS_SINK` elsewhere. Throwing aborts the run —
       * fail-closed, no row means no sync.
       */
      appendSyncEgress?: (row: { destination: string; sourceType: "sync"; method: string }) => void;
      /**
       * A scheduler that must never run a job — a demo-rooted gateway (invariant I41). `forceSync`
       * rejects; `register`, `start`, `tick` and `pump` do nothing.
       */
      syncDisabled?: boolean;
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
    this.appendSyncEgress = options?.appendSyncEgress;
    this.syncDisabled = options?.syncDisabled === true;
    if (options?.initialOnline !== undefined) {
      this._online = options.initialOnline;
    }
  }

  /**
   * The registered connector for `serviceId`, or `undefined` when nothing this scheduler knows
   * about serves it (a service not wired up in this binary at all — distinct from a host simply
   * being unclaimed, which the fetch-host boundary refuses before this lookup is ever reached).
   *
   * A public reader rather than a new construction: `sync/targeted-fetch.ts`'s `syncableFor` dep
   * reads THIS scheduler's own registered connector, so a targeted fetch and a scheduled sync agree
   * on which `Syncable` a service resolves to.
   */
  syncableFor(serviceId: string): Syncable | undefined {
    return this.connectors.get(serviceId);
  }

  /**
   * The `SyncContext` a targeted fetch's `fetchOne` should run with — the SAME shape `runJob`
   * builds for a scheduled sync (this scheduler's own `ctx`, with `depth` resolved per service),
   * so a targeted fetch shares depth enforcement and the rate-limiter bucket with scheduled syncs
   * rather than constructing a parallel context that could drift from it.
   */
  /**
   * The ONE place a per-service context is built. `runJob` and `syncContextFor` both route here so
   * they cannot diverge: a second builder that forgot the capability binding would hand a syncable
   * `undefined` capabilities, and because they are `Partial` during the migration that fails
   * silently at runtime rather than at compile time.
   */
  private contextForService(serviceId: string, historyFloorMs?: number): SyncContext {
    const depth = this.getDepthForService(serviceId);
    const caps = buildSyncCapabilities(
      {
        vault: this.ctx.vault,
        db: this.ctx.db,
        depth,
        ...(this.ctx.resolveServiceId === undefined
          ? {}
          : { resolveServiceId: this.ctx.resolveServiceId }),
        ...(this.ctx.scheduleItemEmbedding === undefined
          ? {}
          : { scheduleItemEmbedding: this.ctx.scheduleItemEmbedding }),
      },
      // The scheduler types serviceId as `string`, but every value reaching here is a registry key
      // — the same id space `CONNECTOR_VAULT_SECRET_KEYS` is keyed by. An id outside it simply
      // resolves no secrets, which is the fail-closed direction.
      serviceId as ConnectorServiceId,
    );
    return {
      ...this.ctx,
      ...caps,
      depth,
      ...(historyFloorMs === undefined ? {} : { historyFloorMs }),
    };
  }

  syncContextFor(serviceId: string): SyncContext {
    return this.contextForService(serviceId);
  }

  register(connector: Syncable, intervalOverrideMs?: number): void {
    if (this.syncDisabled) {
      return;
    }
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
    const removed = this.queue.filter((j) => j.serviceId === serviceId);
    this.queue = this.queue.filter((j) => j.serviceId !== serviceId);
    this.rebuildQueuedServiceIds();
    // Reject at once rather than when the in-flight run returns: the queued jobs will never run,
    // and the running one's outcome is discarded by `wasWithdrawnMidRun`.
    const removedErr = new Error("Connector removed");
    for (const job of removed) {
      this.settleJob(job, removedErr);
    }
    const runningJob = this.running.get(serviceId);
    if (runningJob !== undefined) {
      this.settleJob(runningJob, removedErr);
    }
  }

  setInterval(serviceId: string, intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs < 1) {
      throw new Error("intervalMs must be a positive finite number");
    }
    this.sched.writeIntervalMs(serviceId, intervalMs);
  }

  start(): void {
    if (this.syncDisabled) {
      return;
    }
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
    // A queued job will never be pumped now: reject its force waiters instead of leaving them
    // hanging. Running jobs are drained below and settle with their own outcome.
    const stoppedErr = new Error("Scheduler stopped");
    for (const job of this.queue) {
      this.settleJob(job, stoppedErr);
    }
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    if (this._connectivityRecheckHandle !== null) {
      clearTimeout(this._connectivityRecheckHandle);
      this._connectivityRecheckHandle = null;
    }
    while (this.runningGlobal > 0) {
      await new Promise((r) => setTimeout(r, 10)); // NOSONAR S9382: drain poll - re-checks runningGlobal every 10 ms until in-flight jobs finish; there is no independent work to overlap
    }
  }

  pause(serviceId: string, reason?: string): void {
    this.sched.writePaused(serviceId, true);
    transitionHealth(this.db, serviceId, {
      type: "paused",
      ...(reason === undefined ? {} : { reason }),
    });
  }

  resume(serviceId: string): void {
    this.sched.writePaused(serviceId, false);
    transitionHealth(this.db, serviceId, { type: "resumed" });
    if (this.started) {
      this.tick();
    }
  }

  /**
   * Arm a one-shot cold-start floor for `serviceId`'s next run. Call it
   * immediately before `forceSync(serviceId)`; a successful run consumes it,
   * a rate-limited or failed one keeps it for the retry.
   */
  setHistoryFloor(serviceId: string, floorMs: number): void {
    this.historyFloors.set(serviceId, floorMs);
  }

  /**
   * Run `serviceId` now and settle when a run that STARTED AFTER this call has finished its first
   * page.
   *
   * Invariants: a running job is never joined — a request made while any run of the service is in
   * flight (scheduled, continuation or forced) gets one follow-up run, which reads the state and
   * credentials written up to the moment it starts. Requests made while that follow-up is still
   * queued coalesce into it. `full: true` clears the persisted cursor as that run starts, so a
   * cursor an in-flight run writes back after the request cannot leak into it.
   */
  async forceSync(serviceId: string, opts?: { full?: boolean }): Promise<void> {
    if (this.syncDisabled) {
      throw new SyncDisabledError(serviceId);
    }
    if (this.stopped) {
      // Nothing will ever pump this request: reject rather than hang.
      throw new Error("Scheduler stopped");
    }
    const full = opts?.full === true;
    return new Promise((resolve, reject) => {
      const waiter: ForceWaiter = (err?: unknown) => {
        if (err === undefined) {
          resolve();
        } else {
          reject(toRejectionError(err));
        }
      };
      // `queue` never holds a running job (pump splices a job out before running it), so this
      // finds a force job that has not started yet, or nothing.
      const queuedForce = this.queue.find((j) => j.serviceId === serviceId && j.reason === "force");
      if (queuedForce === undefined) {
        this.queue = this.queue.filter((j) => j.serviceId !== serviceId);
        this.queue.unshift({ serviceId, reason: "force", waiters: [waiter], clearCursor: full });
        this.rebuildQueuedServiceIds();
      } else {
        queuedForce.waiters ??= [];
        queuedForce.waiters.push(waiter);
        queuedForce.clearCursor = queuedForce.clearCursor === true || full;
      }
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
      // A pause carries its reason in the health row, and it wins over a stale sync error.
      lastError: statusLastError(status === "paused", row.error_msg, health.lastError),
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
    if (this.stopped || this.syncDisabled) {
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
    if (this.stopped || this.syncDisabled) {
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
      this.running.set(job.serviceId, job);
      this.runningGlobal++;
      void this.runJob(job).finally(() => {
        this.inFlight.delete(job.serviceId);
        this.running.delete(job.serviceId);
        this.runningGlobal--;
        this.pump();
        this.tick();
      });
    }
  }

  /**
   * Settle `job`'s own force waiters with its outcome (`err` undefined = success). A job without
   * waiters (scheduled, continuation) settles nothing. The waiters are taken before they are
   * called, so a job settles each caller at most once (`unregister` may already have rejected them).
   */
  private settleJob(job: Job, err?: unknown): void {
    const waiters = job.waiters;
    if (waiters === undefined || waiters.length === 0) {
      return;
    }
    job.waiters = [];
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
      itemsDropped: 0,
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
    this.settleJob(job, new Error(msg));
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
      itemsDropped: droppedTotal(result),
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

    // No continuation when a force job for the service is already queued: it is picked first
    // (pump takes the queue front-first and continuations are unshifted), so queueing one would
    // make the force request wait out the whole page chain. The force job resumes from the cursor
    // just persisted (or clears it on purpose for `full`), and its own run queues continuations.
    const forceQueued = this.queue.some(
      (j) => j.serviceId === job.serviceId && j.reason === "force",
    );
    if (result.hasMore && !forceQueued) {
      this.queue.unshift({ serviceId: job.serviceId, reason: "continuation" });
      this.rebuildQueuedServiceIds();
    }

    this.settleJob(job);
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
      itemsDropped: 0,
    });
  }

  private resolveRunJobContext(job: Job): { connector: Syncable; row: SchedulerStateRow } | null {
    const connector = this.connectors.get(job.serviceId);
    if (connector === undefined) {
      this.settleJob(job, new Error("Unknown service"));
      return null;
    }
    // This runs before `runJob`'s try, so a DB error here (e.g. SQLITE_FULL) must settle the job
    // itself: unsettled, a `connector.sync` waiter would hang.
    let row: SchedulerStateRow | null;
    try {
      if (job.clearCursor === true) {
        // `connector.sync --full`: cleared as THIS run starts — after any earlier run of the
        // service has written its cursor back — and read back by the `loadState` just below.
        this.sched.clearCursor(job.serviceId);
      }
      row = this.sched.loadState(job.serviceId);
    } catch (err) {
      this.settleJob(job, err);
      return null;
    }
    if (row === null) {
      this.settleJob(job, new Error("Missing scheduler state"));
      return null;
    }
    // Only scheduled and continuation jobs reach these two, and they carry no waiters.
    if (row.paused === 1 && job.reason !== "force") {
      return null;
    }
    if (row.status === "error" && job.reason !== "force") {
      return null;
    }
    return { connector, row };
  }

  /** Pauses the service with `reason` and rejects force waiters; nothing else is recorded. */
  private refuseRun(job: Job, reason: string): void {
    let failure: Error = new Error(reason);
    try {
      this.pause(job.serviceId, reason);
    } catch (err) {
      failure = new Error(
        `${reason} (pausing failed: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
    this.settleJob(job, failure);
  }

  private async runJob(job: Job): Promise<void> {
    const ctx = this.resolveRunJobContext(job);
    if (ctx === null) {
      return;
    }
    const { connector, row } = ctx;

    // A service that cannot run at all right now is paused BEFORE anything is recorded: no
    // configured transition, no `sync.run` egress row, no success telemetry.
    // A preflight that throws is a refusal too (fail closed): never an unhandled rejection, never
    // a force waiter left hanging.
    const refusal = preflightRefusal(connector);
    if (refusal !== null) {
      this.refuseRun(job, refusal);
      return;
    }

    const startedAt = Date.now();
    let result: SyncResult;
    try {
      const historyFloorMs = this.historyFloors.get(job.serviceId);
      const runCtx: SyncContext = this.contextForService(job.serviceId, historyFloorMs);
      // I29 CRITICAL 1: `platform/assemble-sync-registrations.ts` registers ~90 cloud syncables
      // with NO credential gate, and each one's `sync()` short-circuits to a network-free noop
      // when unconfigured — so appending unconditionally here fabricated an "authorized" `sync`
      // egress row for every registered-but-unconfigured connector's every run, on BOTH the
      // scheduled and forced paths (`forceSync` bypasses the tick-level health/enqueue gates
      // entirely, so the gate has to live here to cover it too). `isConnectorConfigured` answers
      // the same question `sync/fetch-host-boundary.ts` answers for the 5 fetch-on-miss services,
      // generalized to the full connector-secrets manifest.
      //
      // One `sync` egress row per RUN, appended before the connector makes any outbound call.
      // `per-run` is the honest granularity: a sync is a paginated run, not a call. Fail-closed —
      // a throw here aborts the run rather than syncing unrecorded (falls into the `catch` below
      // as an ordinary sync failure, since it happens before any real work started).
      const configured = await isConnectorConfigured(
        this.ctx.vault,
        job.serviceId,
        this.ctx.extensionCredentialsFor,
      );
      // The await above can yield while the service is unregistered (`extension remove`): stop
      // before the egress row, the health transition (which would re-create a purged row) and
      // `sync()`, settling force waiters exactly as the post-`sync()` checks do.
      if (this.wasWithdrawnMidRun(job, connector)) return;
      if (configured) {
        this.appendSyncEgress?.({
          destination: job.serviceId,
          sourceType: "sync",
          method: "sync.run",
        });
      }
      // F6/F13: the same answer, one line later, decides whether this run can honestly be
      // called a sync at all. Without it the `sync_success` below fired for the ~90 registered
      // syncables whose `sync()` short-circuits to a network-free noop when unconfigured, so a
      // connector nobody had set up reported `healthy` with a fresh `lastSyncAt` — which is what
      // `getConnectorStatus` served to a model that has no prior to doubt it.
      transitionHealth(this.db, job.serviceId, {
        type: configured ? "configured" : "not_configured",
      });
      result = await connector.sync(runCtx, row.cursor);
    } catch (err) {
      if (this.wasWithdrawnMidRun(job, connector)) return;
      // A run that committed pages before the stop names the last committed page's cursor, so the
      // next run resumes there. Only the cursor moves: the arms below are unchanged, so the run is
      // still recorded as rate-limited / unauthenticated, never as a success. No bundled connector
      // sets the field, and without it nothing is written here.
      if (
        (err instanceof RateLimitError || err instanceof UnauthenticatedError) &&
        err.resumeCursor !== undefined
      ) {
        this.sched.writeCursor(job.serviceId, err.resumeCursor);
      }
      if (err instanceof RateLimitError) {
        transitionHealth(this.db, job.serviceId, {
          type: "rate_limited",
          retryAfter: err.retryAfter,
        });
        this.recordAbortedSyncTelemetry(job, startedAt, err.message);
        this.settleJob(job, err);
        return;
      }
      if (err instanceof UnauthenticatedError) {
        transitionHealth(this.db, job.serviceId, { type: "unauthenticated" });
        void this.notify?.(
          "Nimbus connector lost authentication",
          `${job.serviceId} connector lost authentication. Run: nimbus connector auth ${job.serviceId}`,
        );
        this.recordAbortedSyncTelemetry(job, startedAt, err.message);
        this.settleJob(job, err);
        return;
      }
      this.runJobRecordSyncFailure(job, row, startedAt, syncFailureUserMessage(err));
      return;
    }

    // Consumed only on success. A rate-limited or failed run returns earlier
    // WITHOUT persisting a cursor, so its retry is still a cold start and must
    // keep the wide floor — otherwise the backfill silently narrows to 30 days
    // and never reaches the history it was asked for. (A rate-limited run that
    // carried a `resumeCursor` did persist one; keeping the floor for it is
    // harmless, since an established cursor always wins over the floor.)
    //
    // Deleting on a `hasMore: true` success is correct: `runJobRecordSyncSuccess`
    // writes `result.cursor` via `updateState` and re-queues a "continuation"
    // job, and that job resumes from the persisted cursor — which bypasses the
    // cold-start override entirely. The floor has done its job by then.
    if (this.wasWithdrawnMidRun(job, connector)) return;
    this.historyFloors.delete(job.serviceId);
    this.runJobRecordSyncSuccess(job, row, startedAt, result);
  }

  /**
   * `true` when `connector` was unregistered (or replaced) while its `sync()` was running. Such a
   * run records NOTHING after it — no telemetry, no health transition, no notification, no success
   * hook — so a removed connector's purged health row is never re-inserted and its owner is never
   * told a connector they just removed "lost authentication". Any force waiter is settled.
   */
  private wasWithdrawnMidRun(job: Job, connector: Syncable): boolean {
    if (this.connectors.get(job.serviceId) === connector) return false;
    this.settleJob(job, new Error("Connector removed"));
    return true;
  }
}
