import { realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

import { processEnvGet } from "../../../platform/env-access.ts";
import type { PlatformPaths } from "../../../platform/paths.ts";
import { scanForGitEntry } from "../../connector-writes/iac-git-scan.ts";
import type { IacPathDeps } from "../../connector-writes/iac-grants.ts";
import type { UserMcpConnectorRow } from "../../user-mcp-store.ts";
import { iacProtectedRootsFor } from "../iac-runner.ts";
import { registeredWriteDirsOf } from "../user-mcp-write-deps.ts";

/** The filesystem facts the `enable iac` directory rule and the IaC runner read, built from the mesh's paths. */
export function buildIacPathDeps(
  paths: PlatformPaths,
  platform: NodeJS.Platform,
  listRowsNow: () => readonly UserMcpConnectorRow[],
): IacPathDeps {
  const iacStaticRoots = iacProtectedRootsFor(paths, platform, processEnvGet("XDG_RUNTIME_DIR"));
  return {
    platform,
    realpath: (p) => realpathSync.native(p),
    isDirectory: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    homeDir: homedir(),
    tmpDir: tmpdir(),
    // Nimbus's own folders: no approved Terraform directory may overlap them. Read at every use
    // (a getter), because the list also holds every user MCP server's WRITE directory (I15, AD5b):
    // a Terraform working directory inside one, or holding one, would let that server's code
    // rewrite what an apply runs. The user MCP rule refuses the same overlap from its side, so the
    // order of the two approvals cannot defeat either check.
    get protectedRoots(): readonly string[] {
      return [...iacStaticRoots, ...registeredWriteDirsOf(listRowsNow())];
    },
    gitScan: (dir) => scanForGitEntry(dir),
  };
}
