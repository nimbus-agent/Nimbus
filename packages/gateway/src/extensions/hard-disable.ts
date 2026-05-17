/**
 * T2 PR 1 (2026-05-16) — pre-sandbox hard-disable for legacy extensions.
 *
 * Extensions whose `nimbus.extension.json` carries the legacy `permissions:
 * string[]` array form predate T2 PR 1's sandbox hardening. They are refused
 * at registry-load time and the user is asked to reinstall.
 *
 * The detection MUST run on the raw JSON value, before the validator at
 * `permissions-validator.ts` silently normalizes the array form to
 * default-deny. {@link parseExtensionManifestForRegistry} captures that bit
 * at parse time; this module fans it out across the registry.
 *
 * Wired from `verifyExtensionsBestEffort` (`verify-extensions.ts`).
 */

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { Logger } from "pino";

import {
  type ExtensionRow,
  listExtensions,
  setExtensionEnabled,
} from "../automation/extension-store.ts";
import { parseExtensionManifestForRegistry, resolveExtensionManifestPath } from "./manifest.ts";

/** Sentinel string used by `nimbus extension list` + `nimbus extension info`. */
export const PRE_T2_DISABLE_REASON = "needs_reinstall_pre_t2" as const;

/**
 * Build the operator-facing reinstall message for an extension that was
 * installed before T2 PR 1's sandbox hardening. Locked verbatim by
 * `docs/superpowers/specs/2026-05-16-phase-5-t2-pr1-sandbox-design.md` §1.
 */
export function preT2DisableMessage(id: string, version: string): string {
  return (
    `Extension ${id} v${version} was installed before sandbox hardening (T2 PR 1, 2026-05-16).\n` +
    `Reinstall to enable: nimbus extension reinstall ${id}`
  );
}

/** In-memory set of extension ids that are hard-disabled with the pre-T2 reason. */
class PreT2DisabledRegistry {
  private readonly ids = new Set<string>();

  reset(): void {
    this.ids.clear();
  }

  mark(id: string): void {
    this.ids.add(id);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  list(): readonly string[] {
    // Locale-aware compare for stable, alphabetically-correct ordering
    // when the registry contains non-ASCII extension ids. The default
    // String#sort callback compares by UTF-16 code units (Sonar S6913).
    return [...this.ids].sort((a, b) => a.localeCompare(b));
  }

  count(): number {
    return this.ids.size;
  }
}

/**
 * Process-wide registry of pre-T2-disabled extension ids. The set is rebuilt
 * by {@link hardDisablePreT2Extensions}; `extension.list` and `diag.snapshot`
 * read from it. Singleton because the alternative (re-parsing every manifest
 * on every IPC call) is wasteful and the source-of-truth — the disk
 * manifest — only changes via install / remove / reinstall, all of which
 * already drive `verifyExtensionsBestEffort`.
 */
export const preT2DisabledRegistry = new PreT2DisabledRegistry();

/**
 * Inspect the on-disk manifest for `row`. Returns `true` iff the manifest
 * uses the legacy `permissions: string[]` array form. Missing manifest,
 * unreadable file, or JSON parse failure all return `false` — those failure
 * modes are handled by the existing verify-extensions pipeline and are not
 * the concern of the pre-T2 detector.
 */
function isPreT2LegacyManifest(row: ExtensionRow): boolean {
  const manifestPath = resolveExtensionManifestPath(row.install_path);
  if (manifestPath === undefined) return false;
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch {
    return false;
  }
  try {
    return parseExtensionManifestForRegistry(text).isPreT2Legacy;
  } catch {
    // Malformed manifest is a different failure class; leave it for
    // verifyOneExtension to surface.
    return false;
  }
}

export interface HardDisablePreT2Options {
  db: Database;
  logger?: Logger;
}

/**
 * Walk every row in the extension registry. For any row whose manifest is
 * in the legacy `permissions: string[]` shape, flip `enabled` to 0 and
 * record the id in {@link preT2DisabledRegistry}. Idempotent: an already-
 * disabled extension stays disabled and is still recorded so it surfaces
 * in `nimbus extension list --filter needs-reinstall`.
 *
 * The pre-T2 disable is structural — the row stays in the registry so the
 * user can reinstall in-place. Removal happens via `extension.remove`.
 */
export function hardDisablePreT2Extensions(opts: HardDisablePreT2Options): readonly ExtensionRow[] {
  preT2DisabledRegistry.reset();
  const disabled: ExtensionRow[] = [];
  for (const row of listExtensions(opts.db)) {
    if (!isPreT2LegacyManifest(row)) continue;
    preT2DisabledRegistry.mark(row.id);
    if (row.enabled === 1) {
      setExtensionEnabled(opts.db, row.id, false);
    }
    disabled.push(row);
    opts.logger?.warn(
      { extensionId: row.id, version: row.version },
      "extensions: hard-disabled pre-T2 extension (legacy permissions array); reinstall required",
    );
  }
  return disabled;
}

/** Count of currently-tracked pre-T2-disabled extensions. Used by `diag.snapshot`. */
export function preT2DisabledCount(): number {
  return preT2DisabledRegistry.count();
}

/** Ids of currently-tracked pre-T2-disabled extensions. Used by `extension.list`. */
export function preT2DisabledIds(): readonly string[] {
  return preT2DisabledRegistry.list();
}
