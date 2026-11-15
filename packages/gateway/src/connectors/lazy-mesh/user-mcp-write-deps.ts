// packages/gateway/src/connectors/lazy-mesh/user-mcp-write-deps.ts
// The production facts the user MCP write-directory rule reads (I15; Phase 28 AD5b): the real file
// system, the gateway's own folders, the approved iac working directories and every registered
// server's code. Each list is read at the call, never cached, so a folder that became protected or
// a server registered since the grant refuses the next spawn.
import { lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter } from "node:path";

import type { PlatformPaths } from "../../platform/paths.ts";
import { scanWriteDir } from "../../platform/sandbox/write-dir-scan.ts";
import { pathApiFor } from "../../util/path-overlap.ts";
import type { UserMcpConnectorRow } from "../user-mcp-store.ts";
import type { WriteDirDeps } from "../write-dir-rules.ts";
import { iacProtectedRootsFor } from "./iac-runner.ts";

function stringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Every registered server's command directory and absolute arguments: the code a server is started
 * from. A write directory that is, holds or sits inside one would let a server change what runs
 * under that server's grants (its own included).
 */
export function serverCodePathsOf(
  rows: readonly UserMcpConnectorRow[],
  platform: NodeJS.Platform,
): string[] {
  const api = pathApiFor(platform);
  const out: string[] = [];
  for (const row of rows) {
    if (api.isAbsolute(row.command)) out.push(api.dirname(row.command));
    for (const arg of stringArray(row.args_json)) {
      if (api.isAbsolute(arg)) out.push(arg);
    }
  }
  return out;
}

/** The write directories of every registered server but `exceptServiceId`. */
export function registeredWriteDirsOf(
  rows: readonly UserMcpConnectorRow[],
  exceptServiceId?: string,
): string[] {
  return rows
    .filter((r) => r.service_id !== exceptServiceId)
    .flatMap((r) => stringArray(r.write_paths_json));
}

export interface ProductionWriteDirOptions {
  readonly paths: PlatformPaths;
  readonly platform: NodeJS.Platform;
  /** The registered servers, read at the call. */
  readonly listRows: () => readonly UserMcpConnectorRow[];
  /** The owner-approved iac working directories, read at the call. */
  readonly iacWorkdirs: () => readonly string[];
  /** One environment variable of the gateway process. */
  readonly env: (name: string) => string | undefined;
}

/**
 * The rule's facts for a spawn decision of an ALREADY-registered server (`serverCodePaths` covers
 * every row, its own included). A registration that is not stored yet adds its own code through
 * the resolver's own check.
 */
export function productionWriteDirDeps(o: ProductionWriteDirOptions): WriteDirDeps {
  const { paths, platform } = o;
  return {
    platform,
    realpath: (p) => realpathSync.native(p),
    lstat: (p) => lstatSync(p),
    exists: (p) => {
      try {
        lstatSync(p);
        return true;
      } catch {
        return false;
      }
    },
    homeDir: homedir(),
    tmpDir: tmpdir(),
    pathEntries: (o.env("PATH") ?? o.env("Path") ?? "").split(delimiter),
    appDataDirs:
      platform === "win32"
        ? [o.env("APPDATA"), o.env("LOCALAPPDATA")].filter(
            (d): d is string => d !== undefined && d !== "",
          )
        : [],
    // The iac list is the widest one Nimbus keeps (data, config, sandbox, extensions, temp, cache,
    // the iac root, the Linux runtime directory); the log folder is added because it can be
    // configured outside `dataDir`.
    protectedRoots: () => [
      ...iacProtectedRootsFor(paths, platform, o.env("XDG_RUNTIME_DIR")),
      paths.logDir,
    ],
    iacWorkdirs: o.iacWorkdirs,
    serverCodePaths: () => serverCodePathsOf(o.listRows(), platform),
    scan: (dir) => scanWriteDir(dir),
  };
}
