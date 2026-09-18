import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CliPlatformPaths } from "../paths.ts";

/**
 * MIRROR of `packages/gateway/src/platform/demo-root.ts` (invariant I41). The CLI may not import
 * gateway source; `scripts/parity/demo-root.parity.test.ts` fails when the two diverge — change
 * both or neither.
 */
export const DEMO_ENV = "NIMBUS_DEMO";
export const DEMO_DIRNAME = "demo";
export const DEMO_TEMP_DIRNAME = "nimbus-demo";

/** Lower-case; compared against a lower-cased path, matching the gateway's `isWindowsNamedPipe`. */
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";
const DEMO_UNIX_SOCKET_BASENAME = "nimbus-gateway-demo.sock";
const REAL_ROOT_OVERRIDES = ["NIMBUS_CONFIG_DIR", "NIMBUS_GATEWAY_SOCKET"] as const;

export type EnvReader = (name: string) => string | undefined;

export class DemoModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoModeError";
  }
}

export function demoModeRequested(get: EnvReader): boolean {
  const raw = get(DEMO_ENV);
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw !== "1") {
    throw new DemoModeError(`${DEMO_ENV} must be 1 or unset (got "${raw}").`);
  }
  for (const name of REAL_ROOT_OVERRIDES) {
    const v = get(name);
    if (v !== undefined && v.length > 0) {
      throw new DemoModeError(
        `${DEMO_ENV}=1 cannot be combined with ${name}: a demo process must never resolve a real config directory or socket. Unset ${name} and retry.`,
      );
    }
  }
  return true;
}

export function demoRootFor(realDataDir: string): string {
  return join(realDataDir, DEMO_DIRNAME);
}

export function demoSocketPathFor(realSocketPath: string, demoRoot: string): string {
  if (realSocketPath.toLowerCase().startsWith(WINDOWS_PIPE_PREFIX)) {
    const h = createHash("sha256").update(demoRoot, "utf8").digest("hex").slice(0, 12);
    return `${realSocketPath}-demo-${h}`;
  }
  return join(dirname(realSocketPath), DEMO_UNIX_SOCKET_BASENAME);
}

export function deriveDemoPaths(real: CliPlatformPaths): CliPlatformPaths {
  const root = demoRootFor(real.dataDir);
  const dataDir = join(root, "data");
  return {
    configDir: join(root, "config"),
    dataDir,
    logDir: join(dataDir, "logs"),
    socketPath: demoSocketPathFor(real.socketPath, root),
    extensionsDir: join(dataDir, "extensions"),
    tempDir: join(tmpdir(), DEMO_TEMP_DIRNAME),
    demo: true,
  };
}
