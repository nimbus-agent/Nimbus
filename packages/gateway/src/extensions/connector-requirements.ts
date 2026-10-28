import type { Database } from "bun:sqlite";

import { type ExtensionRow, listExtensions } from "../automation/extension-store.ts";
import {
  credentialsReusedFrom,
  normalizeConnectorServiceId,
  oauthUnsupportedDetail,
} from "../connectors/connector-catalog.ts";
import {
  type ExtensionManifestReader,
  parseCredentials,
  readInstalledManifest,
} from "../connectors/extension-sync/extension-identity.ts";
import { getConnectorHealth } from "../connectors/health.ts";
import { isConnectorConfigured } from "../sync/connector-configured.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  bindingInputFor,
  CONTINUITY_TABLE,
  type ContinuityEntry,
  findContinuityBinding,
} from "./continuity/continuity-table.ts";
import {
  credentialsConfigured,
  type ResolvedRunCredentials,
  sortedNames,
} from "./extension-credentials.ts";
import { getRunGrant } from "./run-grant-store.ts";

export type ConnectorRequirementState =
  | "met"
  | "configured_never_synced"
  | "not_connected"
  | "unknown_connector"
  | "unknown"; // status could not be computed (e.g. Vault error)

export type ConnectorRequirementOwner =
  | { readonly kind: "bundled" }
  | { readonly kind: "extension"; readonly extensionId: string };

export type ConnectorRequirementStatus = {
  /** As the manifest spells it. */
  readonly connector: string;
  readonly state: ConnectorRequirementState;
  readonly owner: ConnectorRequirementOwner;
  /** Exact commands, in order; `[]` when met / unknown_connector / unknown. */
  readonly fix: readonly string[];
  /**
   * The fix can run on a TTY without flags: an OAuth connector, or an extension owner's
   * `credential set` (hidden prompt). Token connectors are `false`.
   */
  readonly interactive: boolean;
  /** Extension ids, sorted. */
  readonly requiredBy: readonly string[];
};

export type ConnectorRequirementDeps = {
  readonly db: Database;
  readonly vault: NimbusVault;
  readonly continuityTable?: readonly ContinuityEntry[];
  /**
   * How an installed copy's manifest is read (default: hash-checked, unreadable reads as absent).
   * A caller that already read every manifest passes a memo, so no manifest is read twice.
   */
  readonly readManifest?: ExtensionManifestReader;
};

type ContinuityOwner = { readonly extensionId: string; readonly entry: ContinuityEntry };

/** The id every lookup uses: the catalog id when known, else the same folding the catalog applies. */
function lookupId(connector: string): string {
  return (
    normalizeConnectorServiceId(connector) ?? connector.trim().toLowerCase().replaceAll("-", "_")
  );
}

/** Legacy id -> the installed extension the continuity table binds it to. Unreadable manifests are skipped. */
function continuityOwners(deps: ConnectorRequirementDeps): Map<string, ContinuityOwner> {
  const table = deps.continuityTable ?? CONTINUITY_TABLE;
  const owners = new Map<string, ContinuityOwner>();
  const read = deps.readManifest ?? readInstalledManifest;
  for (const row of listExtensions(deps.db)) {
    const manifest = read(row);
    if (manifest === undefined) continue;
    const entry = findContinuityBinding(bindingInputFor(row, manifest), table);
    if (entry !== undefined) owners.set(entry.legacyServiceId, { extensionId: row.id, entry });
  }
  return owners;
}

/** Code-unit order: the same on every machine, whatever its locale. */
function byConnector(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

type Computed = Pick<ConnectorRequirementStatus, "state" | "owner" | "fix" | "interactive">;

/** A connected requirement still warns until its first successful sync. */
function syncedOrWarn(db: Database, id: string, base: Omit<Computed, "state" | "fix">): Computed {
  if (getConnectorHealth(db, id).lastSuccessfulSync === undefined) {
    return { ...base, state: "configured_never_synced", fix: [`nimbus connector sync ${id}`] };
  }
  return { ...base, state: "met", fix: [] };
}

/** The names among `creds` whose Vault value is blank, in sorted order. */
async function blankCredentialNames(
  vault: NimbusVault,
  creds: ResolvedRunCredentials,
): Promise<string[]> {
  const blank: string[] = [];
  // Sequential on purpose: on Linux each Vault read spawns a `secret-tool` process.
  for (const name of sortedNames(creds)) {
    const v = creds[name];
    if (v === undefined) continue;
    const value = await vault.get(v.vaultKey); // NOSONAR S9382: sequential Vault reads
    if (value === null || value.trim() === "") blank.push(name);
  }
  return blank;
}

/**
 * The owner is judged by its own run grant's credentials, never by `isConnectorConfigured`: with no
 * manifest keys for the id that answers `true` vacuously, and with a bound id it reads only the
 * legacy keys, missing a declared credential the binding does not map.
 */
async function ownedStatus(
  deps: ConnectorRequirementDeps,
  id: string,
  owner: ContinuityOwner,
): Promise<Computed> {
  const base = {
    owner: { kind: "extension", extensionId: owner.extensionId },
    interactive: true,
  } as const;
  const setLines = (names: readonly string[]): string[] =>
    names.map((n) => `nimbus extension credential set ${owner.extensionId} ${n}`);
  const grant = getRunGrant(deps.db, owner.extensionId);
  if (grant === null) {
    return {
      ...base,
      state: "not_connected",
      fix: [
        `nimbus extension approve ${owner.extensionId}`,
        ...setLines(sortedNames(owner.entry.credentials)),
      ],
    };
  }
  const creds = parseCredentials(grant.credentials_json);
  if (creds === undefined) {
    throw new Error(`${owner.extensionId}'s run grant carries unreadable credentials`);
  }
  if (!(await credentialsConfigured(deps.vault, creds))) {
    // Name only what is missing, so following the fix never re-enters a stored secret.
    return {
      ...base,
      state: "not_connected",
      fix: setLines(await blankCredentialNames(deps.vault, creds)),
    };
  }
  return syncedOrWarn(deps.db, id, base);
}

async function bundledStatus(deps: ConnectorRequirementDeps, connector: string): Promise<Computed> {
  const known = normalizeConnectorServiceId(connector);
  if (known === null) {
    // `isConnectorConfigured` answers `true` for a key it does not know, so this must come first.
    return { state: "unknown_connector", owner: { kind: "bundled" }, fix: [], interactive: false };
  }
  // A requirement on `github_actions` is connected by authenticating `github`.
  const target = credentialsReusedFrom(known) ?? known;
  const base = {
    owner: { kind: "bundled" },
    interactive: oauthUnsupportedDetail(target) === undefined,
  } as const;
  if (!(await isConnectorConfigured(deps.vault, known))) {
    return { ...base, state: "not_connected", fix: [`nimbus connector auth ${target}`] };
  }
  return syncedOrWarn(deps.db, known, base);
}

/**
 * Whether each connector the given extensions require is connected, through the same Vault
 * predicate the scheduler and sync gate use. One entry per distinct connector (ids are folded the
 * way the catalog folds them; the first spelling seen is kept), sorted by connector. Never throws
 * for one connector: a failure reads as `unknown` for that connector only.
 */
export async function connectorRequirementStatuses(
  deps: ConnectorRequirementDeps,
  required: ReadonlyArray<{ readonly extensionId: string; readonly connectors: readonly string[] }>,
): Promise<ConnectorRequirementStatus[]> {
  const byId = new Map<string, { connector: string; requiredBy: Set<string> }>();
  for (const req of required) {
    for (const connector of req.connectors) {
      const id = lookupId(connector);
      const slot = byId.get(id) ?? { connector, requiredBy: new Set<string>() };
      slot.requiredBy.add(req.extensionId);
      byId.set(id, slot);
    }
  }
  if (byId.size === 0) return [];

  let owners: Map<string, ContinuityOwner> | undefined;
  try {
    owners = continuityOwners(deps);
  } catch {
    owners = undefined; // every connector reads `unknown` below
  }

  const out: ConnectorRequirementStatus[] = [];
  // Sequential on purpose: on Linux each Vault read spawns a `secret-tool` process.
  for (const [id, slot] of byId) {
    const owner = owners?.get(id);
    let computed: Computed;
    try {
      if (owners === undefined) throw new Error("installed extensions could not be read");
      computed =
        owner === undefined
          ? await bundledStatus(deps, slot.connector) // NOSONAR S9382: sequential Vault reads
          : await ownedStatus(deps, id, owner); // NOSONAR S9382: sequential Vault reads
    } catch {
      // Keep the owner already resolved, so an extension-owned connector never reads as bundled.
      computed = {
        state: "unknown",
        owner:
          owner === undefined
            ? { kind: "bundled" }
            : { kind: "extension", extensionId: owner.extensionId },
        fix: [],
        interactive: false,
      };
    }
    out.push({
      connector: slot.connector,
      ...computed,
      requiredBy: [...slot.requiredBy].sort((a, b) => (a < b ? -1 : 1)),
    });
  }
  return out.sort((a, b) => byConnector(a.connector, b.connector));
}

/** One entry of `connectorRequirementStatuses`' `required` list. */
export type ConnectorRequirementInput = {
  readonly extensionId: string;
  readonly connectors: readonly string[];
};

/** `connectorRequirementStatuses`, or a test's stand-in for it. */
export type ConnectorRequirementStatusesFn = typeof connectorRequirementStatuses;

/**
 * What an installed extension's hash-checked manifest requires: `[]` when it declares nothing,
 * undefined when the manifest cannot be read (the caller then reports nothing, rather than "none").
 */
export function installedConnectorRequirements(
  row: ExtensionRow,
  read: ExtensionManifestReader = readInstalledManifest,
): ConnectorRequirementInput[] | undefined {
  const manifest = read(row);
  if (manifest === undefined) return undefined;
  return manifest.requires === undefined
    ? []
    : [{ extensionId: row.id, connectors: manifest.requires.connectors }];
}

/**
 * `connectorRequirementStatuses` over what the installed extensions `ids` require, each read from
 * its installed copy's hash-checked manifest (one that no longer reads contributes nothing).
 * Never throws: any failure is undefined (no answer), so it can never fail what asked for it.
 */
export async function installedConnectorRequirementStatuses(
  deps: ConnectorRequirementDeps,
  ids: readonly string[],
  compute: ConnectorRequirementStatusesFn = connectorRequirementStatuses,
): Promise<ConnectorRequirementStatus[] | undefined> {
  try {
    const wanted = new Set(ids);
    const required = listExtensions(deps.db)
      .filter((r) => wanted.has(r.id))
      .flatMap((r) => installedConnectorRequirements(r) ?? []);
    return await compute(deps, required);
  } catch {
    return undefined;
  }
}

/**
 * Each extension's own requirement statuses (keyed by extension id), computed in ONE pass: every
 * distinct connector's status is computed once, however many extensions require it, then projected
 * onto each extension (its own spelling, `requiredBy: [id]`, sorted by connector) — the same list a
 * call over that extension alone would return. Never throws: on any failure the map is empty.
 */
export async function connectorRequirementStatusesByExtension(
  deps: ConnectorRequirementDeps,
  required: readonly ConnectorRequirementInput[],
  compute: ConnectorRequirementStatusesFn = connectorRequirementStatuses,
): Promise<Map<string, ConnectorRequirementStatus[]>> {
  const out = new Map<string, ConnectorRequirementStatus[]>();
  try {
    const byId = new Map((await compute(deps, required)).map((s) => [lookupId(s.connector), s]));
    for (const req of required) {
      const own = new Map<string, ConnectorRequirementStatus>();
      for (const connector of req.connectors) {
        const id = lookupId(connector);
        const status = byId.get(id);
        if (status === undefined || own.has(id)) continue;
        own.set(id, { ...status, connector, requiredBy: [req.extensionId] });
      }
      out.set(
        req.extensionId,
        [...own.values()].sort((a, b) => byConnector(a.connector, b.connector)),
      );
    }
  } catch {
    out.clear();
  }
  return out;
}
