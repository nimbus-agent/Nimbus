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
 * developer's real config. Only `configDir` moves — `dataDir` deliberately does
 * not, so this cannot silently repoint a live gateway's database. (The socket
 * has its own separate override, `socketPathOverride` below; a single variable
 * moving both would make a test-isolation mistake silently reroute live IPC.)
 *
 * An empty value is ignored rather than treated as a valid path: an unset-but-
 * exported variable is a very common shell accident, and honouring it would send
 * config to the process's working directory.
 */
function configDirOverride(): string | undefined {
  const v = processEnvGet("NIMBUS_CONFIG_DIR");
  return v !== undefined && v.length > 0 ? v : undefined;
}

/**
 * Relocate the IPC endpoint the gateway listens on.
 *
 * The CLI has honoured `NIMBUS_GATEWAY_SOCKET` for far longer than the gateway
 * did (`cli/src/paths.ts` `resolveSocketPath`). While only one side read it the
 * variable was a trap: a user who set it got a CLI dialling a socket the
 * gateway would never bind, so `nimbus start` sat in "Waiting for Gateway IPC"
 * for its full 60s timeout and then failed with the gateway process healthy but
 * unreachable. Both sides now resolve it the same way.
 *
 * Empty is ignored for the same reason as `configDirOverride` — an
 * exported-but-unset variable is a common shell accident, and honouring it here
 * would bind the socket to the process's working directory.
 */
function socketPathOverride(): string | undefined {
  const v = processEnvGet("NIMBUS_GATEWAY_SOCKET");
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
    socketPath: socketPathOverride() ?? String.raw`\\.\pipe\nimbus-gateway`,
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
    socketPath: socketPathOverride() ?? join(tmp, "nimbus-gateway.sock"),
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
    socketPath: socketPathOverride() ?? join(runtimeDir, "nimbus-gateway.sock"),
    extensionsDir: join(dataDir, "extensions"),
    tempDir: join(tmpdir(), "nimbus"),
  };
}
