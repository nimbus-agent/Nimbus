import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  isStarterPack,
  parseExtensionManifestJson,
  type ExtensionManifest as RegistryExtensionManifest,
} from "@nimbus-dev/registry-format";

import type { ExtensionKind } from "../automation/extension-store.ts";

// The manifest model and parser live in the pure `@nimbus-dev/registry-format` workspace, shared
// with the publishing CLI; this module adds the filesystem half (which file a directory holds).
export {
  extensionEntryRelPath,
  parseExtensionManifestForRegistry,
  parseExtensionManifestJson,
} from "@nimbus-dev/registry-format";

/**
 * The registry-format manifest plus one gateway-only field. `ownerConfiguredNetwork` names the
 * `permissions.network` entries the OWNER typed (a stored connector URL, a `--net`), as opposed to
 * a default written in code or in a manifest. Only gateway code sets it, from the owner's
 * settings: the parser (`parseExtensionManifestJson`) builds its result field by field and never
 * reads it, so a manifest file cannot grant itself the label (I43: an extension's reach comes only
 * from its approved grants). It lives here, not in `registry-format`, because that package is
 * shared with the publishing CLI and the registry CI action.
 */
export type ExtensionManifest = RegistryExtensionManifest & {
  ownerConfiguredNetwork?: readonly string[];
  /**
   * True only for a manifest `manifestForFirstParty` built: its fixed hosts, and the hosts our code
   * derives, get the first-party address rules. Same provenance rule as above: the parser never
   * reads it, so a manifest file cannot claim it.
   */
  firstPartyPolicy?: boolean;
  /**
   * Wildcard host patterns (`*.sharepoint.com`) for a first-party tool that calls hosts no exact
   * list can name. Kept apart from `permissions.network` so the macOS and Windows runners, which
   * read only that list, can never see one. Set only from the table in `first-party-manifests.ts`;
   * the parser never reads it, so a manifest file, an extension or a user MCP server cannot claim
   * one (I43).
   */
  firstPartyWildcardHosts?: readonly string[];
};

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
