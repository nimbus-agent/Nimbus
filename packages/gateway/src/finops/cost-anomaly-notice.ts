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

export interface CostAnomalyNoticeDeps {
  readonly db: Database;
  readonly config: () => NimbusFinopsToml;
  readonly now: () => number;
  /** The OS notification; a rejection or throw is swallowed here. */
  readonly notify: (title: string, body: string) => void | Promise<void>;
  readonly onFailure?: (err: unknown) => void;
  /** Test seam: replaces the index query. */
  readonly query?: typeof queryCostAnomalies;
}

/** The notice text: counts only. `serviceIds` are shown only when they look like a connector id. */
export function costAnomalyNoticeText(
  count: number,
  serviceIds: readonly string[],
): { title: string; body: string } {
  const shown = serviceIds.filter((s) => /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(s)).sort();
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
 * notice per `notifyMinIntervalMinutes`. An anomaly held back by the rate limit is not marked seen, so it is
 * announced by the first pass after the interval. Returns what happened, for tests and logs.
 */
export function createCostAnomalyNotice(
  deps: CostAnomalyNoticeDeps,
): () => "off" | "none" | "limited" | "sent" {
  const seen = new Set<string>();
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
      const fresh = result.anomalies.filter((a) => !seen.has(`${a.seriesKey}#${String(a.dayMs)}`));
      if (fresh.length === 0) return "none";
      if (lastAt !== undefined && at - lastAt < cfg.notifyMinIntervalMinutes * 60_000) {
        return "limited";
      }
      lastAt = at;
      for (const a of fresh) seen.add(`${a.seriesKey}#${String(a.dayMs)}`);
      if (seen.size > SEEN_CAP) {
        for (const k of seen) {
          seen.delete(k);
          if (seen.size <= SEEN_CAP / 2) break;
        }
      }
      // result.anomalies is capped; the true count of fresh ones is at least this.
      const { title, body } = costAnomalyNoticeText(fresh.length, [
        ...new Set(fresh.map((a) => serviceOfKey(a.seriesKey))),
      ]);
      void Promise.resolve(deps.notify(title, body)).catch((err: unknown) => deps.onFailure?.(err));
      return "sent";
    } catch (err) {
      deps.onFailure?.(err);
      return "none";
    }
  };
}
