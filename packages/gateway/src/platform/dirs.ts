import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PlatformPaths } from "./paths.ts";

export function isWindowsNamedPipe(socketPath: string): boolean {
  return socketPath.toLowerCase().startsWith("\\\\.\\pipe\\");
}

export async function ensurePlatformDirectories(paths: PlatformPaths): Promise<void> {
  const dirs = [
    paths.configDir,
    join(paths.configDir, "vault"),
    paths.dataDir,
    paths.logDir,
    paths.extensionsDir,
    paths.tempDir,
  ];
  if (!isWindowsNamedPipe(paths.socketPath)) {
    dirs.push(dirname(paths.socketPath));
  }
  for (const d of dirs) {
    await mkdir(d, { recursive: true }); // NOSONAR S9382: fail-fast boot - the first directory that cannot be made stops the run before any later one is created, and its error is the one reported
  }
}
