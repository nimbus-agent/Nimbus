import type { Database } from "bun:sqlite";

import type { NimbusIncidentToml } from "../config/incident-toml.ts";
import type { ServiceConfig } from "../metrics/dora-config.ts";
import { type AssembleOutcome, assembleOne } from "./assemble.ts";
import {
  selectChangedItemIds,
  selectNewItemIds,
  selectRefreshItemIds,
} from "./incident-selection.ts";
import { markRecordChecked } from "./incident-store.ts";
import { isTriggerService, type TriggerService } from "./trigger-sources.ts";

/**
 * The incident engine (Phase 10 IC3, design B). `trigger(serviceId)` runs after a sync of one of the five trigger
 * services; `assembleNow(triggerItemId)` assembles one item for `incident.assemble`, `nimbus incident show` and
 * the on-call push. THE deps type is the confinement (I57 (a)): it has no connector dispatcher, no executor, no
 * egress sink, no vault and no model handle, so nothing here can reach the network or post anything. The one
 * outward signal is the injected `emit` (`incident.assembled`: a record id, a version and a status, never a title).
 *
 * Single flight per service with one rerun, and single flight per trigger item: the pass and `assembleNow` go
 * through ONE function, so a call that lands while the same item is being assembled JOINS that work.
 */

export const PASS_CAP = 20;
export const FAILURE_BACKOFF_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

export type IncidentAssembledPayload = {
  readonly recordId: string;
  readonly version: number;
  readonly status: string;
};

export type EngineConfig = {
  readonly incident: NimbusIncidentToml;
  /** `[pagerduty] severity_p1_aliases`, which widen the PagerDuty default. */
  readonly pagerdutyP1Aliases: readonly string[];
};

export type IncidentEngineDeps = {
  readonly db: Database;
  readonly now: () => number;
  readonly emit: (payload: IncidentAssembledPayload) => void;
  readonly loadServiceConfigs: () => ReadonlyMap<string, ServiceConfig>;
  readonly readConfig: () => EngineConfig;
  /** A demo-rooted gateway runs no sync, so `trigger` is a no-op there (I41). */
  readonly demo: boolean;
  readonly logger: {
    readonly warn: (obj: Record<string, unknown>, msg: string) => void;
    readonly info?: (obj: Record<string, unknown>, msg: string) => void;
  };
  readonly yieldToEventLoop?: () => Promise<void>;
};

export type IncidentEngine = {
  /** Never rejects. Resolves when the pass (and its rerun, if any) is done. */
  readonly trigger: (serviceId: string) => Promise<void>;
  /** Assemble one trigger item now; joins an assembly of the same item already in flight. */
  readonly assembleNow: (triggerItemId: string) => Promise<AssembleOutcome>;
  /** Resolves when no pass is running. For tests and orderly shutdown. */
  readonly idle: () => Promise<void>;
};

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function createIncidentEngine(deps: IncidentEngineDeps): IncidentEngine {
  const yieldNow = deps.yieldToEventLoop ?? defaultYield;
  const inFlightItems = new Map<string, Promise<AssembleOutcome>>();
  const running = new Map<string, Promise<void>>();
  const rerun = new Set<string>();
  const failedAt = new Map<string, number>();

  /** The one assembly path: the pass and `assembleNow` both come through here. */
  const assembleShared = (itemId: string): Promise<AssembleOutcome> => {
    const pending = inFlightItems.get(itemId);
    if (pending !== undefined) return pending;
    const work = assembleOne(
      { db: deps.db, loadServiceConfigs: deps.loadServiceConfigs },
      itemId,
      deps.now(),
    )
      .then((outcome) => {
        if (outcome.outcome === "created" || outcome.outcome === "updated") {
          safeEmit(outcome);
        } else if (outcome.outcome === "missing") {
          markRecordChecked(deps.db, itemId, deps.now());
        }
        return outcome;
      })
      .finally(() => {
        inFlightItems.delete(itemId);
      });
    inFlightItems.set(itemId, work);
    return work;
  };

  function safeEmit(o: Extract<AssembleOutcome, { recordId: string }>): void {
    try {
      deps.emit({ recordId: o.recordId, version: o.version, status: o.status });
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "incident engine: emit failed");
    }
  }

  function candidates(service: TriggerService, cfg: EngineConfig, nowMs: number): string[] {
    const trig = {
      severities: cfg.incident.severities,
      bigeyeSlaStatuses: cfg.incident.bigeyeSlaStatuses,
      pagerdutyP1Aliases: cfg.pagerdutyP1Aliases,
    };
    const ids = [
      ...selectNewItemIds(deps.db, service, trig, nowMs - cfg.incident.lookbackDays * DAY_MS),
      ...selectRefreshItemIds(deps.db, service, PASS_CAP),
      ...selectChangedItemIds(deps.db, service, nowMs),
    ];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      const failed = failedAt.get(id);
      if (failed !== undefined && nowMs - failed < FAILURE_BACKOFF_MS) continue;
      seen.add(id);
      out.push(id);
      if (out.length === PASS_CAP) break;
    }
    return out;
  }

  async function sweep(ids: readonly string[]): Promise<string[]> {
    const changed: string[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i] as string;
      if (i > 0) await yieldNow();
      try {
        const o = await assembleShared(id);
        if (o.outcome === "created" || o.outcome === "updated") changed.push(id);
      } catch (err) {
        failedAt.set(id, deps.now());
        deps.logger.warn({ err: String(err), itemId: id }, "incident engine: assembly failed");
      }
    }
    return changed;
  }

  async function onePass(service: TriggerService): Promise<void> {
    const cfg = deps.readConfig();
    if (!cfg.incident.enabled) return;
    const changed = await sweep(candidates(service, cfg, deps.now()));
    // Concurrent records converge inside the pass: re-evaluate what this pass created or updated, once.
    if (changed.length >= 2) await sweep(changed);
  }

  async function loop(service: TriggerService): Promise<void> {
    do {
      rerun.delete(service);
      try {
        await onePass(service);
      } catch (err) {
        deps.logger.warn({ err: String(err), service }, "incident engine: pass failed");
      }
    } while (rerun.has(service));
  }

  return {
    trigger: (serviceId) => {
      if (deps.demo || !isTriggerService(serviceId)) return Promise.resolve();
      const active = running.get(serviceId);
      if (active !== undefined) {
        rerun.add(serviceId);
        return active;
      }
      const p = loop(serviceId).finally(() => {
        running.delete(serviceId);
      });
      running.set(serviceId, p);
      return p;
    },
    assembleNow: assembleShared,
    idle: async () => {
      await Promise.all([...running.values()]);
    },
  };
}
