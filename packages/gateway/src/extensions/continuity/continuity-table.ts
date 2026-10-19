import type { ExtensionRow } from "../../automation/extension-store.ts";
import { constantTimeStringEqual } from "../../util/timing-safe-compare.ts";
import type { ExtensionManifest } from "../manifest.ts";

/**
 * Binds a legacy bundled-connector service id to ONE signed extension. A binding
 * requires the extension id, the publisher key from the VERIFIED manifest, and the
 * extension row's `source_root_fingerprint` — never a registry's name.
 */
export interface ContinuityEntry {
  readonly legacyServiceId: string;
  readonly extensionId: string;
  /** Base64 Ed25519 publisher key. */
  readonly publisherKey: string;
  /** publisherKeyFingerprint of the official registry root key. */
  readonly sourceRootFingerprint: string;
  /** Credential name -> legacy Vault key. */
  readonly credentials: Readonly<Record<string, string>>;
  readonly expectedPermissions: {
    readonly network: readonly string[];
    readonly read: readonly string[];
    readonly write: readonly string[];
  };
  readonly itemTypes: readonly string[];
}

/** Empty in production until the cut-over PR fills it. */
export const CONTINUITY_TABLE: readonly ContinuityEntry[] = [];

export type ContinuityBindingInput = {
  readonly extensionId: string;
  readonly publisherKey: string | undefined;
  readonly sourceRootFingerprint: string | null | undefined;
};

function secureEq(a: string | null | undefined, b: string): boolean {
  if (a === undefined || a === null) return false;
  return constantTimeStringEqual(a, b);
}

/** All three of id, publisher key and root fingerprint must match (I10 compare). */
export function findContinuityBinding(
  ext: ContinuityBindingInput,
  table: readonly ContinuityEntry[] = CONTINUITY_TABLE,
): ContinuityEntry | undefined {
  for (const entry of table) {
    // Evaluate every comparison (no short-circuit between key/fingerprint checks).
    const idOk = ext.extensionId === entry.extensionId;
    const keyOk = secureEq(ext.publisherKey, entry.publisherKey);
    const fpOk = secureEq(ext.sourceRootFingerprint, entry.sourceRootFingerprint);
    if (idOk && keyOk && fpOk) return entry;
  }
  return undefined;
}

/** The ONE way to build binding input; `manifest` must be the verified manifest. */
export function bindingInputFor(
  row: ExtensionRow,
  manifest: ExtensionManifest,
): ContinuityBindingInput {
  return {
    extensionId: row.id,
    publisherKey: manifest.publisher?.key,
    sourceRootFingerprint: row.source_root_fingerprint,
  };
}

/** Returns human-readable problems; empty means the entries are consistent. */
export function validateContinuityEntries(
  entries: readonly ContinuityEntry[],
  catalogIds: readonly string[],
  vaultKeys: Readonly<Record<string, readonly string[]>>,
): string[] {
  const problems: string[] = [];
  for (const e of entries) {
    if (!catalogIds.includes(e.legacyServiceId)) {
      problems.push(`${e.legacyServiceId}: not a catalog service id`);
      continue;
    }
    const allowed = vaultKeys[e.legacyServiceId] ?? [];
    for (const [name, key] of Object.entries(e.credentials)) {
      if (!allowed.includes(key)) {
        problems.push(`${e.legacyServiceId}: credential ${name} maps to unknown vault key ${key}`);
      }
    }
  }
  return problems;
}
