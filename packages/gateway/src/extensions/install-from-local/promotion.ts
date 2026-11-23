import type { Database } from "bun:sqlite";
import {
  type ExtensionRow,
  isInstalledAsDependency,
  listExtensions,
  setInstalledAsDependency,
} from "../../automation/extension-store.ts";
import { sha256HexEqualConstantTime } from "../../util/timing-safe-compare.ts";
import type { ExtensionManifest } from "../manifest.ts";
import { getExtensionSource } from "../registry/registry-store.ts";
import { sha256HexOfBytes } from "./_shared.ts";
import type { InstallFromLocalOptions, PromotedInstallResult } from "./types.ts";

export function isPromotedInstall<T extends object>(
  r: T | PromotedInstallResult,
): r is PromotedInstallResult {
  return "promoted" in r && r.promoted === true;
}

/** The kind recorded for an installed package; "extension" when the row is absent or predates V79. */
export function installedKindOf(db: Database, id: string): "extension" | "starter-pack" {
  return listExtensions(db).find((r) => r.id === id)?.kind === "starter-pack"
    ? "starter-pack"
    : "extension";
}

/**
 * The installed row an explicit install may promote, or `undefined` when there is nothing to
 * promote (not installed, or installed explicitly): the caller then refuses exactly as before.
 */
export function installedDependencyRow(db: Database, id: string): ExtensionRow | undefined {
  const row = listExtensions(db).find((r) => r.id === id);
  return row !== undefined && isInstalledAsDependency(db, id) ? row : undefined;
}

/** Clears the dependency marker on `row`. The marker only decides what a later removal offers, so it needs no consent. */
export function promoteInstalledDependency(db: Database, row: ExtensionRow): PromotedInstallResult {
  setInstalledAsDependency(db, row.id, false);
  const source = getExtensionSource(db, row.id);
  return {
    id: row.id,
    version: row.version,
    promoted: true,
    ...(source === undefined ? {} : { sourceRegistry: source.registry, channel: source.channel }),
  };
}

/**
 * A local install promotes an installed dependency only when the folder holds the SAME package: the
 * same id, version and manifest bytes (`manifest_hash`). A different package that reuses the id is
 * not taken as the owner keeping the installed one: it is refused as already installed, before any
 * approval (see {@link assertNotAlreadyInstalledLocally}), and the marker stays. The plain local
 * install only: a registry-driven call has already refused an installed id before fetching.
 */
export function promotableLocalDependency(
  options: InstallFromLocalOptions,
  manifest: ExtensionManifest,
  manifestBytes: Buffer,
): ExtensionRow | undefined {
  if (options.registryPlan !== undefined || options.sourceRegistry !== undefined) return undefined;
  const row = installedDependencyRow(options.db, manifest.id);
  if (row?.version !== manifest.version) return undefined;
  return sha256HexEqualConstantTime(row.manifest_hash, sha256HexOfBytes(manifestBytes))
    ? row
    : undefined;
}

/**
 * A plain local install of an id that is already installed, and that did not qualify for promotion,
 * can only end refused (its install directory exists). Refuse it before solving and before the
 * owner is asked, rather than after an approval it could never use.
 */
export function assertNotAlreadyInstalledLocally(
  options: InstallFromLocalOptions,
  manifest: ExtensionManifest,
): void {
  if (options.registryPlan !== undefined || options.sourceRegistry !== undefined) return;
  const row = listExtensions(options.db).find((r) => r.id === manifest.id);
  if (row === undefined) return;
  throw new Error(
    `${row.id}@${row.version} is already installed; remove it first (nimbus extension remove ${row.id}) to reinstall it`,
  );
}
