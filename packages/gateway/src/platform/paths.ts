import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { processEnvGet } from "./env-access.ts";
import { PlatformInitError } from "./errors.ts";

export interface PlatformPaths {
  configDir: string;
  dataDir: string;
  logDir: string;
  socketPath: string;
  extensionsDir: string;
  tempDir: string;
}

/**
 * Test/CI seam for relocating the config directory.
 *
 * Exists because `createDarwinPaths()` reads `homedir()` with no env input at
 * all, so without this an isolated test on macOS would read and write the
 * developer's real config. Only `configDir` moves — `dataDir` and `socketPath`
 * deliberately do not, so this cannot silently repoint a live gateway's database
 * or make it listen somewhere unexpected.
 *
 * An empty value is ignored rather than treated as a valid path: an unset-but-
 * exported variable is a very common shell accident, and honouring it would send
 * config to the process's working directory.
 */
function configDirOverride(): string | undefined {
  const v = processEnvGet("NIMBUS_CONFIG_DIR");
  return v !== undefined && v.length > 0 ? v : undefined;
}

export function createWindowsPaths(): PlatformPaths {
  const appData = processEnvGet("APPDATA");
  const localAppData = processEnvGet("LOCALAPPDATA");
  if (appData === undefined || appData.length === 0) {
    throw new PlatformInitError(
      "APPDATA is not set. Nimbus requires a standard Windows user profile.",
    );
  }
  if (localAppData === undefined || localAppData.length === 0) {
    throw new PlatformInitError(
      "LOCALAPPDATA is not set. Nimbus requires a standard Windows user profile.",
    );
  }
  const configDir = configDirOverride() ?? join(appData, "Nimbus");
  const dataDir = join(localAppData, "Nimbus", "data");
  return {
    configDir,
    dataDir,
    logDir: join(dataDir, "logs"),
    socketPath: String.raw`\\.\pipe\nimbus-gateway`,
    extensionsDir: join(localAppData, "Nimbus", "extensions"),
    tempDir: join(tmpdir(), "nimbus"),
  };
}

export function createDarwinPaths(): PlatformPaths {
  const root = join(homedir(), "Library", "Application Support", "Nimbus");
  const configDir = configDirOverride() ?? root;
  const tmp = processEnvGet("TMPDIR") ?? "/tmp";
  return {
    configDir,
    dataDir: root,
    logDir: join(root, "logs"),
    socketPath: join(tmp, "nimbus-gateway.sock"),
    extensionsDir: join(root, "extensions"),
    tempDir: join(tmpdir(), "nimbus"),
  };
}

export function createLinuxPaths(): PlatformPaths {
  const home = homedir();
  const configRoot = processEnvGet("XDG_CONFIG_HOME") ?? join(home, ".config");
  const dataRoot = processEnvGet("XDG_DATA_HOME") ?? join(home, ".local", "share");
  const runtimeDir = processEnvGet("XDG_RUNTIME_DIR") ?? tmpdir();
  const configDir = configDirOverride() ?? join(configRoot, "nimbus");
  const dataDir = join(dataRoot, "nimbus");
  return {
    configDir,
    dataDir,
    logDir: join(dataDir, "logs"),
    socketPath: join(runtimeDir, "nimbus-gateway.sock"),
    extensionsDir: join(dataDir, "extensions"),
    tempDir: join(tmpdir(), "nimbus"),
  };
}
