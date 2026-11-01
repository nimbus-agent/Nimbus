import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { SandboxPermissions } from "@nimbus-dev/registry-format";
import { listExtensions } from "../automation/extension-store.ts";
import { permissionsAfterUpdate } from "./auto-update-permissions-diff.ts";
import type { AvailableUpdate } from "./auto-update-types.ts";
import { previewFileGrants } from "./extension-file-preview.ts";
import {
  describeNetworkReach,
  type NetworkReachKind,
  type ReachRunner,
} from "./extension-reach.ts";
import type { ExtensionRunGrantEnv } from "./extension-run-grants.ts";
import { oneLine } from "./install-plan-text.ts";
import { parseExtensionManifestJson, resolveExtensionManifestPath } from "./manifest.ts";
import { prevVersionDir } from "./version-store.ts";

/** What an install or update approval needs to describe this machine: all of it optional but the home folder. */
export type ExtensionEvidenceDeps = {
  readonly sandbox?: ReachRunner;
  readonly grantEnv?: ExtensionRunGrantEnv;
  readonly homeDir: string;
};

export type AccessEvidence = {
  readonly networkReach: string;
  /** The kind of `networkReach`; `refused` means the sandbox here starts no child of this extension. */
  readonly reachKind: NetworkReachKind;
  readonly fileAccess: string;
  readonly canRunHere: boolean | null;
  readonly checked: boolean;
};

/** The wording an update approval carries when the installed manifest cannot be read. */
export const UNREADABLE_INSTALLED_TEXT =
  "not known here (the installed manifest could not be read)";

/**
 * Reach and the predicted file outcome for a set of permissions, from the same checks the run
 * approval makes. It describes; it never refuses, and it never throws: a preview that cannot be
 * made is stated as such.
 */
export function accessEvidence(
  deps: ExtensionEvidenceDeps | undefined,
  permissions: SandboxPermissions,
  installPath?: string,
): AccessEvidence {
  const reach = describeNetworkReach(deps?.sandbox, permissions.network);
  const networkReach = reach.text;
  const reachKind = reach.kind;
  try {
    const preview = previewFileGrants(permissions.filesystem, deps?.grantEnv, {
      ...(installPath === undefined ? {} : { installPath }),
      homeDir: deps?.homeDir ?? "",
    });
    // A sandbox that refuses every child here means the extension cannot run here, whatever its
    // paths say; otherwise the preview's own answer stands (null when a path was not checked).
    return {
      networkReach,
      reachKind,
      fileAccess: preview.text,
      canRunHere: reachKind === "refused" ? false : preview.canRunHere,
      checked: preview.checked,
    };
  } catch (e) {
    const why = e instanceof Error ? e.message : "unexpected failure";
    return {
      networkReach,
      reachKind,
      fileAccess: `not known here (${oneLine(why)})`,
      canRunHere: reachKind === "refused" ? false : null,
      checked: false,
    };
  }
}

/** The payload fields an install approval carries: `canRunHere` only when it is false. */
export function approvalFields(e: AccessEvidence): Record<string, unknown> {
  return {
    networkReach: e.networkReach,
    fileAccess: e.fileAccess,
    ...(e.canRunHere === false && { canRunHere: false }),
  };
}

function byCodeUnit(x: string, y: string): number {
  if (x < y) return -1;
  return x > y ? 1 : 0;
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])].sort(byCodeUnit);
}

function unionPermissions(a: SandboxPermissions, b: SandboxPermissions): SandboxPermissions {
  return {
    network: union(a.network, b.network),
    filesystem: {
      read: union(a.filesystem.read, b.filesystem.read),
      write: union(a.filesystem.write, b.filesystem.write),
    },
  };
}

function readPermissionsIn(dir: string): SandboxPermissions | undefined {
  const path = resolveExtensionManifestPath(dir);
  if (path === undefined) return undefined;
  return parseExtensionManifestJson(readFileSync(path, "utf8")).permissions;
}

/**
 * The evidence an update approval states. A forward update: the installed manifest's permissions
 * after the update's diff (sound, since the installed version is the one the diff was taken from),
 * together with what the added packages declare. A downgrade: the permissions the rollback target
 * declares on disk (`prev/<toVersion>`), never the diff, which does not mention the version
 * installed now. Undefined when the manifest needed cannot be read (the caller says so); it never
 * throws.
 */
export function updateAccessEvidence(
  db: Database,
  deps: ExtensionEvidenceDeps | undefined,
  cached: AvailableUpdate,
  addedUnion: SandboxPermissions | undefined,
  direction: "upgrade" | "downgrade",
  extensionsDir: string | undefined,
): AccessEvidence | undefined {
  try {
    const row = listExtensions(db).find((r) => r.id === cached.id);
    if (row === undefined) return undefined;
    if (direction === "downgrade") {
      if (extensionsDir === undefined) return undefined;
      const target = readPermissionsIn(prevVersionDir(extensionsDir, cached.id, cached.toVersion));
      return target === undefined ? undefined : accessEvidence(deps, target, row.install_path);
    }
    const before = readPermissionsIn(row.install_path);
    if (before === undefined) return undefined;
    const after = permissionsAfterUpdate(before, cached.permissionDiff);
    const all = addedUnion === undefined ? after : unionPermissions(after, addedUnion);
    return accessEvidence(deps, all, row.install_path);
  } catch {
    return undefined;
  }
}
