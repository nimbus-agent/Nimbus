/**
 * What this gateway can honour of a parsed manifest. The registry format already accepts two
 * shapes the install paths cannot act on yet — a dependency fetched from ANOTHER registry, and a
 * starter pack (a package of dependencies with no code). Every install and update door calls
 * {@link assertManifestSupported} before the owner is asked anything, so either shape is refused
 * rather than installed as if it were something else. Each refusal is removed by the PR that
 * implements the shape (cross-registry dependencies, then starter packs).
 */
import {
  type DependencySpec,
  type ExtensionManifest,
  isCrossRegistryDependency,
  isStarterPack,
  RegistryError,
} from "@nimbus-dev/registry-format";

function crossRegistryRefusal(id: string, depId: string): RegistryError {
  return new RegistryError(
    "ERR_EXTENSION_MANIFEST_UNSUPPORTED",
    `${id} depends on ${depId} from another registry; this Nimbus version cannot install cross-registry dependencies yet`,
  );
}

/**
 * Same-registry ranges keyed by id — the shape every consumer of `dependsOn` reads. Throws
 * `ERR_EXTENSION_MANIFEST_UNSUPPORTED` on a cross-registry entry, so a consumer that skipped the
 * guard still cannot read one as a same-registry range. `ownerId` names the dependent in that
 * refusal.
 */
export function dependencyRanges(
  dependsOn: Readonly<Record<string, DependencySpec>> | undefined,
  ownerId = "this extension",
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [depId, spec] of Object.entries(dependsOn ?? {})) {
    if (isCrossRegistryDependency(spec)) throw crossRegistryRefusal(ownerId, depId);
    out[depId] = spec.range;
  }
  return out;
}

/**
 * Throws `RegistryError("ERR_EXTENSION_MANIFEST_UNSUPPORTED")` for a cross-registry dependency or
 * a starter pack. The ONE place either refusal lives.
 */
export function assertManifestSupported(
  m: Pick<ExtensionManifest, "id" | "kind" | "dependsOn">,
): void {
  if (isStarterPack(m)) {
    throw new RegistryError(
      "ERR_EXTENSION_MANIFEST_UNSUPPORTED",
      `${m.id} is a starter pack; this Nimbus version cannot install starter packs yet`,
    );
  }
  dependencyRanges(m.dependsOn, m.id);
}
