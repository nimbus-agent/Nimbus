/**
 * Resolving an extension id across the owner's registries, shared by `registry.info` and
 * `registry.install` so the two can never disagree about which registry a bare id means.
 */
import {
  RegistryError,
  type RegistryErrorCode,
  type RegistryExtensionEntry,
  type RegistryIndex,
} from "@nimbus-dev/registry-format";
import { fetchVerifiedIndex, type RegistryFetchDeps } from "./registry-fetch.ts";
import { getRegistry, listRegistries, type RegistryRow } from "./registry-store.ts";

export type IndexRead = { reg: RegistryRow; index: RegistryIndex };

/** One registry whose index could not be read or verified this call. */
export type IndexFailure = { registry: string; error: string; cause: unknown };

/** Freshly verified indexes of `targets`, fetched concurrently; a failing registry is reported, not thrown. */
export async function readIndexes(
  deps: RegistryFetchDeps,
  targets: readonly RegistryRow[],
): Promise<{
  ok: IndexRead[];
  errors: Array<{ registry: string; error: string }>;
  failures: IndexFailure[];
}> {
  const settled = await Promise.allSettled(targets.map((reg) => fetchVerifiedIndex(deps, reg)));
  const ok: IndexRead[] = [];
  const failures: IndexFailure[] = [];
  settled.forEach((r, i) => {
    const reg = targets[i] as RegistryRow;
    if (r.status === "fulfilled") ok.push({ reg, index: r.value });
    else {
      const e: unknown = r.reason;
      failures.push({
        registry: reg.name,
        error: e instanceof Error ? e.message : String(e),
        cause: e,
      });
    }
  });
  return {
    ok,
    errors: failures.map(({ registry, error }) => ({ registry, error })),
    failures,
  };
}

/**
 * Registry codes that mean the index could not be REACHED. Every other failure (a bad signature, a
 * changed root key, a rollback, an unparseable index) means it was reached and failed
 * verification: a security event, never reported as a network problem.
 */
const UNREACHABLE_CODES: ReadonlySet<RegistryErrorCode> = new Set<RegistryErrorCode>([
  "ERR_REGISTRY_UNREACHABLE",
  "ERR_REGISTRY_AIR_GAP",
  "ERR_REGISTRY_TRANSPORT_REFUSED",
  "ERR_REGISTRY_TOO_LARGE",
  "ERR_REGISTRY_NOT_FOUND",
]);

/** The verification code of a failure, or undefined when the registry was merely unreachable. */
function verificationCode(f: IndexFailure): RegistryErrorCode | undefined {
  return f.cause instanceof RegistryError && !UNREACHABLE_CODES.has(f.cause.code)
    ? f.cause.code
    : undefined;
}

function describeFailures(failures: readonly IndexFailure[]): string {
  return failures
    .map((f) => {
      const code = verificationCode(f);
      return code === undefined
        ? `${f.registry}: unreachable (${f.error})`
        : `${f.registry}: failed verification: ${code} (${f.error})`;
    })
    .join("; ");
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

/**
 * The one registry carrying `id`. Ambiguity is an error, never resolved by priority — and that
 * includes priority by REACHABILITY: a bare id (no `registryName`) is refused while any configured
 * registry failed this call, since the failed one might carry the same id. A named lookup is about
 * that one registry only.
 */
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
  if (read.failures.length > 0) {
    const failed = describeFailures(read.failures);
    if (read.ok.length === 0) {
      // Nothing verified. A verification failure is surfaced as itself (a re-keyed or tampered
      // registry is a security event); only when every failure was a network one is it UNREACHABLE.
      const code =
        read.failures.map(verificationCode).find((c) => c !== undefined) ??
        "ERR_REGISTRY_UNREACHABLE";
      throw new RegistryError(code, `cannot resolve "${id}": ${failed}`);
    }
    if (registryName === undefined) {
      throw new RegistryError(
        "ERR_REGISTRY_AMBIGUOUS",
        `cannot tell which registry carries "${id}" while ${read.failures
          .map((f) => f.registry)
          .join(", ")} could not be read (${failed}); pass --registry <name>`,
      );
    }
  }
  const found = carrying[0];
  const entry = found?.index.extensions[id];
  if (found === undefined || entry === undefined) {
    throw new RegistryError("ERR_REGISTRY_NOT_FOUND", `no registry carries "${id}"`);
  }
  return { reg: found.reg, index: found.index, entry };
}
