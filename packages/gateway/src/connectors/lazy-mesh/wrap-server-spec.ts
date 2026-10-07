import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { selfSpawn } from "../../platform/runtime-layout.ts";
import { sandboxCwdFor } from "../../platform/sandbox/sandbox-cwd.ts";
import {
  policyFromManifest,
  SANDBOX_CWD_ENV,
  SANDBOX_POLICY_ENV,
} from "../../platform/sandbox/sandbox-policy.ts";
import type { ServerSpec } from "./slot.ts";

function wrapWithCwd(spec: ServerSpec, manifest: ExtensionManifest, cwd: string): ServerSpec {
  const { command, args } = selfSpawn("sandbox", [spec.command, ...spec.args]);
  return {
    command,
    args,
    env: {
      ...spec.env,
      [SANDBOX_POLICY_ENV]: JSON.stringify(policyFromManifest(manifest)),
      [SANDBOX_CWD_ENV]: cwd,
    },
  };
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
 * whose cwd is already a directory of its own — a generated tool runs in its script's directory.
 * Never pass `paths.dataDir` or `paths.configDir` here.
 */
export function wrapServerSpecInCwd(
  spec: ServerSpec,
  manifest: ExtensionManifest,
  cwd: string,
): ServerSpec {
  return wrapWithCwd(spec, manifest, cwd);
}
