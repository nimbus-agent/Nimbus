import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { isWindowsNamedPipe } from "./dirs.ts";
import { PlatformInitError } from "./errors.ts";
import type { PlatformPaths } from "./paths.ts";

/**
 * The demo root — a second, throwaway Nimbus inside `<realDataDir>/demo` (invariant I41).
 *
 * MIRRORED in `packages/cli/src/lib/demo-root.ts`: the CLI may not import gateway source, and the
 * two sides must resolve byte-identical demo paths or the CLI dials a gateway that is not there.
 * `scripts/parity/demo-root.parity.test.ts` fails when they diverge — change both or neither.
 */
export const DEMO_ENV = "NIMBUS_DEMO";
export const DEMO_DIRNAME = "demo";
export const DEMO_TEMP_DIRNAME = "nimbus-demo";

const DEMO_UNIX_SOCKET_PREFIX = "nimbus-gateway-demo";
/** A demo process honouring either of these would open the REAL config/Vault or dial the REAL gateway. */
const REAL_ROOT_OVERRIDES = ["NIMBUS_CONFIG_DIR", "NIMBUS_GATEWAY_SOCKET"] as const;

export type EnvReader = (name: string) => string | undefined;

/**
 * Whether this process is demo-rooted. Unset, `""` and `"0"` mean off and `"1"` means on; any other
 * value REFUSES rather than meaning "off", because a user who typed `NIMBUS_DEMO=true` believes they
 * left their real install and would otherwise be running against it.
 */
export function demoModeRequested(get: EnvReader): boolean {
  const raw = get(DEMO_ENV);
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw !== "1") {
    throw new PlatformInitError(`${DEMO_ENV} must be 1 or unset (got "${raw}").`);
  }
  for (const name of REAL_ROOT_OVERRIDES) {
    const v = get(name);
    if (v !== undefined && v.length > 0) {
      throw new PlatformInitError(
        `${DEMO_ENV}=1 cannot be combined with ${name}: a demo process must never resolve a real config directory or socket. Unset ${name} and retry.`,
      );
    }
  }
  return true;
}

export function demoRootFor(realDataDir: string): string {
  return join(realDataDir, DEMO_DIRNAME);
}

/**
 * The demo IPC endpoint. The suffix is a hash of the demo root on EVERY OS, so each demo root owns
 * its own endpoint and the CLI and gateway still agree: a Windows named pipe is MACHINE-global, so a
 * fixed name would let a process booted on temp roots (a test) reach a developer's live demo
 * gateway, and a unix socket's DIRECTORY can just as easily be shared by two demo roots (e.g. the
 * same `XDG_RUNTIME_DIR` with two different `XDG_DATA_HOME`s), so a fixed basename there would let
 * two demo gateways collide on one socket. Pipe detection reuses `dirs.ts`'s case-insensitive
 * `isWindowsNamedPipe`, the gateway's one definition of "is this a pipe".
 */
export function demoSocketPathFor(realSocketPath: string, demoRoot: string): string {
  const h = createHash("sha256").update(demoRoot, "utf8").digest("hex").slice(0, 12);
  if (isWindowsNamedPipe(realSocketPath)) {
    return `${realSocketPath}-demo-${h}`;
  }
  return join(dirname(realSocketPath), `${DEMO_UNIX_SOCKET_PREFIX}-${h}.sock`);
}

/** Every path relocated inside `<realDataDir>/demo`; no real path lies inside it (I41 clause 1). */
export function deriveDemoPaths(real: PlatformPaths): PlatformPaths {
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
