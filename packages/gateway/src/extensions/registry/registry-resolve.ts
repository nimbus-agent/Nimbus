/**
 * Resolving an extension id across the owner's registries, shared by `registry.info` and
 * `registry.install` so the two can never disagree about which registry a bare id means.
 */
import type { RegistryExtensionEntry, RegistryIndex } from "./index-format.ts";
import { RegistryError } from "./registry-errors.ts";
import { fetchVerifiedIndex, type RegistryFetchDeps } from "./registry-fetch.ts";
import { getRegistry, listRegistries, type RegistryRow } from "./registry-store.ts";

export type IndexRead = { reg: RegistryRow; index: RegistryIndex };

/** Freshly verified indexes of `targets`, fetched concurrently; a failing registry is reported, not thrown. */
export async function readIndexes(
  deps: RegistryFetchDeps,
  targets: readonly RegistryRow[],
): Promise<{ ok: IndexRead[]; errors: Array<{ registry: string; error: string }> }> {
  const settled = await Promise.allSettled(targets.map((reg) => fetchVerifiedIndex(deps, reg)));
  const ok: IndexRead[] = [];
  const errors: Array<{ registry: string; error: string }> = [];
  settled.forEach((r, i) => {
    const reg = targets[i] as RegistryRow;
    if (r.status === "fulfilled") ok.push({ reg, index: r.value });
    else {
      const e: unknown = r.reason;
      errors.push({ registry: reg.name, error: e instanceof Error ? e.message : String(e) });
    }
  });
  return { ok, errors };
}

/** The named registry, or every registry when `name` is undefined. */
export function registryTargets(deps: RegistryFetchDeps, name: string | undefined): RegistryRow[] {
  if (name === undefined) return listRegistries(deps.db);
  const one = getRegistry(deps.db, name);
  if (one === undefined) {
    throw new RegistryError("ERR_REGISTRY_NOT_FOUND", `no registry named "${name}"`);
  }
  return [one];
}

export type ResolvedEntry = {
  reg: RegistryRow;
  index: RegistryIndex;
  entry: RegistryExtensionEntry;
};

/** The one registry carrying `id` (ambiguity and absence are errors; never resolved by priority). */
export async function resolveRegistryEntry(
  deps: RegistryFetchDeps,
  id: string,
  registryName: string | undefined,
): Promise<ResolvedEntry> {
  const read = await readIndexes(deps, registryTargets(deps, registryName));
  const carrying = read.ok.filter((r) => r.index.extensions[id] !== undefined);
  if (carrying.length > 1) {
    throw new RegistryError(
      "ERR_REGISTRY_AMBIGUOUS",
      `"${id}" is carried by ${carrying.map((r) => r.reg.name).join(", ")}; pass --registry <name>`,
    );
  }
  const found = carrying[0];
  const entry = found?.index.extensions[id];
  if (found === undefined || entry === undefined) {
    const failed = read.errors.map((e) => `${e.registry}: ${e.error}`).join("; ");
    throw new RegistryError(
      "ERR_REGISTRY_NOT_FOUND",
      `no registry carries "${id}"${failed === "" ? "" : ` (unreachable: ${failed})`}`,
    );
  }
  return { reg: found.reg, index: found.index, entry };
}
