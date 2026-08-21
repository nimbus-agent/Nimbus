import type { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "pino";

import { FIRST_PARTY_MANIFESTS } from "../../connectors/lazy-mesh/first-party-manifests.ts";
import { type ReapOpts, reapOrphanedAppContainers } from "./orphan-reap.ts";
import { helperPath } from "./win32.ts";

/**
 * Every extension id that may legitimately own an AppContainer profile right now.
 *
 * The first-party ids come from the manifest table directly, not the database, so a broken
 * or unreadable `extension` table can only shrink this set (missing custom/installed
 * extensions), never empty it entirely. Combined with the fail-closed posture in
 * `reapAppContainersAtBoot` below — where a thrown `liveExtensionIds` call skips the reap
 * outright rather than reaping with a too-small set — a database read failure here can never
 * cause a live profile to be deleted.
 */
export function liveExtensionIds(db: Database): Set<string> {
  const ids = new Set<string>();
  for (const m of Object.values(FIRST_PARTY_MANIFESTS)) ids.add(m.id);
  const rows = db.query("SELECT id FROM extension").all() as ReadonlyArray<{ id: string }>;
  for (const r of rows) ids.add(r.id);
  return ids;
}

/** Injectable seam so the reap logic is testable without Windows. */
export function reapWith(opts: ReapOpts): Promise<string[]> {
  return reapOrphanedAppContainers(opts);
}

const run = promisify(execFile);

/**
 * Boot-time reap. Windows-only and best-effort: a failure here leaks registry state, which is
 * untidy, and must never prevent the gateway from starting.
 *
 * Every helper invocation is ASYNCHRONOUS on purpose. `spawnSync` would block the single JS
 * thread for the duration of each call, and the caller's `void` does not change that — an async
 * function's body runs synchronously up to its first real await, so a sync spawn inside it stalls
 * boot exactly as much as awaiting would. With `execFile` the first await yields immediately and
 * the reap genuinely proceeds in the background.
 *
 * Fail-closed on the live-set computation: `liveExtensionIds(deps.db)` runs inside the `try`
 * below, before `reapWith` enumerates or deletes anything. If it throws — an unreadable or
 * mid-migration `extension` table — the whole reap is skipped: nothing is enumerated, nothing is
 * deleted. The failure mode is reaping NOTHING, never reaping everything.
 */
export async function reapAppContainersAtBoot(deps: {
  db: Database;
  logger: Logger;
}): Promise<readonly string[]> {
  if (process.platform !== "win32") return [];
  const path = helperPath();
  try {
    const reaped = await reapWith({
      enumProfiles: async () => {
        try {
          const { stdout } = await run(path, ["--list-profiles"], { encoding: "utf8" });
          return stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
        } catch {
          return [];
        }
      },
      deleteProfile: async (name: string) => {
        try {
          await run(path, ["--delete-profile", name], { encoding: "utf8" });
          return true;
        } catch {
          // Best effort: one profile that will not delete must not abort the sweep. Reporting
          // false keeps it out of `reaped`, so the log line names only profiles really gone.
          return false;
        }
      },
      liveExtensionIds: liveExtensionIds(deps.db),
    });
    if (reaped.length > 0) deps.logger.info({ reaped }, "sandbox: reaped orphaned AppContainers");
    return reaped;
  } catch (e) {
    deps.logger.warn({ err: e }, "sandbox: AppContainer reap failed (non-fatal)");
    return [];
  }
}
