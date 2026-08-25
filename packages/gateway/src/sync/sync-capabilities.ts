import type { Database } from "bun:sqlite";

import type { ConnectorServiceId } from "../connectors/connector-catalog.ts";
import { type ConnectorSecretKeyOf, readConnectorSecret } from "../connectors/connector-vault.ts";
import { type FallbackPrCandidate, selectPrEnrichCandidates } from "../connectors/github-sync.ts";
import { createServiceScopedVaultView } from "../connectors/service-scoped-vault-view.ts";
import type { ResolveServiceId } from "../graph/graph-populator.ts";
import { type ApiEndpointWrite, writeApiEndpointsForSpec } from "../index/api-endpoint-store.ts";
import {
  type BodyRow,
  countIndexedItems,
  deleteItemByServiceExternal,
  type ItemBodyFetchState,
  indexedItemExists,
  listDistinctMetadataValues,
  selectItemBodyFetchState,
  selectItemMetadataJson,
  upsertIndexedItemForSync,
} from "../index/item-store.ts";
import { type ObsidianNoteWrite, writeObsidianVault } from "../index/obsidian-notes-store.ts";
import { resolvePersonForSync } from "../people/linker.ts";
import type { PersonSyncHints } from "../people/person-types.ts";
import { recordPrChangedFiles } from "../prfiles/pr-changed-file-store.ts";
import { selectPrFileCandidates } from "../prfiles/pr-file-fetch.ts";
import { type BlameRow, pruneBlameForFile, upsertBlameLines } from "../security/blame-store.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { resolveAccessTokenForService } from "./access-token-registry.ts";

/**
 * What a syncable may reach, in place of the raw `vault` and `db` handles it holds today.
 *
 * Each capability is bound to ONE service by the gateway. The service id is never a parameter the
 * caller supplies — a caller-supplied id would make `getSecret` a vault handle with extra steps,
 * which is the thing this exists to prevent.
 */

/**
 * The ONLY cross-service credential reads in the codebase, enumerated rather than inferred.
 *
 * Four connectors legitimately authenticate with a SHARED credential family: BigQuery, Cloud
 * Logging and Vertex AI all use one `gcp.*` service account, and GitHub Actions uses the same
 * `github.pat` as the GitHub connector. `isConnectorConfigured`'s DERIVED_CONFIGURED_CHECKS already
 * encodes the same relationships for I29's egress gating.
 *
 * Scoping `getSecret` to the calling service alone would have broken all four. Granting them a
 * blanket vault handle would have un-done the narrowing. This is the third option: a named,
 * checked grant, so a NEW cross-service read is a deliberate edit here rather than an accident.
 */
export const SHARED_CREDENTIAL_GRANTS = {
  bigquery: ["gcp"],
  cloud_logging: ["gcp"],
  vertex_ai: ["gcp"],
  github_actions: ["github"],
  athena: ["aws"],
  cloudwatch: ["aws"],
  sagemaker: ["aws"],
  aws: ["aws"],
} as const satisfies Partial<Record<ConnectorServiceId, readonly ConnectorServiceId[]>>;

function grantsFor(serviceId: ConnectorServiceId): readonly ConnectorServiceId[] {
  return (
    (
      SHARED_CREDENTIAL_GRANTS as Partial<Record<ConnectorServiceId, readonly ConnectorServiceId[]>>
    )[serviceId] ?? []
  );
}

export interface SyncCapabilities<S extends ConnectorServiceId = ConnectorServiceId> {
  /**
   * Resolves `<serviceId>.<keyName>` against the vault. A syncable cannot name another service's
   * key: the prefix is applied here, not by the caller. The key TYPE stays service-specific, so
   * the compile-time checking `readConnectorSecret` gives today is preserved rather than widened
   * to `string`.
   */
  getSecret(keyName: ConnectorSecretKeyOf<S>): Promise<string | null>;
  /**
   * Reads a SHARED credential family — `gcp.*` for the three GCP connectors, `github.*` for GitHub
   * Actions. Throws when the bound service has no grant for that family, so an ungranted
   * cross-service read fails loudly at the call rather than silently returning null and looking
   * like an unconfigured connector.
   */
  getSharedSecret<F extends ConnectorServiceId>(
    family: F,
    keyName: ConnectorSecretKeyOf<F>,
  ): Promise<string | null>;
  /**
   * A vault view already scoped to ONE service, for the connector-session transport. Not a handle:
   * `createServiceScopedVaultView` is the same scoping guarantee `getSecret` gives, expressed as an
   * object because `withConnectorSession` takes one.
   */
  scopedVaultView(service: string): ReturnType<typeof createServiceScopedVaultView>;
  /** The V48/V49 body-depth chokepoint, unmoved — this only routes to it. */
  upsertItem(row: BodyRow): void;
  /**
   * The connector's OAuth access token, resolved by `sync/access-token-registry.ts` from the BOUND
   * service — the connector does not choose its own provider, and does not hold a vault handle to
   * pass into a helper.
   */
  accessToken(): Promise<string>;
  /** SYNCHRONOUS, and returns the id: callers set it as `authorId` on the item they build. */
  resolvePerson(hints: PersonSyncHints): string | null;

  // --- index reads and writes that previously went through the raw `db` handle ---
  /** Removes one indexed item. Used by the three drive/mail connectors and Teams. */
  deleteItem(service: string, externalId: string): void;
  /** How many indexed items a service has of one type. Replaces a raw COUNT(*) in iac-sync. */
  countItems(service: string, type: string): number;
  /** Whether an item id is already indexed. Replaces a raw SELECT 1 in zoom-sync. */
  itemExists(itemId: string): boolean;
  /** Raw `metadata` JSON for one item. Parsing stays with the caller, as it is today. */
  itemMetadata(itemId: string): string | null;
  /** Body-fetch state for one item, for connectors that decide whether to re-fetch a body. */
  bodyFetchState(itemId: string): ItemBodyFetchState | null;
  /**
   * Distinct non-empty values of one `metadata` key across a service's items — GitHub's `$.repo`
   * for CircleCI and GitHub Actions, GitLab's `$.project` for its pipelines. One member rather than
   * one per connector, because the two queries were byte-identical apart from the key.
   */
  listIndexedMetadataValues(service: string, metadataKey: string): string[];
  /** PR rows still missing enrichment. GitHub-only, and the narrowest member here. */
  prEnrichCandidates(limit: number): FallbackPrCandidate[];
  /**
   * Writes one Obsidian vault's notes and prunes the departed ones in ONE transaction. Batched
   * deliberately: a per-note capability would issue N autocommitted writes and a partial sync would
   * leave `obsidian_notes` half-updated while still reporting success.
   */
  writeObsidianVault(input: {
    readonly vaultId: string;
    readonly notes: readonly ObsidianNoteWrite[];
    readonly keepIds: ReadonlySet<string>;
    readonly syncedAt: number;
  }): { upserted: number; deleted: number };
  /** One spec's endpoints plus its prune, in one transaction. Same argument as the vault writer. */
  writeApiEndpointsForSpec(input: {
    readonly specPath: string;
    readonly endpoints: readonly ApiEndpointWrite[];
    readonly keepIds: ReadonlySet<string>;
    readonly syncedAt: number;
  }): { upserted: number; deleted: number };
  /** PR rows whose changed-file list has not been fetched yet (S1-B, V55). */
  prFileCandidates(service: string, limit: number): ReturnType<typeof selectPrFileCandidates>;
  /** Records one PR's changed files. */
  recordPrChangedFiles(input: Parameters<typeof recordPrChangedFiles>[1]): void;
  upsertBlameLines(repoRoot: string, filePath: string, rows: readonly BlameRow[]): void;
  pruneBlameForFile(repoRoot: string, filePath: string): void;
}

/**
 * The gateway-side pieces a capability set closes over. `depth` is per-run, which is why
 * capabilities are built in `scheduler.ts` `runJob` rather than once at assembly: that is the first
 * point that knows both the service id and the run's resolved index depth.
 */
export interface SyncCapabilityDeps {
  vault: NimbusVault;
  db: Database;
  /**
   * The run's index depth. CAPABILITIES AND `SyncContext.depth` MUST BE BUILT TOGETHER: the
   * capability closes over this value, so `{ ...ctx, depth: "metadata_only" }` produces a context
   * whose `depth` field and whose `upsertItem` disagree, and the field is the one that loses.
   *
   * Production cannot hit that — `sync/scheduler.ts` `contextForService` is the only builder and
   * sets both from one variable. Tests must pass `depth` to `syncTestContext` rather than
   * overriding it on the result; one did, and silently indexed full bodies into a
   * `metadata_only` vault until this comment's test caught it.
   */
  depth: "metadata_only" | "summary" | "full";
  resolveServiceId?: ResolveServiceId;
  scheduleItemEmbedding?: (itemId: string) => void;
}

export function buildSyncCapabilities<S extends ConnectorServiceId>(
  deps: SyncCapabilityDeps,
  serviceId: S,
): SyncCapabilities<S> {
  return {
    getSecret: (keyName) => readConnectorSecret(deps.vault, serviceId, keyName),
    scopedVaultView: (service) => createServiceScopedVaultView(deps.vault, service),
    getSharedSecret: (family, keyName) => {
      if (!grantsFor(serviceId).includes(family)) {
        throw new Error(
          `${serviceId} has no shared-credential grant for "${family}". Add one to ` +
            "SHARED_CREDENTIAL_GRANTS in sync/sync-capabilities.ts if that is intended.",
        );
      }
      return readConnectorSecret(deps.vault, family, keyName);
    },
    upsertItem: (row) => {
      upsertIndexedItemForSync(deps, row);
    },
    accessToken: () => resolveAccessTokenForService(deps.vault, serviceId),
    resolvePerson: (hints) => resolvePersonForSync(deps.db, hints),
    deleteItem: (service, externalId) => {
      deleteItemByServiceExternal(deps.db, service, externalId);
    },
    countItems: (service, type) => countIndexedItems(deps.db, service, type),
    itemExists: (itemId) => indexedItemExists(deps.db, itemId),
    itemMetadata: (itemId) => selectItemMetadataJson(deps.db, itemId),
    bodyFetchState: (itemId) => selectItemBodyFetchState(deps.db, itemId),
    listIndexedMetadataValues: (service, key) => listDistinctMetadataValues(deps.db, service, key),
    prEnrichCandidates: (limit) => selectPrEnrichCandidates(deps.db, limit),
    writeObsidianVault: (input) => writeObsidianVault(deps, input),
    writeApiEndpointsForSpec: (input) => writeApiEndpointsForSpec(deps, input),
    prFileCandidates: (service, limit) => selectPrFileCandidates(deps.db, service, limit),
    recordPrChangedFiles: (input) => {
      recordPrChangedFiles(deps.db, input);
    },
    upsertBlameLines: (repoRoot, filePath, rows) => {
      upsertBlameLines(deps.db, repoRoot, filePath, rows);
    },
    pruneBlameForFile: (repoRoot, filePath) => {
      pruneBlameForFile(deps.db, repoRoot, filePath);
    },
  };
}

/**
 * Capabilities for a context that is NOT bound to a service — `platform/assemble.ts`'s shared
 * `syncBase`, which every connector inherits from and which therefore cannot know whose secrets to
 * resolve.
 *
 * They throw rather than being absent. An optional capability makes a missed binding a silent
 * `undefined` at runtime — the syncable reads no secret, writes no item, and reports success. A
 * throwing one names the mistake at the moment it is made. Fail-loud beats fail-open for something
 * whose whole job is to be the only way to reach a credential.
 */

/**
 * The four syncables that index only local sources — the same set `LOCAL_ONLY_SYNC_SERVICES` names
 * for I29, and for the same underlying reason: they make no outbound request, so they have no
 * credentials at all and are not in the connector catalog.
 *
 * They still write to the index, so they get the db-backed capabilities. The credential ones refuse
 * with a message saying WHY rather than the generic unbound text — "obsidian is local-only" is a
 * different mistake from "you forgot to bind a service", and conflating them would send the reader
 * to `contextForService` for a problem that is not there.
 */
export function buildLocalOnlySyncCapabilities(
  deps: SyncCapabilityDeps,
  serviceId: "blame" | "filesystem" | "obsidian" | "openapi",
): SyncCapabilities {
  const noCredentials = (what: string): never => {
    throw new Error(
      `${what} is not available to "${serviceId}": it is a local-only syncable with no credentials.`,
    );
  };
  // Bound to a catalog id purely to satisfy the generic; no credential capability is reachable.
  const db = buildSyncCapabilities(deps, "github");
  return {
    ...db,
    getSecret: () => noCredentials("getSecret"),
    getSharedSecret: () => noCredentials("getSharedSecret"),
    accessToken: () => noCredentials("accessToken"),
  };
}

export function unboundSyncCapabilities(): SyncCapabilities {
  const refuse = (what: string): never => {
    throw new Error(
      `${what} was called on an unbound SyncContext. Capabilities bind per service in ` +
        "sync/scheduler.ts contextForService(); the shared context from assemble.ts cannot know " +
        "which connector is asking.",
    );
  };
  return {
    getSecret: () => refuse("getSecret"),
    getSharedSecret: () => refuse("getSharedSecret"),
    scopedVaultView: () => refuse("scopedVaultView"),
    accessToken: () => refuse("accessToken"),
    deleteItem: () => refuse("deleteItem"),
    countItems: () => refuse("countItems"),
    itemExists: () => refuse("itemExists"),
    itemMetadata: () => refuse("itemMetadata"),
    bodyFetchState: () => refuse("bodyFetchState"),
    listIndexedMetadataValues: () => refuse("listIndexedMetadataValues"),
    prEnrichCandidates: () => refuse("prEnrichCandidates"),
    writeObsidianVault: () => refuse("writeObsidianVault"),
    writeApiEndpointsForSpec: () => refuse("writeApiEndpointsForSpec"),
    prFileCandidates: () => refuse("prFileCandidates"),
    recordPrChangedFiles: () => refuse("recordPrChangedFiles"),
    upsertBlameLines: () => refuse("upsertBlameLines"),
    pruneBlameForFile: () => refuse("pruneBlameForFile"),
    upsertItem: () => refuse("upsertItem"),
    resolvePerson: () => refuse("resolvePerson"),
  };
}
