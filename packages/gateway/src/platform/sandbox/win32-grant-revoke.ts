// packages/gateway/src/platform/sandbox/win32-grant-revoke.ts
// A FAIL-CLOSED revoke of one AppContainer profile's explicit ACEs, run BEFORE a spawn re-grants.
//
// Why a second revoke beside `win32-release.ts`: `releaseGrantsFor` is best-effort by design (it
// runs from an exit listener, swallows every error and then deletes the profile). That is right
// for a per-run policy id and wrong for a spawn whose grant must SHRINK: the helper's
// `GRANT_ACCESS` merges rights into an existing ACE (`sandbox-helper-win32/main.c` `grant_path`),
// and an ACE outlives its child, so a profile that once held a write ACE on a path keeps writing it
// on every later read-only spawn unless that ACE is removed first. Here a failed removal throws,
// and the caller must refuse the spawn.
import { execFile } from "node:child_process";

import type { SandboxPolicy } from "./sandbox-policy.ts";
import { helperPath as defaultHelperPath } from "./win32.ts";
import { buildRevokeGrantsArgv } from "./win32-argv.ts";

/** Runs the helper with `argv` and resolves to its exit code; rejects only when it cannot run. */
export type HelperExitRun = (helperPath: string, argv: readonly string[]) => Promise<number>;

/** The slice of node's `execFile` {@link execHelperForExitCode} uses (injected by tests). */
export type ExecFileExitLike = (
  file: string,
  args: readonly string[],
  options: { windowsHide: boolean },
  callback: (error: (Error & { code?: unknown }) | null) => void,
) => unknown;

/**
 * Production {@link HelperExitRun}: the helper, hidden. A non-zero exit resolves to that code; an
 * error with no numeric exit code (the helper missing, a spawn failure) rejects.
 */
export function execHelperForExitCode(execFileImpl: ExecFileExitLike = execFile): HelperExitRun {
  return (path, argv) =>
    new Promise<number>((resolve, reject) => {
      execFileImpl(path, argv, { windowsHide: true }, (err) => {
        if (err === null) {
          resolve(0);
          return;
        }
        if (typeof err.code === "number") resolve(err.code);
        else reject(err);
      });
    });
}

/** Below the helper's own `MAX_RELEASE_PATHS` (256), so a long list is never a usage error. */
export const REVOKE_PATHS_PER_RUN = 128;

/**
 * Remove every explicit ACE the AppContainer of policy `policyId` (profile
 * `nimbus-ext-<policyId>`) holds on each of `paths`, through `buildRevokeGrantsArgv`. Throws when
 * any helper run exits non-zero or cannot run. A path that no longer exists is the helper's
 * success. No paths: nothing runs.
 */
export async function revokeAppContainerGrants(
  run: HelperExitRun,
  helperPath: string,
  policyId: string,
  paths: readonly string[],
): Promise<void> {
  for (let i = 0; i < paths.length; i += REVOKE_PATHS_PER_RUN) {
    const [first, ...rest] = paths.slice(i, i + REVOKE_PATHS_PER_RUN);
    if (first === undefined) return;
    const policy: SandboxPolicy = {
      id: policyId,
      permissions: { network: [], filesystem: { read: rest, write: [] } },
    };
    const code = await run(helperPath, buildRevokeGrantsArgv(policy, { cwd: first })); // NOSONAR S9382: each run rewrites DACLs; helper runs must not overlap
    if (code !== 0) {
      throw new Error(`revoking the ${policyId} sandbox grants failed (helper exit ${code})`);
    }
  }
}

/** A pre-spawn revoke for ONE policy id: `active` only on Windows, where ACEs outlive a child. */
export interface AppContainerGrantRevoker {
  readonly active: boolean;
  revoke(paths: readonly string[]): Promise<void>;
}

/**
 * The pre-spawn revoker for `policyId` on `platform`. Off win32 it is inert (`active: false`, and
 * `revoke` never runs anything): a bwrap bind and an SBPL profile exist only for the child's life.
 */
export function appContainerGrantRevokerFor(
  platform: NodeJS.Platform,
  policyId: string,
  opts: { readonly helperPath?: () => string; readonly run?: HelperExitRun } = {},
): AppContainerGrantRevoker {
  if (platform !== "win32") {
    return { active: false, revoke: () => Promise.resolve() };
  }
  const run = opts.run ?? execHelperForExitCode();
  const path = opts.helperPath ?? defaultHelperPath;
  return {
    active: true,
    revoke: (paths) => revokeAppContainerGrants(run, path(), policyId, paths),
  };
}
