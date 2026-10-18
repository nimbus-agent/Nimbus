import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { Logger } from "pino";

import {
  type ExtensionRow,
  listExtensions,
  setExtensionEnabled,
} from "../automation/extension-store.ts";
import { parseExtensionManifestForRegistry, resolveExtensionManifestPath } from "./manifest.ts";
import type { SignatureDisableReason } from "./verify-signature.ts";

export const PRE_T2_DISABLE_REASON = "needs_reinstall_pre_t2" as const;

export function preT2DisableMessage(id: string, version: string): string {
  return (
    `Extension ${id} v${version} was installed before sandbox hardening (T2 PR 1, 2026-05-16).\n` +
    `Reinstall to enable: nimbus extension reinstall ${id}`
  );
}

/**
 * Crash recovery promotes a previous version's files but does not bless them: the extension stays
 * disabled, with no tree digest, until the owner adopts the bytes with `extension rehash`. In-memory
 * like its siblings, so after a restart the row reads as a plain disabled one.
 */
export const RECOVERED_PENDING_REHASH_REASON = "recovered_pending_rehash" as const;

export function recoveredPendingRehashMessage(id: string, version: string): string {
  return (
    `Extension ${id} was recovered to v${version} from a previous version after an interrupted update, ` +
    `and is disabled until you approve those files: nimbus extension rehash ${id}`
  );
}

class RecoveredPendingRehashRegistry {
  private readonly ids = new Set<string>();

  reset(): void {
    this.ids.clear();
  }

  mark(id: string): void {
    this.ids.add(id);
  }

  unmark(id: string): void {
    this.ids.delete(id);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }
}

export const recoveredPendingRehashRegistry = new RecoveredPendingRehashRegistry();

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
    return [...this.ids].sort((a, b) => a.localeCompare(b));
  }

  count(): number {
    return this.ids.size;
  }
}

export const preT2DisabledRegistry = new PreT2DisabledRegistry();

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
    return false;
  }
}

export interface HardDisablePreT2Options {
  db: Database;
  logger?: Logger;
}

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

export function preT2DisabledCount(): number {
  return preT2DisabledRegistry.count();
}

export function preT2DisabledIds(): readonly string[] {
  return preT2DisabledRegistry.list();
}

class SignatureDisabledRegistry {
  private readonly reasons = new Map<string, SignatureDisableReason>();

  reset(): void {
    this.reasons.clear();
  }

  mark(id: string, reason: SignatureDisableReason): void {
    this.reasons.set(id, reason);
  }

  has(id: string): boolean {
    return this.reasons.has(id);
  }

  reasonFor(id: string): SignatureDisableReason | undefined {
    return this.reasons.get(id);
  }

  list(): readonly { id: string; reason: SignatureDisableReason }[] {
    return [...this.reasons.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, reason]) => ({ id, reason }));
  }

  count(): number {
    return this.reasons.size;
  }
}

export const signatureDisabledRegistry = new SignatureDisabledRegistry();

/**
 * Per-reason remediation for an extension the startup signature pass hard-disabled (I16).
 *
 * The remedies are genuinely different, which is why this is an exhaustive switch and not one
 * generic "reinstall it" line: `publisher_key_*` means the KEY could not be resolved or no longer
 * matches, and re-fetching it from the registry is the fix; `signature_*` means the bytes on disk
 * no longer match what was signed, and no key will make that verify.
 *
 * The wording deliberately never says the user disabled it — that is the exact ambiguity this
 * message exists to remove.
 */
export function signatureDisableMessage(
  id: string,
  version: string,
  reason: SignatureDisableReason,
): string {
  const head = `Extension ${id} v${version} failed signature verification at startup (${reason}) and was disabled.`;
  const remedy: Record<SignatureDisableReason, string> = {
    publisher_key_missing: `No publisher key is cached for it. Reinstall it with the publisher's key: nimbus extension install <path> --publisher-key <path>`,
    publisher_key_mismatch: `The cached publisher key does not match the key this manifest was signed with — the publisher may have rotated keys. Nimbus never replaces a cached key on its own; if you trust the new key, remove the extension and reinstall it with that key: nimbus extension install <path> --publisher-key <path>`,
    signature_failed: `The manifest does not match its signature: the files on disk have changed since it was signed. Reinstall from a source you trust: nimbus extension install <path>`,
    signature_malformed: `The manifest's signature field is not a well-formed Ed25519 signature. Reinstall from a source you trust: nimbus extension install <path>`,
  };
  return `${head}\n${remedy[reason]}`;
}
