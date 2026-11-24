// Phase 10 FinOps: the local notice of a new cost anomaly (D48: local index only, no network).
//
// The wiring (the OS notification, the timer, the config) is injected by `platform/assemble/finops-sidecars.ts`;
// this module only decides WHAT is new and WHEN one notice may be shown, and builds a text that carries counts and
// a service id, never a series name, an amount or any vendor string (a toast shows on a locked or shared screen).
import type { Database } from "bun:sqlite";
import type { NimbusFinopsToml } from "../config/finops-toml.ts";
import { type CostAnomalyResult, queryCostAnomalies } from "./cost-anomaly-query.ts";

/** A bounded memory of anomalies already announced: (series, day) keys. */
const SEEN_CAP = 2000;
/** Anomalies withheld by the rate limit, kept until a notice is accepted. */
const PENDING_CAP = 500;

export interface CostAnomalyNoticeDeps {
  readonly db: Database;
  readonly config: () => NimbusFinopsToml;
  readonly now: () => number;
  /**
   * The OS notification. A promise resolving to `false` (or rejecting) means it was NOT accepted: the anomalies stay
   * eligible for a later pass. Any other result counts as delivered.
   */
  readonly notify: (
    title: string,
    body: string,
  ) => undefined | boolean | Promise<boolean | undefined>;
  readonly onFailure?: (err: unknown) => void;
  /** Test seam: replaces the index query. */
  readonly query?: typeof queryCostAnomalies;
}

/** The notice text: counts only. `serviceIds` are shown only when they look like a connector id. */
export function costAnomalyNoticeText(
  count: number,
  serviceIds: readonly string[],
): { title: string; body: string } {
  const shown = serviceIds
    .filter((s) => /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(s))
    .sort((a, b) => a.localeCompare(b));
  const where = shown.length > 0 ? ` on ${shown.join(", ")}` : "";
  const what = count === 1 ? "1 unusual cost jump" : `${String(count)} unusual cost jumps`;
  return {
    title: "Nimbus",
    body: `${what}${where}. Run "nimbus cost anomalies" to see them.`,
  };
}

function serviceOfKey(seriesKey: string): string {
  return seriesKey.split("|", 1)[0] ?? "";
}

/**
 * One pass: judge the newest complete day, announce anomalies not announced before in ONE notice, at most one
 * notice per `notifyMinIntervalMinutes`. An anomaly held back by the rate limit is kept (bounded) until a notice
 * is accepted, so it is announced by the first pass after the interval even if the newest day has moved on. Returns what happened, for tests and logs.
 */
export function createCostAnomalyNotice(
  deps: CostAnomalyNoticeDeps,
): () => "off" | "none" | "limited" | "sent" {
  const seen = new Set<string>();
  const pending = new Map<string, string>();
  let lastAt: number | undefined;
  const query = deps.query ?? queryCostAnomalies;
  return () => {
    try {
      const cfg = deps.config();
      if (!cfg.notify) return "off";
      const at = deps.now();
      const result: CostAnomalyResult = query(deps.db, {
        nowMs: at,
        days: 1,
        thresholds: { ratio: cfg.anomalyRatio, minAmount: cfg.anomalyMinAmount },
      });
      for (const a of result.anomalies) {
        const k = `${a.seriesKey}#${String(a.dayMs)}`;
        if (!seen.has(k) && !pending.has(k)) pending.set(k, serviceOfKey(a.seriesKey));
      }
      // A withheld anomaly stays pending even after the newest complete day moves on, so it is announced by the
      // first pass after the interval (bounded: the oldest are dropped past PENDING_CAP).
      while (pending.size > PENDING_CAP) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      if (pending.size === 0) return "none";
      if (lastAt !== undefined && at - lastAt < cfg.notifyMinIntervalMinutes * 60_000) {
        return "limited";
      }
      const prevAt = lastAt;
      const announced = new Map(pending);
      const keys = [...announced.keys()];
      pending.clear();
      lastAt = at;
      for (const k of keys) seen.add(k);
      if (seen.size > SEEN_CAP) {
        for (const k of seen) {
          seen.delete(k);
          if (seen.size <= SEEN_CAP / 2) break;
        }
      }
      // result.anomalies is capped; the true count of fresh ones is at least this.
      const { title, body } = costAnomalyNoticeText(announced.size, [
        ...new Set(announced.values()),
      ]);
      const undo = (): void => {
        for (const [k, svc] of announced) {
          seen.delete(k);
          pending.set(k, svc);
        }
        if (lastAt === at) lastAt = prevAt;
      };
      void Promise.resolve(deps.notify(title, body)).then(
        (ok) => {
          if (ok === false) undo();
        },
        (err: unknown) => {
          undo();
          deps.onFailure?.(err);
        },
      );
      return "sent";
    } catch (err) {
      deps.onFailure?.(err);
      return "none";
    }
  };
}
