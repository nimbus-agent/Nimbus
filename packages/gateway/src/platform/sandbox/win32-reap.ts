import type { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { Logger } from "pino";

import { FIRST_PARTY_MANIFESTS } from "../../connectors/lazy-mesh/first-party-manifests.ts";
import { type ReapOpts, reapOrphanedAppContainers } from "./orphan-reap.ts";
import { helperPath } from "./win32.ts";
import { buildSweepArgv } from "./win32-argv.ts";

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
 * Remove app-container ACEs whose SID no longer names anything from `paths`, via the helper's
 * `--sweep-orphaned-aces`. This repairs what the per-run release cannot: grants left by a gateway
 * that crashed mid-run, by generated tools whose profiles the reap just deleted, and the backlog
 * that accumulated before the release existed — measured at 1366 ACEs on one machine's runtime bin
 * dir, past the point where `SetEntriesInAclW` refuses and every confined spawn fails closed.
 *
 * Best-effort, like the reap. A helper that is not there has never confined anything, so it has no
 * grants to sweep and stays silent; any other failure is worth a warning, and changes nothing about
 * what the reap reports.
 */
async function sweepOrphanedAces(
  helper: string,
  paths: readonly string[],
  logger: Logger,
): Promise<void> {
  if (paths.length === 0 || !existsSync(helper)) return;
  try {
    const { stdout } = await run(helper, buildSweepArgv(paths), {
      encoding: "utf8",
      windowsHide: true,
    });
    const swept = parseSweepOutput(stdout).filter((s) => s.removed > 0);
    if (swept.length > 0) logger.info({ swept }, "sandbox: removed orphaned AppContainer ACEs");
  } catch (e) {
    logger.warn({ err: e }, "sandbox: orphaned ACE sweep failed (non-fatal)");
  }
}

/** Parse the helper's `removed <n> <path>` lines. The path is the rest of the line: it may contain spaces. */
export function parseSweepOutput(stdout: string): Array<{ path: string; removed: number }> {
  const out: Array<{ path: string; removed: number }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^removed (\d+) (.+)$/.exec(line);
    if (m !== null) out.push({ path: m[2] as string, removed: Number(m[1]) });
  }
  return out;
}

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
  /**
   * Directories to sweep for orphaned app-container ACEs after the reap — the runtime's required
   * read paths, which every exec and generated-tool spawn is granted and which outlive every run.
   * Supplied by the caller so this PAL module does not import the exec runtime registry.
   */
  sweepPaths?: readonly string[];
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
    // AFTER the reap, deliberately: deleting a profile does not remove the ACEs its SID holds, so
    // the profiles just reaped are exactly the ones whose grants are now orphaned.
    await sweepOrphanedAces(path, deps.sweepPaths ?? [], deps.logger);
    return reaped;
  } catch (e) {
    deps.logger.warn({ err: e }, "sandbox: AppContainer reap failed (non-fatal)");
    return [];
  }
}
