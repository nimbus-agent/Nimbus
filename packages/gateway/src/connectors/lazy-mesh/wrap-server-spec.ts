import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { selfSpawn } from "../../platform/runtime-layout.ts";
import {
  policyFromManifest,
  SANDBOX_CWD_ENV,
  SANDBOX_POLICY_ENV,
} from "../../platform/sandbox/sandbox-policy.ts";
import type { ServerSpec } from "./slot.ts";

/**
 * I15: every connector ServerSpec passes through here, so the sandbox is not optional. The wrapper
 * runs as the `__nimbus-sandbox` role of this same executable — previously it was
 * `process.execPath` plus a path to sandbox-wrapper.ts, which does not exist in a compiled binary.
 */
export function wrapServerSpec(
  spec: ServerSpec,
  manifest: ExtensionManifest,
  cwd: string,
): ServerSpec {
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
