import type { NimbusAnomalyToml } from "../config/anomaly-toml.ts";
import { AnomalyDetectorStub, type AnomalyNotification } from "./anomaly-detector.ts";

export type AnomalyNotifierDeps = {
  readonly config: NimbusAnomalyToml;
  /** A demo-rooted gateway (I41) sends none. */
  readonly demo: boolean;
  /** The OS notification (`showIgnoringFailure`); a rejection or throw is swallowed here too. */
  readonly notify: (title: string, body: string) => void | Promise<void>;
  readonly now: () => number;
  readonly onFailure?: (err: unknown) => void;
};

/** `sync:<metric>:<serviceId>` -> the connector id, only when it looks like one. */
function connectorOf(seriesId: string): string {
  const id = seriesId.split(":").slice(2).join(":");
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) ? id : "a connector";
}

/**
 * The notification: the connector name and one rounded number, never anything the connector
 * indexed (a toast shows on a locked or shared screen).
 */
export function anomalyNotificationText(event: Pick<AnomalyNotification, "seriesId" | "score">): {
  title: string;
  body: string;
} {
  const score = Number.isFinite(event.score) ? event.score.toFixed(1) : "many";
  return {
    title: "Nimbus",
    body: `Unusual sync activity on ${connectorOf(event.seriesId)} (${score} standard deviations from the usual)`,
  };
}

/** A per-connector rate-limited handler, or `undefined` when notifying is off. */
export function createAnomalyNotifyHandler(
  deps: AnomalyNotifierDeps,
): ((event: AnomalyNotification) => void) | undefined {
  if (!deps.config.notify || deps.demo) return undefined;
  const intervalMs = deps.config.minIntervalMinutes * 60_000;
  const lastAt = new Map<string, number>();
  return (event) => {
    try {
      if (event.score < deps.config.minScore) return;
      const connector = connectorOf(event.seriesId);
      const at = deps.now();
      const prev = lastAt.get(connector);
      if (prev !== undefined && at - prev < intervalMs) return;
      lastAt.set(connector, at);
      const { title, body } = anomalyNotificationText(event);
      void Promise.resolve(deps.notify(title, body)).catch((err: unknown) => deps.onFailure?.(err));
    } catch (err) {
      deps.onFailure?.(err);
    }
  };
}

/** The sync-telemetry detector `platform/assemble.ts` builds: always scores, notifies only if on. */
export function createSyncAnomalyDetector(
  deps: AnomalyNotifierDeps & { readonly logger: (e: AnomalyNotification) => void },
): AnomalyDetectorStub {
  const toast = createAnomalyNotifyHandler(deps);
  return new AnomalyDetectorStub({
    windowSize: 64,
    minScore: deps.config.minScore,
    onNotify: (e) => {
      deps.logger(e);
      toast?.(e);
    },
  });
}
