import { existsSync } from "node:fs";
import { join } from "node:path";

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
