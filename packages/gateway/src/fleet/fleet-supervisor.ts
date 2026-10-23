import type { Logger } from "pino";
import type { NimbusFleetJobToml, NimbusFleetToml } from "../config/fleet-toml.ts";
import type { FleetScheduler } from "./fleet-scheduler.ts";

/**
 * Owns the fleet's current {scheduler, config, jobs} and rebuilds the scheduler when the effective
 * `[fleet]` section changes (role-packs spec § 5.3), so a config edit applies without a restart.
 *
 * The layered-snapshot `version()` is compared BEFORE `load()`. Each tick the snapshot re-reads
 * the base, profile and pack files but re-merges only when one changed, so an idle gateway never
 * re-parses or re-resolves the fleet section. A version bump that leaves the fleet section
 * deep-equal (an edit elsewhere in the file) is not a reload.
 */

export const FLEET_RELOAD_CHECK_MS = 5_000;

export type FleetLoad = {
  /** Retention already floored by policy. */
  readonly config: NimbusFleetToml;
  readonly jobs: readonly NimbusFleetJobToml[];
  /** The loader logged it; the fleet is off. */
  readonly configError: boolean;
};

export type FleetView = {
  readonly scheduler: FleetScheduler | undefined;
  readonly config: NimbusFleetToml;
  readonly jobs: readonly NimbusFleetJobToml[];
};

export interface FleetSupervisorDeps {
  /** The layered snapshot's version. */
  readonly version: () => number;
  /** Never throws. */
  readonly load: () => FleetLoad;
  /** Undefined when the fleet should not run (configError, !enabled, no jobs). Not started. */
  readonly build: (load: FleetLoad) => FleetScheduler | undefined;
  readonly logger: Logger;
  /** Test seam; production uses FLEET_RELOAD_CHECK_MS. */
  readonly checkMs?: number;
}

export class FleetSupervisor {
  private view: FleetView;
  private loaded: FleetLoad;
  private lastVersion: number;
  private pending: Promise<"unchanged" | "reloaded"> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  /** `boot` is the load the caller already made (and pruned with), read AFTER `bootVersion`. */
  constructor(
    private readonly deps: FleetSupervisorDeps,
    boot: { readonly version: number; readonly load: FleetLoad },
  ) {
    this.lastVersion = boot.version;
    this.loaded = boot.load;
    const scheduler = deps.build(boot.load);
    scheduler?.start();
    this.view = { scheduler, config: boot.load.config, jobs: boot.load.jobs };
  }

  current(): FleetView {
    return this.view;
  }

  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.timer = setInterval(() => {
      void this.check();
    }, this.deps.checkMs ?? FLEET_RELOAD_CHECK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.view.scheduler?.stop();
  }

  check(): Promise<"unchanged" | "reloaded"> {
    if (this.pending !== undefined) return this.pending;
    const run = this.reload().finally(() => {
      this.pending = undefined;
    });
    this.pending = run;
    return run;
  }

  async settled(): Promise<void> {
    try {
      await this.pending;
    } catch {
      // reload() never rejects; this keeps settled() safe regardless.
    }
  }

  /** Never rejects. */
  private async reload(): Promise<"unchanged" | "reloaded"> {
    if (this.stopped) return "unchanged";
    // Set once the old scheduler is retired: from then on the view must not point at it.
    let oldRetired = false;
    try {
      const version = this.deps.version();
      if (version === this.lastVersion) return "unchanged";
      this.lastVersion = version;
      let next = this.deps.load();
      if (Bun.deepEquals(next, this.loaded)) return "unchanged";

      const old = this.view.scheduler;
      oldRetired = old !== undefined;
      await old?.retire();
      if (this.stopped) {
        this.view = { scheduler: undefined, config: next.config, jobs: next.jobs };
        return "unchanged";
      }

      // Catch up: an edit may have landed while the old scheduler drained. It is already retired,
      // so build from the latest load even if it now equals `this.loaded`.
      for (let v = this.deps.version(); v !== this.lastVersion; v = this.deps.version()) {
        this.lastVersion = v;
        next = this.deps.load();
      }

      let scheduler: FleetScheduler | undefined;
      try {
        scheduler = this.deps.build(next);
      } catch (err) {
        this.deps.logger.error({ err }, "[fleet] building the scheduler failed; the fleet is off");
      }
      scheduler?.start();
      this.view = { scheduler, config: next.config, jobs: next.jobs };
      this.loaded = next;
      this.deps.logger.info(
        `[fleet] config changed; reloaded (enabled=${next.config.enabled}, jobs=${next.jobs.length}, running=${scheduler !== undefined})`,
      );
      return "reloaded";
    } catch (err) {
      this.deps.logger.error({ err }, "[fleet] reload failed unexpectedly");
      if (oldRetired) {
        this.view = { scheduler: undefined, config: this.view.config, jobs: this.view.jobs };
      }
      return "unchanged";
    }
  }
}
