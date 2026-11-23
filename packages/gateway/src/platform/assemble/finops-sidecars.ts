import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import { loadNimbusFinopsFromConfigDir } from "../../config/finops-toml.ts";
import { createCostAnomalyNotice } from "../../finops/cost-anomaly-notice.ts";
import { startFinopsRetention } from "../../finops/cost-retention.ts";
import { showIgnoringFailure } from "../notifications/notifications-runtime.ts";
import type { PlatformPaths } from "../paths.ts";
import type { NotificationService } from "../types.ts";

/** How often the gateway looks for a new cost anomaly (the sync itself runs every 6 hours). */
export const COST_NOTICE_INTERVAL_MS = 15 * 60_000;

/**
 * The FinOps sidecars (Phase 10 FO2 retention, OR-FO-5; the cost anomaly notice): the daily row prune, and, only
 * when `[finops] notify = true` and the gateway is not demo-rooted (I41), a pass every 15 minutes that shows ONE
 * local, counts-only notice per new anomaly set. The config is re-read on every tick. The wiring lives here and not
 * in `finops/` because static rule D48 keeps that directory away from every notification and outbound module.
 */
export function startFinopsSidecars(args: {
  readonly db: Database;
  readonly paths: PlatformPaths;
  readonly notifications: NotificationService;
  readonly logger: Logger;
  readonly sidecarStops: Array<() => void>;
  readonly intervalMs?: number;
}): void {
  const retention = startFinopsRetention(args.db, {
    retainDays: loadNimbusFinopsFromConfigDir(args.paths.configDir).retainDays,
  });
  args.sidecarStops.push(() => retention.stop());
  if (args.paths.demo === true) return;
  const pass = createCostAnomalyNotice({
    db: args.db,
    config: () => loadNimbusFinopsFromConfigDir(args.paths.configDir),
    now: Date.now,
    notify: (title, body) => showIgnoringFailure(args.notifications, title, body),
    onFailure: (err) => args.logger.warn({ err }, "cost anomaly notice failed"),
  });
  pass();
  const timer = setInterval(pass, args.intervalMs ?? COST_NOTICE_INTERVAL_MS);
  args.sidecarStops.push(() => clearInterval(timer));
}
