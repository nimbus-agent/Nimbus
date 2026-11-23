import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import { selectExtensionInstallPath } from "../../automation/extension-store.ts";
import {
  ensureObservationDir,
  extensionObservationDirFor,
  extensionServiceIdOf,
  startObservationIngest,
} from "../../extensions/observation/observation-ingest.ts";
import {
  createObservationNotifier,
  observationFindingsFor,
} from "../../extensions/observation/observation-notifier.ts";
import { showIgnoringFailure } from "../notifications/notifications-runtime.ts";
import type { NotificationService } from "../types.ts";

/**
 * Project 6: the observation channel's directory, created owner-only before any extension can
 * spawn; then an ingest pass at boot and one every 60 s, stopped on shutdown, each followed by the
 * once-a-day notification when what it applied shows an extension went beyond what it
 * declared (`showIgnoringFailure`, so an unavailable service breaks nothing). The directory is the
 * gateway's own and is never added to a grant or to the runtime read paths. A directory that
 * cannot be created is logged, not fatal: the wrapper's writes then fail, which it swallows, and
 * nothing is observed.
 */
export function startExtensionObservation(
  db: Database,
  dataDir: string,
  logger: Logger,
  sidecarStops: Array<() => void>,
  notifications: NotificationService,
): string {
  let dir = extensionObservationDirFor(dataDir);
  try {
    dir = ensureObservationDir(dataDir);
  } catch (err) {
    logger.warn({ err }, "extension observation directory could not be created");
  }
  sidecarStops.push(
    startObservationIngest({
      db,
      dir,
      now: Date.now,
      isInstalled: (id) => selectExtensionInstallPath(db, id) !== null,
      serviceIdFor: (id) => extensionServiceIdOf(db, id),
      log: (m) => logger.warn(m),
      notifier: createObservationNotifier({
        db,
        now: Date.now,
        notify: (title, body) => showIgnoringFailure(notifications, title, body),
        findingsFor: (id, version) => observationFindingsFor(db, id, version),
        log: (m) => logger.warn(m),
      }),
    }),
  );
  return dir;
}
