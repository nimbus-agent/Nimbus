/**
 * IaC drift D2 (Phase 10, owner ruling OR-DRIFT-2): the opt-in scheduled drift check. OFF unless
 * `[iac.drift] schedule` holds a valid cron expression (`config/iac-drift-toml.ts`, no schedule under
 * five minutes). Ticks every 60 s on an injected clock and re-reads the config each tick; at a due fire it
 * checks every approved workdir in turn through the runner. A fire due while a check is still running is
 * skipped, never queued; missed fires (the gateway was down) are not caught up. `gateway-main.ts` never
 * builds it on a demo gateway (I41).
 */

import { nextFire } from "../automation/cron.ts";
import type { NimbusIacDriftToml } from "../config/iac-drift-toml.ts";
import type { IacDriftRunner } from "./drift-runner.ts";

export const DRIFT_TICK_MS = 60_000;

export interface IacDriftSchedulerDeps {
  readonly runner: Pick<IacDriftRunner, "check" | "running">;
  readonly config: () => NimbusIacDriftToml;
  readonly now: () => number;
  readonly onError?: (err: unknown) => void;
  readonly timers?: {
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
}

const REAL_TIMERS: NonNullable<IacDriftSchedulerDeps["timers"]> = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export class IacDriftScheduler {
  private handle: unknown;
  private nextAt: number | undefined;
  private key: string | undefined;
  private current: Promise<void> | undefined;

  constructor(private readonly deps: IacDriftSchedulerDeps) {}

  start(): void {
    if (this.handle !== undefined) return;
    const timers = this.deps.timers ?? REAL_TIMERS;
    this.handle = timers.setInterval(() => {
      void this.tick();
    }, DRIFT_TICK_MS);
  }

  /** The next fire this scheduler will act on (for tests and status), or `undefined` when off. */
  nextFireAt(): number | undefined {
    return this.nextAt;
  }

  /** One tick: arm, skip or run. Never throws; a failed run is reported through `onError`. */
  async tick(): Promise<void> {
    const now = this.deps.now();
    let cfg: NimbusIacDriftToml;
    try {
      cfg = this.deps.config();
    } catch (e) {
      this.deps.onError?.(e);
      return;
    }
    if (cfg.schedule === undefined) {
      this.nextAt = undefined;
      this.key = undefined;
      return;
    }
    const key = `${cfg.schedule}\u0000${cfg.tz}`;
    if (this.key !== key || this.nextAt === undefined) {
      this.key = key;
      this.nextAt = this.next(cfg, now);
      return;
    }
    if (now < this.nextAt) return;
    this.nextAt = this.next(cfg, now);
    if (this.current !== undefined || this.deps.runner.running()) return;
    this.current = this.deps.runner
      .check({ startedBy: "schedule" })
      .then(() => undefined)
      .catch((e: unknown) => this.deps.onError?.(e))
      .finally(() => {
        this.current = undefined;
      });
    await this.current;
  }

  private next(cfg: NimbusIacDriftToml, after: number): number | undefined {
    try {
      return cfg.schedule === undefined ? undefined : nextFire(cfg.schedule, cfg.tz, after);
    } catch (e) {
      this.deps.onError?.(e);
      return undefined;
    }
  }

  /** Stops ticking and waits for a running check. */
  async retire(): Promise<void> {
    if (this.handle !== undefined) {
      (this.deps.timers ?? REAL_TIMERS).clearInterval(this.handle);
      this.handle = undefined;
    }
    await this.current;
  }
}
