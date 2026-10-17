import { realpathSync } from "node:fs";

import { resolveRuntimeById } from "../exec/exec-runtimes.ts";
import {
  type ExtensionRunGrantEnv,
  extensionRunGrantProtectedRoots,
} from "./extension-run-grants.ts";

/**
 * The ONE builder of the env an extension run grant is resolved against. `extension.approveRun`
 * (the IPC dispatcher) and the runtime's pre-spawn verifier (built in `platform/assemble.ts`) both
 * call it, so the grant the owner approved and the grant re-resolved before every spawn are
 * resolved identically — a drift between two copies would refuse every spawn as
 * `ERR_EXTENSION_RUN_CHANGED`, or worse, accept one the approval never resolved.
 *
 * `meshProtectedRoots` is the lazy mesh's user-MCP protected set (`[dataDir, configDir,
 * sandboxDir]`, `userMcpProtectedRootsFor`); the realpath is the native one user MCP uses
 * (`defaultUserMcpRealpath` is `realpathSync.native`).
 */
export function buildExtensionRunGrantEnv(
  meshProtectedRoots: readonly string[],
  extensionsDir: string | undefined,
): ExtensionRunGrantEnv {
  return {
    platform: process.platform,
    protectedRoots: extensionRunGrantProtectedRoots(meshProtectedRoots, extensionsDir),
    runtimeReadPaths: resolveRuntimeById("bun").requiredReadPaths(),
    realpath: realpathSync.native,
  };
}

/**
 * Whether this gateway runs approved extensions at all: the `[extensions] runtime` kill switch AND
 * not demo-rooted (I41 — a demo gateway is inert, so it gets no extension slot source). When false,
 * `extension approve` refuses `ERR_EXTENSION_RUNTIME_DISABLED` before any prompt.
 */
export function isExtensionRuntimeEnabled(
  cfg: { readonly runtime: boolean },
  paths: { readonly demo?: boolean },
): boolean {
  return cfg.runtime && paths.demo !== true;
}
