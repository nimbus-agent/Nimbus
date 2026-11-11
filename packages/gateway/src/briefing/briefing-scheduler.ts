import { effectiveBriefingZone, type NimbusBriefingToml } from "../config/briefing-toml.ts";
import type { BriefingRunRequest } from "./briefing-runner.ts";
import { planFire } from "./briefing-schedule.ts";
import { type BriefingStore, SlotTakenError } from "./briefing-store.ts";
import { pruneDeadlineNotices } from "./deadline-scan.ts";

/**
 * Fires the morning briefing on its schedule and runs the deadline scan (Phase 10 MB5, D-MB-2). A
 * self-contained scheduler in the shape of the workflow scheduler (a 60 s `unref`d interval, the first
 * tick at once = the startup catch-up, `start`/`stop`/`retire`, ticks never overlap) that shares no code
 * with it: a briefing is not a workflow, and nothing here can ask a person anything or run a step.
 *
 * Config is re-read EVERY tick (the layered reader is mtime-cached), so an edit applies without a restart.
 * The deadline scan is independent of `[briefing] enabled`.
 */
const DEFAULT_TICK_MS = 60_000;
export const DEADLINE_SCAN_EVERY_MS = 15 * 60_000;
export const PRUNE_EVERY_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type BriefingSchedulerDeps = {
  readonly store: BriefingStore;
  readonly now: () => number;
  readonly loadConfig: () => NimbusBriefingToml;
  /** Runs one briefing (the runtime wraps `runBriefing` and its single-flight guard). */
  readonly fire: (req: BriefingRunRequest) => Promise<unknown>;
  /** Runs one deadline scan for the config in force. */
  readonly scan: (cfg: NimbusBriefingToml) => Promise<unknown>;
  /** False on a demo-rooted gateway; the scheduler itself is not built there. */
  readonly toast?: boolean;
  readonly tickMs?: number;
  readonly onError?: (err: unknown) => void;
  /** Test seams standing in for the global timer functions. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
};

export class BriefingScheduler {
  private timer: unknown;
  /** The briefing lane and the scan lane run independently: a briefing that hangs never blocks a scan. */
  private briefingInFlight: Promise<void> | undefined;
  private scanInFlight: Promise<void> | undefined;
  private retired = false;
  private firstTick = true;
  /** In-memory: slots at or before this never fire (see `planFire`). `null` while disabled. */
  private baseline: number | null = null;
  private lastScanAt: number | null = null;
  private lastPruneAt: number | null = null;

  constructor(private readonly deps: BriefingSchedulerDeps) {}

  start(): void {
    if (this.timer !== undefined || this.retired) return;
    const ms = this.deps.tickMs ?? DEFAULT_TICK_MS;
    if (this.deps.setTimer !== undefined) {
      this.timer = this.deps.setTimer(() => void this.tick(), ms);
    } else {
      const handle = setInterval(() => void this.tick(), ms);
      handle.unref();
      this.timer = handle;
    }
    void this.tick();
  }

  stop(): void {
    if (this.timer !== undefined) {
      if (this.deps.clearTimer !== undefined) this.deps.clearTimer(this.timer);
      else clearInterval(this.timer as ReturnType<typeof setInterval>);
    }
    this.timer = undefined;
  }

  async retire(): Promise<void> {
    this.retired = true;
    this.stop();
    await Promise.all([this.briefingInFlight?.catch(() => {}), this.scanInFlight?.catch(() => {})]);
  }

  /**
   * One pass. The briefing and the deadline scan are separate lanes, each single-flight: a lane that is
   * still running is skipped (and not waited for), so a briefing that waits past a ticket's due time
   * cannot stop the scan that would have warned about it.
   */
  tick(): Promise<void> {
    if (this.retired) return Promise.resolve();
    let cfg: NimbusBriefingToml;
    try {
      cfg = this.deps.loadConfig();
    } catch (e) {
      this.report(e);
      return Promise.resolve();
    }
    const now = this.deps.now();
    const lanes: Promise<void>[] = [];
    if (this.briefingInFlight === undefined) {
      const run = this.briefingPart(cfg, now).finally(() => {
        this.briefingInFlight = undefined;
      });
      this.briefingInFlight = run;
      lanes.push(run);
    }
    this.firstTick = false;
    if (this.scanInFlight === undefined) {
      const run = this.scanLane(cfg, now).finally(() => {
        this.scanInFlight = undefined;
      });
      this.scanInFlight = run;
      lanes.push(run);
    }
    return Promise.all(lanes).then(() => undefined);
  }

  private report(err: unknown): void {
    this.deps.onError?.(err);
  }

  private async scanLane(cfg: NimbusBriefingToml, now: number): Promise<void> {
    await this.deadlinePart(cfg, now);
    this.pruneIfDue(cfg, now);
  }

  private async briefingPart(cfg: NimbusBriefingToml, now: number): Promise<void> {
    if (!cfg.enabled) {
      this.baseline = null;
      return;
    }
    try {
      if (this.baseline === null) {
        // A restart catches up the last missed slot; a first-ever start or a fresh enable invents no history.
        this.baseline = this.firstTick ? (this.deps.store.lastSlotAt() ?? now) : now;
      }
      const plan = planFire({
        schedule: cfg.schedule,
        tz: effectiveBriefingZone(cfg),
        nowMs: now,
        baselineMs: this.baseline,
        lastSlotAt: this.deps.store.lastSlotAt(),
      });
      if (plan.kind === "run") {
        await this.deps.fire({
          firedBy: "schedule",
          slotAt: plan.slotAt,
          toast: this.deps.toast ?? true,
        });
      } else if (plan.kind === "skip") {
        this.recordSkip(plan.slotAt, plan.reason, now);
      }
    } catch (e) {
      this.report(e);
    }
  }

  private recordSkip(slotAt: number, reason: string, now: number): void {
    try {
      this.deps.store.insertRun({
        firedAt: now,
        firedBy: "schedule",
        status: "skipped",
        headline: reason,
        slotAt,
      });
    } catch (e) {
      if (!(e instanceof SlotTakenError)) throw e;
    }
  }

  private async deadlinePart(cfg: NimbusBriefingToml, now: number): Promise<void> {
    if (!cfg.deadlines.enabled) return;
    if (this.lastScanAt !== null && now - this.lastScanAt < DEADLINE_SCAN_EVERY_MS) return;
    this.lastScanAt = now;
    try {
      await this.deps.scan(cfg);
    } catch (e) {
      this.report(e);
    }
  }

  private pruneIfDue(cfg: NimbusBriefingToml, now: number): void {
    if (this.lastPruneAt !== null && now - this.lastPruneAt < PRUNE_EVERY_MS) return;
    this.lastPruneAt = now;
    try {
      this.deps.store.pruneRuns(now - cfg.retentionDays * DAY_MS);
      pruneDeadlineNotices(this.deps.store, now);
    } catch (e) {
      this.report(e);
    }
  }
}
