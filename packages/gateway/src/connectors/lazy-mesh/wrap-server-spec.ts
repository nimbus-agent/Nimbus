import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { selfSpawn } from "../../platform/runtime-layout.ts";
import { sandboxCwdFor } from "../../platform/sandbox/sandbox-cwd.ts";
import {
  declaresNetwork,
  isSandboxWrapperOnlyEnv,
  policyFromManifest,
  SANDBOX_CWD_ENV,
  SANDBOX_POLICY_ENV,
  sandboxWrapperOnlyEnv,
} from "../../platform/sandbox/sandbox-policy.ts";
import type { ServerSpec } from "./slot.ts";

function wrapWithCwd(
  spec: ServerSpec,
  manifest: ExtensionManifest,
  cwd: string,
  wrapperEnv: Readonly<Record<string, string>> = {},
): ServerSpec {
  const { command, args } = selfSpawn("sandbox", [spec.command, ...spec.args]);
  return {
    command,
    args,
    env: {
      ...spec.env,
      // A child with no network needs neither, so a no-network spawn keeps exactly the baseline env.
      ...(declaresNetwork(policyFromManifest(manifest)) ? sandboxWrapperOnlyEnv() : {}),
      ...wrapperEnv,
      [SANDBOX_POLICY_ENV]: JSON.stringify(policyFromManifest(manifest)),
      [SANDBOX_CWD_ENV]: cwd,
    },
  };
}

/** Refuses a key the wrapper would pass on: only what it strips from its child may ride here. */
function assertWrapperOnly(wrapperEnv: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(wrapperEnv)) {
    if (!isSandboxWrapperOnlyEnv(key)) {
      throw new Error(`wrapperEnv may carry only wrapper-only variables, not ${key}`);
    }
  }
}

/**
 * I15: every connector ServerSpec passes through here, so the sandbox is not optional. The wrapper
 * runs as the `__nimbus-sandbox` role of this same executable — previously it was
 * `process.execPath` plus a path to sandbox-wrapper.ts, which does not exist in a compiled binary.
 *
 * The working directory is a per-policy leaf (`sandboxCwdFor(sandboxRoot, manifest.id)`) under a
 * root that is never the data or config dir (spec § A); the sandbox wrapper creates it before spawn.
 */
export function wrapServerSpec(
  spec: ServerSpec,
  manifest: ExtensionManifest,
  sandboxRoot: string,
): ServerSpec {
  return wrapWithCwd(spec, manifest, sandboxCwdFor(sandboxRoot, manifest.id));
}

/**
 * `wrapServerSpec` with an EXACT working directory instead of a per-policy leaf. Only for a spawn
 * whose cwd is already a directory of its own — a generated tool runs in its script's directory,
 * an approved extension in its fresh per-spawn stage (I43). Never pass `paths.dataDir` or
 * `paths.configDir` here.
 *
 * `wrapperEnv` is for the WRAPPER, never the child: every key must be one the wrapper strips before
 * its child starts (`isSandboxWrapperOnlyEnv`), and any other key throws. An approved extension's
 * observation prefix and label ride here (I43), so the child never learns where its evidence goes.
 */
export function wrapServerSpecInCwd(
  spec: ServerSpec,
  manifest: ExtensionManifest,
  cwd: string,
  wrapperEnv?: Readonly<Record<string, string>>,
): ServerSpec {
  if (wrapperEnv !== undefined) assertWrapperOnly(wrapperEnv);
  return wrapWithCwd(spec, manifest, cwd, wrapperEnv);
}
