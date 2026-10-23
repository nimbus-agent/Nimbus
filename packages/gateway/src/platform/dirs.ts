import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OWNER_ONLY_DIR_MODE, tightenToOwnerOnly } from "./owner-only-mode.ts";
import type { PlatformPaths } from "./paths.ts";

export function isWindowsNamedPipe(socketPath: string): boolean {
  return socketPath.toLowerCase().startsWith("\\\\.\\pipe\\");
}

export async function ensurePlatformDirectories(paths: PlatformPaths): Promise<void> {
  // The stores holding indexed content, logs and config: created 0700, and an existing directory
  // from an older install is tightened too. The socket directory is deliberately NOT in this list
  // — it can be a shared parent such as `/tmp`, whose mode is not ours to change.
  const ownerOnly = [paths.configDir, join(paths.configDir, "vault"), paths.dataDir, paths.logDir];
  const dirs = [
    paths.configDir,
    join(paths.configDir, "vault"),
    paths.dataDir,
    paths.logDir,
    paths.extensionsDir,
    paths.tempDir,
    paths.sandboxDir,
  ];
  if (!isWindowsNamedPipe(paths.socketPath)) {
    dirs.push(dirname(paths.socketPath));
  }
  for (const d of dirs) {
    await mkdir(d, { recursive: true, mode: OWNER_ONLY_DIR_MODE }); // NOSONAR S9382: fail-fast boot - the first directory that cannot be made stops the run before any later one is created, and its error is the one reported
  }
  for (const d of ownerOnly) {
    tightenToOwnerOnly(d);
  }
}
