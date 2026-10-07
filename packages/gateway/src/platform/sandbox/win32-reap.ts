import type { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "pino";

import { BUNDLED_CONNECTORS } from "../../connectors/bundled-connector-registry.ts";
import {
  FIRST_PARTY_MANIFESTS,
  manifestForFirstParty,
} from "../../connectors/lazy-mesh/first-party-manifests.ts";
import { listUserMcpConnectors } from "../../connectors/user-mcp-store.ts";
import { type ReapOpts, reapOrphanedAppContainers } from "./orphan-reap.ts";
import { helperPath, helperRunner } from "./win32.ts";
import { buildRevokeGrantsArgv, buildSweepArgv } from "./win32-argv.ts";
import type { HelperRun } from "./win32-release.ts";

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

export const SANDBOX_CWD_MIGRATION_MARKER = "sandbox-cwd-migration-v1.done";

/**
 * Every policy id that may have left an inheritable ACE on `dataDir` while it was the shared
 * connector cwd. The filesystem MCP is excluded: it is still deliberately granted `dataDir`.
 */
export function legacyDataDirGrantIds(userMcpServiceIds: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const m of Object.values(FIRST_PARTY_MANIFESTS)) ids.add(m.id);
  for (const k of Object.keys(BUNDLED_CONNECTORS)) {
    ids.add(manifestForFirstParty(k).id);
    ids.add(manifestForFirstParty(k.replaceAll("-", "_")).id);
  }
  for (const s of userMcpServiceIds) ids.add(`user.${s}`);
  ids.delete("com.nimbus.filesystem");
  // Code-unit order, as the default sort gave; ids are unique (a Set), so no pair compares equal.
  return [...ids].sort((a, b) => (a < b ? -1 : 1));
}

/**
 * Revoke the stale per-SID ACEs on `dataDir`, once. Sequential on purpose: each revoke rewrites the
 * same DACL and concurrent rewrites race. The marker is written only when every revoke succeeded,
 * so a partial run is retried at the next boot.
 */
export async function revokeLegacyDataDirGrants(deps: {
  dataDir: string;
  ids: readonly string[];
  run: HelperRun;
  markerExists: () => boolean;
  writeMarker: () => void;
  logger: Pick<Logger, "info" | "warn">;
}): Promise<"skipped" | "done" | "partial"> {
  if (deps.markerExists()) return "skipped";
  const failed: string[] = [];
  for (const id of deps.ids) {
    try {
      const argv = buildRevokeGrantsArgv(
        { id, permissions: { network: [], filesystem: { read: [], write: [] } } },
        { cwd: deps.dataDir },
      );
      await deps.run(argv); // NOSONAR S9382: sequential on purpose (see above): concurrent DACL rewrites race
    } catch {
      failed.push(id);
    }
  }
  if (failed.length > 0) {
    deps.logger.warn(
      { failed },
      "sandbox: legacy data-directory grant revoke incomplete; will retry next boot",
    );
    return "partial";
  }
  deps.writeMarker();
  return "done";
}

/**
 * The host-touching seams of {@link revokeLegacyDataDirGrantsAtBoot}. Production supplies none and
 * gets {@link PRODUCTION_REVOKE_BOOT_SEAMS}; tests override any subset so the wrapper's body runs on
 * every OS, not only on Windows with a built helper.
 */
export interface RevokeBootSeams {
  platform: NodeJS.Platform;
  helperPath: () => string;
  helperExists: (helper: string) => boolean;
  helperRun: (helper: string) => HelperRun;
  listUserServiceIds: (db: Database) => string[];
  markerExists: (marker: string) => boolean;
  writeMarker: (marker: string) => void;
}

const PRODUCTION_REVOKE_BOOT_SEAMS: RevokeBootSeams = {
  platform: process.platform,
  helperPath,
  helperExists: existsSync,
  helperRun: helperRunner,
  listUserServiceIds: (db) => listUserMcpConnectors(db).map((r) => r.service_id),
  markerExists: existsSync,
  writeMarker: (marker) => writeFileSync(marker, new Date().toISOString()),
};

/** Boot wrapper: Windows-only, helper-gated, never rejects. */
export async function revokeLegacyDataDirGrantsAtBoot(deps: {
  db: Database;
  dataDir: string;
  logger: Logger;
  /** Test-only overrides; production passes none. */
  seams?: Partial<RevokeBootSeams>;
}): Promise<void> {
  const s: RevokeBootSeams = { ...PRODUCTION_REVOKE_BOOT_SEAMS, ...deps.seams };
  if (s.platform !== "win32") return;
  try {
    const helper = s.helperPath();
    if (!s.helperExists(helper)) return;
    let userIds: string[] = [];
    let listFailed = false;
    try {
      userIds = s.listUserServiceIds(deps.db);
    } catch (e) {
      listFailed = true;
      deps.logger.warn(
        { err: e },
        "sandbox: could not list user MCP ids; revoking first-party only",
      );
    }
    const marker = join(deps.dataDir, SANDBOX_CWD_MIGRATION_MARKER);
    const result = await revokeLegacyDataDirGrants({
      dataDir: deps.dataDir,
      ids: legacyDataDirGrantIds(userIds),
      run: s.helperRun(helper),
      markerExists: () => s.markerExists(marker),
      // A failed user listing means user-MCP SIDs were not revoked: withhold the marker so the
      // next boot retries with a working listing.
      writeMarker: () => {
        if (!listFailed) s.writeMarker(marker);
      },
      logger: deps.logger,
    });
    if (result === "done") {
      if (listFailed) {
        deps.logger.warn(
          "sandbox: migration marker withheld (user MCP listing failed); will retry next boot",
        );
      } else {
        deps.logger.info("sandbox: revoked legacy data-directory grants");
      }
    }
  } catch (e) {
    deps.logger.warn({ err: e }, "sandbox: legacy data-directory revoke failed (non-fatal)");
  }
}
