import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type ExtensionManifest,
  isStarterPack,
  parseExtensionManifestJson,
} from "@nimbus-dev/registry-format";

import type { ExtensionKind } from "../automation/extension-store.ts";

// The manifest model and parser live in the pure `@nimbus-dev/registry-format` workspace, shared
// with the publishing CLI; this module adds the filesystem half (which file a directory holds).
export {
  type ExtensionManifest,
  extensionEntryRelPath,
  parseExtensionManifestForRegistry,
  parseExtensionManifestJson,
} from "@nimbus-dev/registry-format";

export const EXTENSION_MANIFEST_FILENAME = "nimbus.extension.json";

export const EXTENSION_MANIFEST_FILENAME_LEGACY = "nimbus-extension.json";

export const EXTENSION_MANIFEST_FILENAMES = [
  EXTENSION_MANIFEST_FILENAME,
  EXTENSION_MANIFEST_FILENAME_LEGACY,
] as const;

export function resolveExtensionManifestPath(dir: string): string | undefined {
  for (const name of EXTENSION_MANIFEST_FILENAMES) {
    const p = join(dir, name);
    if (existsSync(p)) {
      return p;
    }
  }
  return undefined;
}

/**
 * The kind (V79 `extension.kind`) of the manifest installed in `dir`, read for a row whose bytes an
 * update or a recovery just replaced. Throws when `dir` holds no manifest.
 */
export function installedManifestKind(dir: string): ExtensionKind {
  return isStarterPack(readInstalledManifest(dir)) ? "starter-pack" : "extension";
}

/**
 * The `dependsOn` of the manifest installed in `dir` (undefined when it declares none), read for a
 * version restored from disk. Throws when `dir` holds no manifest.
 */
export function installedManifestDependsOn(dir: string): ExtensionManifest["dependsOn"] {
  return readInstalledManifest(dir).dependsOn;
}

function readInstalledManifest(dir: string): ExtensionManifest {
  const path = resolveExtensionManifestPath(dir);
  if (path === undefined) {
    throw new Error("extension manifest missing");
  }
  return parseExtensionManifestJson(readFileSync(path, "utf8"));
}
