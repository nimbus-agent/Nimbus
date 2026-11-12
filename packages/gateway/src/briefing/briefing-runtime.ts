import type { Database } from "bun:sqlite";
import { buildMorningBriefing } from "../agents/_lib/briefing-build.ts";
import { SECTION_SERVICES, serviceFreshness } from "../agents/_lib/briefing-queries.ts";
import type { ChatUnreadReader } from "../agents/_lib/briefing-types.ts";
import { nextFire } from "../automation/cron.ts";
import {
  type BriefingSection,
  effectiveBriefingZone,
  loadNimbusBriefingFromConfigDir,
  type NimbusBriefingToml,
} from "../config/briefing-toml.ts";
import { loadServiceConfigsOrEmpty } from "../config/service-configs.ts";
import type { BriefingReadyPayload } from "../ipc/gateway-events.ts";
import type { ToastOutcome } from "../platform/notifications/notifications-runtime.ts";
import { gatewayZone } from "../util/zoned-time.ts";
import { type BriefingRunRequest, type BriefingRunResult, runBriefing } from "./briefing-runner.ts";
import { BriefingScheduler } from "./briefing-scheduler.ts";
import {
  type BriefingRunSummary,
  type BriefingRunView,
  type BriefingStore,
  createBriefingStore,
} from "./briefing-store.ts";
import { scanDeadlines } from "./deadline-scan.ts";

/**
 * The morning briefing's runtime (Phase 10 MB5): the store, the single-flight run, the scheduler and the
 * read side the `briefing.*` IPC methods and `nimbus briefing` use. Built in `platform/assemble.ts`.
 *
 * Every sink is injected: `emit` (the `briefing.ready` gateway event) and `toast` (`showWithOutcome`), so a
 * test substitutes recorders. On a demo-rooted gateway (I41) there is NO scheduler, so neither the briefing
 * tick nor the deadline scan exists; `runNow` still works over the demo index and shows no toast.
 */
export class BriefingBusyError extends Error {
  readonly code = "ERR_BRIEFING_BUSY";
  constructor() {
    super("A briefing is already being composed");
  }
}

export type BriefingRuntimeDeps = {
  readonly db: Database;
  readonly configDir: string;
  readonly now: () => number;
  /** The owner's person id, or `null` when it cannot be resolved. */
  readonly resolveSelf: () => Promise<string | null>;
  readonly emit: (payload: BriefingReadyPayload) => void;
  readonly toast: (title: string, body: string) => Promise<ToastOutcome>;
  /** The notification service's live `delivers` (for `status`). */
  readonly toastDelivers: () => boolean;
  readonly demo: boolean;
  /** The MB4 seam: unread Slack threads. Absent until MB4 wires it. */
  readonly readUnreadChat?: ChatUnreadReader;
  readonly loadConfig?: () => NimbusBriefingToml;
  readonly logger?: { warn(obj: Record<string, unknown>, msg: string): void };
};

export type BriefingSourceStatus = {
  readonly section: BriefingSection;
  readonly services: ReadonlyArray<{
    readonly id: string;
    readonly connected: boolean;
    readonly lastSyncMs: number | null;
  }>;
};

export type BriefingStatus = {
  readonly enabled: boolean;
  readonly schedule: string;
  readonly tz: string;
  readonly sections: readonly BriefingSection[];
  readonly retentionDays: number;
  readonly nextFireMs: number | null;
  readonly lastRun: BriefingRunSummary | null;
  readonly deadlines: {
    readonly enabled: boolean;
    readonly leadHours: number;
    readonly quietHours: number;
    readonly lastScanMs: number | null;
    readonly lastCandidateCount: number | null;
    readonly lastNoticeCount: number | null;
  };
  readonly sources: readonly BriefingSourceStatus[];
  readonly toastDelivers: boolean;
  readonly demo: boolean;
};

export interface BriefingRuntime {
  runNow(): Promise<BriefingRunView>;
  latest(): BriefingRunView | null;
  list(limit: number): BriefingRunSummary[];
  get(id: string): BriefingRunView | null;
  status(): BriefingStatus;
  /** `undefined` on a demo-rooted gateway. */
  readonly scheduler: BriefingScheduler | undefined;
  readonly store: BriefingStore;
}

type ScanState = { at: number | null; candidates: number | null; noticed: number | null };

export function createBriefingRuntime(deps: BriefingRuntimeDeps): BriefingRuntime {
  const store = createBriefingStore(deps.db);
  const loadConfig =
    deps.loadConfig ?? ((): NimbusBriefingToml => loadNimbusBriefingFromConfigDir(deps.configDir));
  const warn = (message: string): void => {
    deps.logger?.warn({ message }, "briefing config");
  };
  const scanState: ScanState = { at: null, candidates: null, noticed: null };
  let inFlight: Promise<BriefingRunResult | null> | undefined;

  const doFire = (req: BriefingRunRequest): Promise<BriefingRunResult | null> => {
    const run = (async () => {
      const cfg = loadConfig();
      const tz = effectiveBriefingZone(cfg);
      const selfPersonId = await deps.resolveSelf();
      const serviceConfigs = loadServiceConfigsOrEmpty(deps.configDir, warn).map((c) => ({
        serviceId: c.serviceId,
        pagerdutyServices: c.pagerdutyServices,
      }));
      return await runBriefing(
        {
          store,
          now: deps.now,
          build: (nowMs) =>
            buildMorningBriefing({
              db: deps.db,
              nowMs,
              tz,
              gatewayZone: gatewayZone(),
              sections: cfg.sections,
              selfPersonId,
              serviceConfigs,
              ...(deps.readUnreadChat === undefined ? {} : { readUnreadChat: deps.readUnreadChat }),
            }),
          retentionDays: () => cfg.retentionDays,
          emit: deps.emit,
          toast: deps.toast,
          onError: (e) => deps.logger?.warn({ err: String(e) }, "briefing run problem"),
        },
        req,
      );
    })().finally(() => {
      // Only the run that is still the current one clears the guard.
      if (inFlight === run) inFlight = undefined;
    });
    inFlight = run;
    return run;
  };

  /**
   * Resolves once no run is in flight. It re-checks after every wait (by recursing): another run may
   * have started in the gap before this callback resumed.
   */
  const waitUntilIdle = async (): Promise<void> => {
    const running = inFlight;
    if (running === undefined) return;
    await running.catch(() => {});
    await waitUntilIdle();
  };

  const runNow = async (): Promise<BriefingRunView> => {
    if (inFlight !== undefined) throw new BriefingBusyError();
    const result = await doFire({ firedBy: "manual", toast: !deps.demo });
    // A manual run has no slot, so the store cannot refuse it; the row was inserted a moment ago.
    if (result === null) throw new Error("the briefing run was not stored");
    return store.get(result.id) as BriefingRunView;
  };

  const scheduler = deps.demo
    ? undefined
    : new BriefingScheduler({
        store,
        now: deps.now,
        loadConfig,
        fire: async (req) => {
          // A scheduled slot waits for a run in flight rather than racing it.
          await waitUntilIdle();
          return await doFire(req);
        },
        scan: async (cfg) => {
          const nowMs = deps.now();
          const r = await scanDeadlines({
            db: deps.db,
            store,
            nowMs,
            tz: effectiveBriefingZone(cfg),
            cfg: cfg.deadlines,
            toast: deps.toast,
            onError: (e) => deps.logger?.warn({ err: String(e) }, "deadline scan problem"),
          });
          scanState.at = nowMs;
          scanState.candidates = r.candidates;
          scanState.noticed = r.noticed;
        },
        onError: (e) => deps.logger?.warn({ err: String(e) }, "briefing scheduler problem"),
      });

  const status = (): BriefingStatus => {
    const cfg = loadConfig();
    const tz = effectiveBriefingZone(cfg);
    const nowMs = deps.now();
    return {
      enabled: cfg.enabled,
      schedule: cfg.schedule,
      tz,
      sections: cfg.sections,
      retentionDays: cfg.retentionDays,
      nextFireMs: cfg.enabled ? (nextFire(cfg.schedule, tz, nowMs) ?? null) : null,
      lastRun: store.lastRun(),
      deadlines: {
        enabled: cfg.deadlines.enabled,
        leadHours: cfg.deadlines.leadHours,
        quietHours: cfg.deadlines.quietHours,
        lastScanMs: scanState.at,
        lastCandidateCount: scanState.candidates,
        lastNoticeCount: scanState.noticed,
      },
      sources: cfg.sections.map((section) => ({
        section,
        services: serviceFreshness(deps.db, SECTION_SERVICES[section]),
      })),
      toastDelivers: deps.toastDelivers(),
      demo: deps.demo,
    };
  };

  return {
    runNow,
    latest: () => store.latestOk(),
    list: (limit) => store.list(limit),
    get: (id) => store.get(id),
    status,
    scheduler,
    store,
  };
}
