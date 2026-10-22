/**
 * The built-in official registry (connector-unbundling spec § 7.4). The release carries its URL and
 * root public key; it is NOT a row of the owner's `extension_registry` — adding it to the owner's
 * list stays a `registry.add` HITL decision, and `listRegistries` / `nimbus registry list` stay the
 * owner's list. Three pieces make it usable by code paths that assumed a row:
 *
 * - a reserved name, `nimbus-official`, which `registry.add` (and the store) refuse outright;
 * - its own I44 anti-rollback floor, in the gateway-owned `builtin_registry_state` table (V73);
 * - one resolver, `resolveRegistry`, which the fetch, update-detection and update-apply paths use
 *   instead of `getRegistry`, plus `recordAnyRegistryFetch`, which records a verified fetch in the
 *   store that matches the row.
 *
 * The built-in config is never read from the environment, a config file or an IPC parameter. Every
 * consumer takes it as an injected parameter (or the `builtin` field of `RegistryFetchDeps`) that
 * defaults to `BUILTIN_REGISTRY`, so tests inject a fixture registry and production uses the baked
 * value.
 */
import type { Database } from "bun:sqlite";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import { dbRun } from "../../db/write.ts";
import { readIndexedUserVersion } from "../../index/migrations/runner.ts";
import {
  BUILTIN_REGISTRY_NAME,
  getRegistry,
  type RegistryRow,
  recordRegistryFetch,
} from "./registry-store.ts";

export { BUILTIN_REGISTRY_NAME, isReservedRegistryName } from "./registry-store.ts";

export interface BuiltinRegistryConfig {
  readonly url: string;
  /** Base64 Ed25519 root public key; the fingerprint I44 compares is derived from it. */
  readonly rootKey: string;
}

/**
 * The official registry this release trusts (connector-unbundling pilot, gateway PR 7). The URL
 * keeps its trailing slash: `resolveRegistryResource` resolves `index.json` with `new URL(rel,
 * base)`, which drops the last path segment of a base without one. Tests that must not reach the
 * network pass `builtin: null` explicitly.
 */
export const BUILTIN_REGISTRY: BuiltinRegistryConfig | null = {
  url: "https://nimbus-agent.github.io/nimbus-mcp-servers/",
  rootKey: "tBHSfVjFZzyMoSVR69FbZfMyUstbLdUcfGwHKIaY/qA=",
};

/** The built-in config a set of deps carries: its own `builtin` when given, else the baked one. */
export function builtinRegistryOf(deps: {
  readonly builtin?: BuiltinRegistryConfig | null | undefined;
}): BuiltinRegistryConfig | null {
  return deps.builtin === undefined ? BUILTIN_REGISTRY : deps.builtin;
}

type BuiltinStateRow = {
  last_sequence: number;
  last_generated_at: string | null;
  last_fetched_at: number | null;
};

/** The stored floor, only when it was recorded under `rootKey`: a re-pinned root starts fresh. */
function readBuiltinState(db: Database, rootKey: string): BuiltinStateRow | undefined {
  // Below V73 the table does not exist yet: no recorded fetch, so the floor is 0.
  if (readIndexedUserVersion(db) < 73) return undefined;
  const r = db
    .query(
      "SELECT last_sequence, last_generated_at, last_fetched_at FROM builtin_registry_state WHERE name = ? AND root_key = ?",
    )
    .get(BUILTIN_REGISTRY_NAME, rootKey) as BuiltinStateRow | null;
  return r ?? undefined;
}

/** The built-in registry as a `RegistryRow`: URL and key from the release, sequence from V73's table. */
export function builtinRegistryRow(db: Database, builtin: BuiltinRegistryConfig): RegistryRow {
  const state = readBuiltinState(db, builtin.rootKey);
  return {
    name: BUILTIN_REGISTRY_NAME,
    url: builtin.url,
    rootKey: builtin.rootKey,
    rootFingerprint: publisherKeyFingerprint(builtin.rootKey),
    lastSequence: state?.last_sequence ?? 0,
    lastGeneratedAt: state?.last_generated_at ?? "",
    addedAt: 0,
    lastFetchedAt: state?.last_fetched_at ?? null,
    builtin: true,
  };
}

/**
 * The registry a NAME means as a source: the built-in registry for the reserved name when one is
 * configured, otherwise the owner's row. The reserved name wins over an owner row of the same name,
 * which can only predate the reservation; with no built-in configured it reads exactly as
 * `getRegistry`.
 */
export function resolveRegistry(
  db: Database,
  name: string,
  builtin: BuiltinRegistryConfig | null = BUILTIN_REGISTRY,
): RegistryRow | undefined {
  if (builtin !== null && name === BUILTIN_REGISTRY_NAME) return builtinRegistryRow(db, builtin);
  return getRegistry(db, name);
}

/**
 * The registries a bare `extension install <id>` searches: the owner's, plus the built-in one —
 * unless none is configured, or an owner registry already carries its root fingerprint (the same
 * trust root listed twice would trip I44's two-registries refusal for every official extension).
 * An owner row that predates the reserved name is replaced by the built-in, as `resolveRegistry`
 * resolves that name.
 *
 * Under `[llm] enforce_air_gap` (`airGapped`, the same `enforceAirGap` the fetch layer refuses
 * remote requests by) the built-in is not a target either: it is a remote registry that can never
 * be read there, and counting it would make every bare install ambiguous. Owner registries stay
 * targets whatever their transport; the fetch layer decides which of them is reachable. Plain
 * offline is NOT this case: an unreachable built-in still counts, since it might carry the id.
 * Consequently an owner registry carrying an id the built-in also lists resolves without an
 * ambiguity refusal under air gap, as it would on a gateway with no built-in; it never binds, since
 * its root fingerprint is not the official one.
 */
export function bareRegistryTargets(
  db: Database,
  owners: readonly RegistryRow[],
  builtin: BuiltinRegistryConfig | null,
  { airGapped }: { readonly airGapped: boolean },
): RegistryRow[] {
  if (builtin === null || airGapped) return [...owners];
  const official = builtinRegistryRow(db, builtin);
  if (owners.some((r) => r.rootFingerprint === official.rootFingerprint)) return [...owners];
  return [...owners.filter((r) => r.name !== BUILTIN_REGISTRY_NAME), official];
}

/**
 * Advances the I44 anti-rollback floor of whichever store `reg` came from, conditional in both: a
 * sequence lower than the stored one changes nothing. Returns whether a row changed. For an owner
 * row it is `recordRegistryFetch` (also conditional on the pinned key); for the built-in registry
 * it is an upsert into `builtin_registry_state` keyed like the owner row: a floor stored under a
 * different root key does not apply, and a fetch under a new key records a fresh floor.
 */
export function recordAnyRegistryFetch(
  db: Database,
  reg: RegistryRow,
  sequence: number,
  generatedAt: string,
  now: number,
): boolean {
  if (reg.builtin !== true) {
    return recordRegistryFetch(db, reg.name, reg.rootKey, sequence, generatedAt, now);
  }
  const r = dbRun(
    db,
    `INSERT INTO builtin_registry_state (name, root_key, last_sequence, last_generated_at, last_fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       root_key = excluded.root_key,
       last_sequence = excluded.last_sequence,
       last_generated_at = excluded.last_generated_at,
       last_fetched_at = excluded.last_fetched_at
     WHERE builtin_registry_state.root_key <> excluded.root_key
        OR builtin_registry_state.last_sequence <= excluded.last_sequence`,
    [BUILTIN_REGISTRY_NAME, reg.rootKey, sequence, generatedAt, now],
  );
  return r.changes > 0;
}

/** The floor currently stored for `reg`'s store, or undefined when its owner row is gone or re-pinned. */
export function currentRegistryFloor(
  db: Database,
  reg: RegistryRow,
): { lastSequence: number } | undefined {
  if (reg.builtin === true)
    return { lastSequence: readBuiltinState(db, reg.rootKey)?.last_sequence ?? 0 };
  const cur = getRegistry(db, reg.name);
  return cur?.rootKey === reg.rootKey ? cur : undefined;
}
