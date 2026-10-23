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
  /**
   * The name the owner knows the service by ("Readwise"), used in the migration prompt and the
   * paused reasons. Absent means the legacy service id is shown instead.
   */
  readonly displayName?: string;
}

/**
 * The legacy bundled connectors bound to a signed extension. `sourceRootFingerprint` is a literal
 * (pinned against `publisherKeyFingerprint(BUILTIN_REGISTRY.rootKey)` by a test) so this module
 * does not import the registry code.
 */
export const CONTINUITY_TABLE: readonly ContinuityEntry[] = [
  {
    legacyServiceId: "readwise",
    extensionId: "com.nimbus.readwise",
    publisherKey: "wrUu5uyn3aS2efQOEAUd1eC6H3uqX/RwzIEqQHvAZ9A=",
    sourceRootFingerprint: "6fb9beb2cf6bdc748c72c03b30b83a9a",
    // audit-ignore-next-line D11-vault-key (legacy key a binding maps from, not a vault-key construction)
    credentials: { token: "readwise.token" },
    expectedPermissions: { network: ["readwise.io"], read: [], write: [] },
    itemTypes: ["highlight", "book"],
    displayName: "Readwise",
  },
];

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
  const seenExtensionIds = new Set<string>();
  for (const e of entries) {
    if (seenExtensionIds.has(e.extensionId)) {
      problems.push(`${e.legacyServiceId}: duplicate extensionId ${e.extensionId}`);
    }
    seenExtensionIds.add(e.extensionId);
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
