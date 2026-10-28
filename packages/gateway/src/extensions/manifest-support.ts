/**
 * What this gateway can honour of a parsed manifest. The registry format already accepts a shape
 * the install paths cannot act on yet — a starter pack (a package of dependencies with no code).
 * Every install and update door calls {@link assertManifestSupported} before the owner is asked
 * anything, so it is refused rather than installed as if it were something else. The refusal is
 * removed by the PR that implements starter packs.
 */
import {
  type DependencySpec,
  type ExtensionManifest,
  isStarterPack,
  RegistryError,
} from "@nimbus-dev/registry-format";

/** Every entry's range, whatever registry it names — for constraint checks, which compare versions only. */
export function rangesOf(
  dependsOn: Readonly<Record<string, DependencySpec>> | undefined,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [depId, spec] of Object.entries(dependsOn ?? {})) out[depId] = spec.range;
  return out;
}

/** Throws `RegistryError("ERR_EXTENSION_MANIFEST_UNSUPPORTED")` for a starter pack. */
export function assertManifestSupported(
  m: Pick<ExtensionManifest, "id" | "kind" | "dependsOn">,
): void {
  if (isStarterPack(m)) {
    throw new RegistryError(
      "ERR_EXTENSION_MANIFEST_UNSUPPORTED",
      `${m.id} is a starter pack; this Nimbus version cannot install starter packs yet`,
    );
  }
}
