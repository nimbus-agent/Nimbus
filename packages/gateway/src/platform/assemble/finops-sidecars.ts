import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import { loadNimbusCostFromConfigDir } from "../../config/cost-toml.ts";
import { loadNimbusFinopsFromConfigDir } from "../../config/finops-toml.ts";
import { createCostAnomalyNotice } from "../../finops/cost-anomaly-notice.ts";
import { COST_FOLDER_INTERVAL_MS, createCostFolderPass } from "../../finops/cost-folder-watch.ts";
import { startFinopsRetention } from "../../finops/cost-retention.ts";
import { showWithOutcome } from "../notifications/notifications-runtime.ts";
import type { PlatformPaths } from "../paths.ts";
import type { NotificationService } from "../types.ts";

/** How often the gateway looks for a new cost anomaly (the sync itself runs every 6 hours). */
export const COST_NOTICE_INTERVAL_MS = 15 * 60_000;
/** The first watched-folder import waits this long after boot, so a large folder never slows startup. */
export const COST_FOLDER_FIRST_DELAY_MS = 60_000;

/**
 * The FinOps sidecars (Phase 10 FO2 retention, OR-FO-5; the cost anomaly notice): the daily row prune, and, only
 * when `[finops] notify = true` and the gateway is not demo-rooted (I41), a pass every 15 minutes that shows ONE
 * local, counts-only notice per new anomaly set. The config is re-read on every tick. The wiring lives here and not
 * in `finops/` because static rule D48 keeps that directory away from every notification and outbound module.
 *
 * Also on a non-demo gateway only: the watched FOCUS folder (`[cost.focus] dir`, Phase 7), imported a minute after
 * boot and then once a day, new or changed files only; the folder is re-read from the config on every pass.
 */
export function startFinopsSidecars(args: {
  readonly db: Database;
  readonly paths: PlatformPaths;
  readonly notifications: NotificationService;
  readonly logger: Logger;
  readonly sidecarStops: Array<() => void>;
  readonly intervalMs?: number;
  /** Test seam: the clock the notice reads. */
  readonly now?: () => number;
  /** Test seam: the delay before the first watched-folder pass. */
  readonly folderFirstDelayMs?: number;
}): void {
  const retention = startFinopsRetention(args.db, {
    retainDays: loadNimbusFinopsFromConfigDir(args.paths.configDir).retainDays,
  });
  args.sidecarStops.push(() => retention.stop());
  if (args.paths.demo === true) return;
  const folderPass = createCostFolderPass({
    db: args.db,
    dir: () => loadNimbusCostFromConfigDir(args.paths.configDir).focusDir,
    now: args.now ?? Date.now,
    onFile: (f) => {
      if (f.status === "refused")
        args.logger.warn({ file: f.name, error: f.error }, "cost folder import refused a file");
    },
    onFailure: (err) => args.logger.warn({ err }, "cost folder import failed"),
  });
  let folderTimer: ReturnType<typeof setInterval> | undefined;
  const folderStart = setTimeout(() => {
    folderPass();
    folderTimer = setInterval(folderPass, COST_FOLDER_INTERVAL_MS);
  }, args.folderFirstDelayMs ?? COST_FOLDER_FIRST_DELAY_MS);
  args.sidecarStops.push(() => {
    clearTimeout(folderStart);
    if (folderTimer !== undefined) clearInterval(folderTimer);
  });
  const pass = createCostAnomalyNotice({
    db: args.db,
    config: () => loadNimbusFinopsFromConfigDir(args.paths.configDir),
    now: args.now ?? Date.now,
    notify: async (title, body) =>
      (await showWithOutcome(args.notifications, title, body)) === "delivered",
    onFailure: (err) => args.logger.warn({ err }, "cost anomaly notice failed"),
  });
  pass();
  const timer = setInterval(pass, args.intervalMs ?? COST_NOTICE_INTERVAL_MS);
  args.sidecarStops.push(() => clearInterval(timer));
}
