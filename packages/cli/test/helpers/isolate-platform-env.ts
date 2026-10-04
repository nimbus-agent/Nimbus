import { join } from "node:path";

/**
 * The environment `getCliPlatformPaths()` resolves the per-user directories from, plus the three
 * `NIMBUS_*` variables that redirect or refuse them.
 */
const KEYS = [
  "APPDATA",
  "LOCALAPPDATA",
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "NIMBUS_DEMO",
  "NIMBUS_CONFIG_DIR",
  "NIMBUS_GATEWAY_SOCKET",
] as const;

/**
 * Point every per-user directory `getCliPlatformPaths()` reads at `root` (which need not exist)
 * and clear the `NIMBUS_*` overrides; returns the function that restores the previous values.
 *
 * For a test that calls a command with its PRODUCTION deps on a path that should never reach the
 * gateway: if a regression ever sends it there anyway, the lookup lands in `root`, finds no
 * `gateway.json`, and fails as "not running" instead of finding a developer's live gateway.
 *
 * Stated bound: on macOS `os.homedir()` does not follow a `HOME` set in-process, so there the data
 * directory still resolves under the real home. This narrows a regression's reach; it is not a
 * substitute for the code under test refusing before it resolves any path.
 */
export function isolatePlatformEnv(root: string): () => void {
  const saved = new Map<string, string | undefined>(KEYS.map((k) => [k, process.env[k]]));
  process.env["APPDATA"] = join(root, "appdata");
  process.env["LOCALAPPDATA"] = join(root, "localappdata");
  process.env["HOME"] = join(root, "home");
  process.env["USERPROFILE"] = join(root, "home");
  process.env["XDG_CONFIG_HOME"] = join(root, "xdg-config");
  process.env["XDG_DATA_HOME"] = join(root, "xdg-data");
  delete process.env["NIMBUS_DEMO"];
  delete process.env["NIMBUS_CONFIG_DIR"];
  delete process.env["NIMBUS_GATEWAY_SOCKET"];
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}
