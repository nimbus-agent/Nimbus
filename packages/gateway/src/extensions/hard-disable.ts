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
