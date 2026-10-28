import type { Database } from "bun:sqlite";

import { listExtensions } from "../automation/extension-store.ts";
import {
  credentialsReusedFrom,
  normalizeConnectorServiceId,
  oauthUnsupportedDetail,
} from "../connectors/connector-catalog.ts";
import {
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
import { credentialsConfigured, sortedNames } from "./extension-credentials.ts";
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
  for (const row of listExtensions(deps.db)) {
    const manifest = readInstalledManifest(row);
    if (manifest === undefined) continue;
    const entry = findContinuityBinding(bindingInputFor(row, manifest), table);
    if (entry !== undefined) owners.set(entry.legacyServiceId, { extensionId: row.id, entry });
  }
  return owners;
}

type Computed = Pick<ConnectorRequirementStatus, "state" | "owner" | "fix" | "interactive">;

/** A connected requirement still warns until its first successful sync. */
function syncedOrWarn(db: Database, id: string, base: Omit<Computed, "state" | "fix">): Computed {
  if (getConnectorHealth(db, id).lastSuccessfulSync === undefined) {
    return { ...base, state: "configured_never_synced", fix: [`nimbus connector sync ${id}`] };
  }
  return { ...base, state: "met", fix: [] };
}

/**
 * The owner is judged by its own run grant's credentials, never by `isConnectorConfigured`: that
 * falls through to the legacy Vault keys and would answer `met` on a stale key the extension does
 * not read until it is approved.
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
    return { ...base, state: "not_connected", fix: setLines(sortedNames(creds)) };
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
    let computed: Computed;
    try {
      if (owners === undefined) throw new Error("installed extensions could not be read");
      const owner = owners.get(id);
      computed =
        owner === undefined
          ? await bundledStatus(deps, slot.connector) // NOSONAR S9382: sequential Vault reads
          : await ownedStatus(deps, id, owner); // NOSONAR S9382: sequential Vault reads
    } catch {
      computed = { state: "unknown", owner: { kind: "bundled" }, fix: [], interactive: false };
    }
    out.push({
      connector: slot.connector,
      ...computed,
      requiredBy: [...slot.requiredBy].sort((a, b) => (a < b ? -1 : 1)),
    });
  }
  return out.sort((a, b) => (a.connector < b.connector ? -1 : a.connector > b.connector ? 1 : 0));
}
