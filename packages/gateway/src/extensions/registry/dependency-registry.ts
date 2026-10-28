/**
 * Which registry a dependency names. A package's `dependsOn` entry may carry a `registry` — the
 * reserved official name or an https URL — and the install must fetch that dependency from there,
 * never from wherever happens to carry the id. A URL resolves ONLY among registries the owner has
 * added (plus the built-in one): a manifest cannot make the gateway talk to a registry the owner
 * never chose, and an unadded one is refused with the command that adds it.
 */
import {
  type DependencySpec,
  OFFICIAL_REGISTRY_NAME,
  RegistryError,
} from "@nimbus-dev/registry-format";
import { canonicalizeUrl } from "../../util/url-canonical.ts";
import { builtinRegistryOf, builtinRegistryRow } from "./builtin-registry.ts";
import type { RegistryFetchDeps } from "./registry-fetch.ts";
import { listRegistries, type RegistryRow } from "./registry-store.ts";

function notAdded(depId: string, registry: string): RegistryError {
  return new RegistryError(
    "ERR_DEPENDENCY_REGISTRY_NOT_ADDED",
    `${depId} comes from ${registry}, which is not one of your registries; add it with \`nimbus registry add <name> ${registry}\` and re-run the install`,
  );
}

function airGapRefusal(depId: string): RegistryError {
  return new RegistryError(
    "ERR_REGISTRY_AIR_GAP",
    `${depId} needs the official registry, which is not consulted while [llm] enforce_air_gap is on`,
  );
}

/** The registry a dependency declared by a package from `parent` must come from. */
export function resolveDependencyRegistry(
  deps: RegistryFetchDeps,
  parent: RegistryRow,
  depId: string,
  spec: DependencySpec,
): RegistryRow {
  const named = spec.registry;
  if (named === undefined) return parent;

  const builtinConfig = builtinRegistryOf(deps);
  const builtin = builtinConfig === null ? null : builtinRegistryRow(deps.db, builtinConfig);

  const matched = matchRegistry(deps, depId, named, builtin);
  if (
    spec.rootKeyFingerprint !== undefined &&
    spec.rootKeyFingerprint !== matched.rootFingerprint
  ) {
    throw new RegistryError(
      "ERR_DEPENDENCY_REGISTRY_KEY_MISMATCH",
      `${depId} pins root key fingerprint ${spec.rootKeyFingerprint}, but ${named} has ${matched.rootFingerprint}`,
    );
  }
  return matched;
}

function matchRegistry(
  deps: RegistryFetchDeps,
  depId: string,
  named: string,
  builtin: RegistryRow | null,
): RegistryRow {
  if (named === OFFICIAL_REGISTRY_NAME) {
    if (builtin === null) throw notAdded(depId, named);
    if (deps.enforceAirGap()) throw airGapRefusal(depId);
    return builtin;
  }
  const wanted = canonicalizeUrl(named);
  const owners = listRegistries(deps.db).filter((r) => canonicalizeUrl(r.url) === wanted);
  if (owners.length > 1) {
    throw new RegistryError(
      "ERR_REGISTRY_AMBIGUOUS",
      `${depId} names ${named}, which ${owners.map((r) => r.name).join(", ")} all point at; remove all but one`,
    );
  }
  const owner = owners[0];
  if (owner !== undefined) return owner;
  if (builtin !== null && canonicalizeUrl(builtin.url) === wanted) {
    if (deps.enforceAirGap()) throw airGapRefusal(depId);
    return builtin;
  }
  throw notAdded(depId, named);
}
