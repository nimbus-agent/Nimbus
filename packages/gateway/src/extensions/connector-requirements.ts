import type { Database } from "bun:sqlite";

import { type ExtensionRow, listExtensions } from "../automation/extension-store.ts";
import {
  type ConnectorServiceId,
  credentialsReusedFrom,
  normalizeConnectorServiceId,
  oauthUnsupportedDetail,
  UNBUNDLED_CONNECTOR_IDS,
} from "../connectors/connector-catalog.ts";
import { CONNECTOR_VAULT_SECRET_KEYS } from "../connectors/connector-secrets-manifest.ts";
import {
  type ExtensionManifestReader,
  parseCredentials,
  readInstalledManifest,
} from "../connectors/extension-sync/extension-identity.ts";
import { getConnectorHealth } from "../connectors/health.ts";
import { connectorAuthUnavailableMessage } from "../ipc/connector-rpc-handlers/auth.ts";
import { isConnectorConfigured } from "../sync/connector-configured.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  bindingInputFor,
  CONTINUITY_TABLE,
  type ContinuityEntry,
  findContinuityBinding,
  pendingBindingInputFor,
} from "./continuity/continuity-table.ts";
import {
  type ResolvedRunCredentials,
  resolveRunCredentials,
  sortedNames,
} from "./extension-credentials.ts";
import { deriveExtensionServiceId } from "./extension-service-id.ts";
import type { ExtensionManifest } from "./manifest.ts";
import { getRunGrant } from "./run-grant-store.ts";
import { extensionRunState } from "./run-state.ts";
import { blocksForInstalled } from "./trust/trust-blocks.ts";

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
  /**
   * Packages an install plan is about to install (not installed yet, or at another version), each
   * with its verified manifest and the registry root it comes from. One the continuity table binds
   * is its connector's owner, judged as having no run grant yet, so an approval shown before the
   * install never calls that connector connected.
   */
  readonly pendingInstalls?: ReadonlyArray<{
    readonly manifest: ExtensionManifest;
    readonly sourceRootFingerprint: string | undefined;
  }>;
};

type ContinuityOwner = {
  readonly extensionId: string;
  readonly entry: ContinuityEntry;
  /** The installed row; null for a package an install plan has not installed yet (no grant). */
  readonly row: ExtensionRow | null;
  /** The installed copy's hash-checked manifest: what the next approval resolves credentials from. */
  readonly manifest: ExtensionManifest;
};

/**
 * `owners` maps a legacy id to the installed extension that binds it; `installedIds` is every
 * installed extension id, bound or not; `table` is the continuity table the scan used.
 */
type ContinuityScan = {
  readonly owners: ReadonlyMap<string, ContinuityOwner>;
  readonly installedIds: ReadonlySet<string>;
  readonly table: readonly ContinuityEntry[];
};

/** The id every lookup uses: the catalog id when known, else the same folding the catalog applies. */
function lookupId(connector: string): string {
  return (
    normalizeConnectorServiceId(connector) ?? connector.trim().toLowerCase().replaceAll("-", "_")
  );
}

/** Legacy id -> the installed extension the continuity table binds it to. Unreadable manifests bind nothing. */
function continuityOwners(deps: ConnectorRequirementDeps): ContinuityScan {
  const table = deps.continuityTable ?? CONTINUITY_TABLE;
  const owners = new Map<string, ContinuityOwner>();
  const installedIds = new Set<string>();
  const read = deps.readManifest ?? readInstalledManifest;
  for (const row of listExtensions(deps.db)) {
    installedIds.add(row.id);
    const manifest = read(row);
    if (manifest === undefined) continue;
    const entry = findContinuityBinding(bindingInputFor(row, manifest), table);
    if (entry !== undefined) {
      owners.set(entry.legacyServiceId, { extensionId: row.id, entry, row, manifest });
    }
  }
  for (const pending of deps.pendingInstalls ?? []) {
    const { manifest } = pending;
    const entry = findContinuityBinding(
      pendingBindingInputFor(manifest, pending.sourceRootFingerprint),
      table,
    );
    if (entry === undefined) continue;
    installedIds.add(manifest.id);
    owners.set(entry.legacyServiceId, { extensionId: manifest.id, entry, row: null, manifest });
  }
  return { owners, installedIds, table };
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

/** The names among `creds` whose Vault value is blank, in sorted order. One read per name. */
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
 * legacy keys, missing a declared credential the binding does not map. A disabled owner, or one
 * whose grant approved other code (the run-state staleness rule), is never `met`.
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
  const stored = getRunGrant(deps.db, owner.extensionId);
  // A package the plan has not installed yet has no grant for the code it is about to install.
  const grant = owner.row === null ? null : stored;
  // The I48 blocks the run state reads for `extension.info`, so a blocked owner is never `met`.
  const runState =
    owner.row === null
      ? "no_grant"
      : extensionRunState(
          owner.row,
          grant,
          false,
          blocksForInstalled(deps.db, owner.row, owner.manifest),
        );
  if (runState === "blocked") {
    // A re-approval cannot clear a revocation or takedown; `info` shows what blocks it.
    return {
      ...base,
      state: "not_connected",
      fix: [`nimbus extension info ${owner.extensionId}`],
      interactive: false,
    };
  }
  if (runState === "disabled") {
    return {
      ...base,
      state: "not_connected",
      fix: [`nimbus extension enable ${owner.extensionId}`],
      // The walk does not run `enable`; it prints it for the owner to run.
      interactive: false,
    };
  }
  if (grant === null || runState === "grant_stale") {
    // What the NEXT approval will grant (the service id `approveExtensionRun` keeps or derives), so
    // the fix never asks for a secret already stored under the key the grant will read.
    const serviceId = stored?.service_id ?? deriveExtensionServiceId(owner.extensionId);
    const willGrant = resolveRunCredentials(owner.manifest, serviceId, owner.entry);
    return {
      ...base,
      state: "not_connected",
      fix: [
        `nimbus extension approve ${owner.extensionId}`,
        ...setLines(await blankCredentialNames(deps.vault, willGrant)),
      ],
    };
  }
  const creds = parseCredentials(grant.credentials_json);
  if (creds === undefined) {
    throw new Error(`${owner.extensionId}'s run grant carries unreadable credentials`);
  }
  // "Configured" is "nothing blank": each credential is read once.
  const blank = await blankCredentialNames(deps.vault, creds);
  if (blank.length > 0) {
    // Name only what is missing, so following the fix never re-enters a stored secret.
    return { ...base, state: "not_connected", fix: setLines(blank) };
  }
  return syncedOrWarn(deps.db, id, base);
}

/**
 * How a bundled token connector is connected, as typed: `connector auth --token` where
 * `connector auth` takes a token, else one `vault set` per manifest key (the commands
 * `connector auth` itself names when it refuses the service).
 */
function tokenConnectorFix(target: ConnectorServiceId): string[] {
  if (connectorAuthUnavailableMessage(target) === null) {
    return [`nimbus connector auth ${target} --token <token>`];
  }
  return CONNECTOR_VAULT_SECRET_KEYS[target].map((k) => `nimbus vault set ${k}`);
}

async function bundledStatus(deps: ConnectorRequirementDeps, connector: string): Promise<Computed> {
  const known = normalizeConnectorServiceId(connector);
  if (known === null) {
    // `isConnectorConfigured` answers `true` for a key it does not know, so this must come first.
    return { state: "unknown_connector", owner: { kind: "bundled" }, fix: [], interactive: false };
  }
  // A requirement on `github_actions` is connected by authenticating `github`.
  const target = credentialsReusedFrom(known) ?? known;
  const oauth = oauthUnsupportedDetail(target) === undefined;
  const base = { owner: { kind: "bundled" }, interactive: oauth } as const;
  if (!(await isConnectorConfigured(deps.vault, known))) {
    const fix = oauth ? [`nimbus connector auth ${target}`] : tokenConnectorFix(target);
    return { ...base, state: "not_connected", fix };
  }
  return syncedOrWarn(deps.db, known, base);
}

const UNBUNDLED_IDS: ReadonlySet<string> = new Set(UNBUNDLED_CONNECTOR_IDS);

/**
 * A continuity-bound id whose owner did not bind. Not installed: the fix installs it. Installed but
 * unreadable, or a copy from another source: no command here honestly fixes that, so `unknown`.
 */
function ownerNotBound(scan: ContinuityScan, extensionId: string): Computed {
  const owner = { kind: "extension", extensionId } as const;
  if (scan.installedIds.has(extensionId)) {
    return { state: "unknown", owner, fix: [], interactive: false };
  }
  return {
    state: "not_connected",
    owner,
    fix: [`nimbus extension install ${extensionId}`],
    interactive: false,
  };
}

/** One connector's status. An id the continuity table binds, or an unbundled one, never reaches the bundled path. */
async function statusFor(
  deps: ConnectorRequirementDeps,
  scan: ContinuityScan,
  id: string,
  connector: string,
  boundTo: string | undefined,
): Promise<Computed> {
  const owner = scan.owners.get(id);
  if (owner !== undefined) return ownedStatus(deps, id, owner);
  if (boundTo !== undefined) return ownerNotBound(scan, boundTo);
  if (UNBUNDLED_IDS.has(id)) {
    return { state: "unknown_connector", owner: { kind: "bundled" }, fix: [], interactive: false };
  }
  return bundledStatus(deps, connector);
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

  let scan: ContinuityScan | undefined;
  try {
    scan = continuityOwners(deps);
  } catch {
    scan = undefined; // every connector reads `unknown` below
  }
  const table = scan?.table ?? deps.continuityTable ?? CONTINUITY_TABLE;

  const out: ConnectorRequirementStatus[] = [];
  // Sequential on purpose: on Linux each Vault read spawns a `secret-tool` process.
  for (const [id, slot] of byId) {
    const boundTo =
      scan?.owners.get(id)?.extensionId ?? table.find((e) => e.legacyServiceId === id)?.extensionId;
    let computed: Computed;
    try {
      if (scan === undefined) throw new Error("installed extensions could not be read");
      computed = await statusFor(deps, scan, id, slot.connector, boundTo); // NOSONAR S9382: sequential Vault reads
    } catch {
      // Keep the owner already resolved, so an extension-owned connector never reads as bundled.
      computed = {
        state: "unknown",
        owner:
          boundTo === undefined ? { kind: "bundled" } : { kind: "extension", extensionId: boundTo },
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
