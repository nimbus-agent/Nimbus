import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionManifest } from "../../extensions/manifest.ts";
import type { ServerSpec } from "./slot.ts";

const WRAPPER_PATH = resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "platform",
  "sandbox",
  "sandbox-wrapper.ts",
);

export function wrapServerSpec(
  spec: ServerSpec,
  manifest: ExtensionManifest,
  cwd: string,
): ServerSpec {
  return {
    command: process.execPath,
    args: [WRAPPER_PATH, spec.command, ...spec.args],
    env: {
      ...spec.env,
      NIMBUS_SANDBOX_MANIFEST_JSON: JSON.stringify(manifest),
      NIMBUS_SANDBOX_CWD: cwd,
    },
  };
}

export const SANDBOX_WRAPPER_PATH = WRAPPER_PATH;
