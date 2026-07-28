import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { envGet } from "./env.ts";

export type CliPlatformPaths = {
  configDir: string;
  dataDir: string;
  logDir: string;
  socketPath: string;
  extensionsDir: string;
  tempDir: string;
};

export function resolveSocketPath(): string {
  const envOverride = envGet("NIMBUS_GATEWAY_SOCKET");
  if (envOverride !== undefined && envOverride.length > 0) {
    return envOverride;
  }
  return defaultSocketPath();
}

function defaultSocketPath(): string {
  switch (process.platform) {
    case "win32":
      return String.raw`\\.\pipe\nimbus-gateway`;
    case "darwin": {
      const tmp = envGet("TMPDIR") ?? "/tmp";
      return join(tmp, "nimbus-gateway.sock");
    }
    default: {
      const runtimeDir = envGet("XDG_RUNTIME_DIR") ?? tmpdir();
      return join(runtimeDir, "nimbus-gateway.sock");
    }
  }
}

/**
 * Test/CI seam for relocating the config directory.
 *
 * Mirrors `configDirOverride()` in gateway/src/platform/paths.ts and MUST stay
 * in step with it: `nimbus init` writes nimbus.toml through this module while
 * the gateway reads it through that one, so a one-sided override would have the
 * CLI writing config the gateway never reads.
 *
 * Only `configDir` moves — `dataDir`, `socketPath`, and `extensionsDir`
 * deliberately do not, so this cannot silently repoint a live gateway's
 * database or socket.
 */
function configDirOverride(): string | undefined {
  const v = envGet("NIMBUS_CONFIG_DIR");
  return v !== undefined && v.length > 0 ? v : undefined;
}

export function getCliPlatformPaths(): CliPlatformPaths {
  switch (process.platform) {
    case "win32": {
      const appData = envGet("APPDATA");
      const localAppData = envGet("LOCALAPPDATA");
      if (appData === undefined || appData.length === 0) {
        throw new Error("APPDATA is not set. Nimbus requires a standard Windows user profile.");
      }
      if (localAppData === undefined || localAppData.length === 0) {
        throw new Error(
          "LOCALAPPDATA is not set. Nimbus requires a standard Windows user profile.",
        );
      }
      const configDir = configDirOverride() ?? join(appData, "Nimbus");
      const dataDir = join(localAppData, "Nimbus", "data");
      return {
        configDir,
        dataDir,
        logDir: join(dataDir, "logs"),
        socketPath: resolveSocketPath(),
        extensionsDir: join(localAppData, "Nimbus", "extensions"),
        tempDir: join(tmpdir(), "nimbus"),
      };
    }
    case "darwin": {
      const root = join(homedir(), "Library", "Application Support", "Nimbus");
      return {
        // NOT shorthand: darwin returns `root` for BOTH configDir and dataDir,
        // so the override must be applied to this property explicitly —
        // computing it and leaving `configDir: root` would be inert.
        configDir: configDirOverride() ?? root,
        dataDir: root,
        logDir: join(root, "logs"),
        socketPath: resolveSocketPath(),
        extensionsDir: join(root, "extensions"),
        tempDir: join(tmpdir(), "nimbus"),
      };
    }
    default: {
      const home = homedir();
      const configRoot = envGet("XDG_CONFIG_HOME") ?? join(home, ".config");
      const dataRoot = envGet("XDG_DATA_HOME") ?? join(home, ".local", "share");
      const configDir = configDirOverride() ?? join(configRoot, "nimbus");
      const dataDir = join(dataRoot, "nimbus");
      return {
        configDir,
        dataDir,
        logDir: join(dataDir, "logs"),
        socketPath: resolveSocketPath(),
        extensionsDir: join(dataDir, "extensions"),
        tempDir: join(tmpdir(), "nimbus"),
      };
    }
  }
}
