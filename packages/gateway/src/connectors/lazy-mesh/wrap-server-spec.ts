import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { selfSpawn } from "../../platform/runtime-layout.ts";
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
      NIMBUS_SANDBOX_MANIFEST_JSON: JSON.stringify(manifest),
      NIMBUS_SANDBOX_CWD: cwd,
    },
  };
}
