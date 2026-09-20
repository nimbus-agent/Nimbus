import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import { type SpawnCaptureResult, spawnCapture } from "../../platform/spawn-capture.ts";

/** Bounds every detection/adoption CLI call; a CLI blocked on a prompt must not hang the gateway. */
export const LOCAL_AUTH_CLI_TIMEOUT_MS = 10_000;

/**
 * Spawns `argv` with `extensionProcessEnv(extraEnv)` (I1). `extraEnv` is ONLY `cliEnvFor(...)`
 * output or an explicit `KUBECONFIG`; never a credential.
 */
export type RunCli = (
  argv: readonly string[],
  extraEnv: Record<string, string>,
) => Promise<SpawnCaptureResult>;

/** Everything a detector touches on the host, injected so each is a pure function under test. */
export interface LocalAuthHostDeps {
  readonly run: RunCli;
  /** The binary resolves on the gateway's PATH (`.cmd`/`.exe` included on Windows). */
  readonly which: (bin: string) => boolean;
  /** File text, or `null` when absent or unreadable. Never throws. */
  readonly readFile: (path: string) => string | null;
  readonly exists: (path: string) => boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
}

export function defaultLocalAuthHostDeps(): LocalAuthHostDeps {
  return {
    run: (argv, extraEnv) =>
      spawnCapture(argv, {
        env: extensionProcessEnv(extraEnv),
        timeoutMs: LOCAL_AUTH_CLI_TIMEOUT_MS,
      }),
    which: (bin) => Bun.which(bin) !== null,
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    exists: (path) => existsSync(path),
    env: process.env,
    platform: process.platform,
    homeDir: homedir(),
  };
}
