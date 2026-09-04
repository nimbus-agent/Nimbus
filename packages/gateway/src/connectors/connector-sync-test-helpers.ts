import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import pino from "pino";

import { LocalIndex } from "../index/local-index.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import {
  buildLocalOnlySyncCapabilities,
  buildSyncCapabilities,
  type SyncCapabilities,
  type SyncCapabilityDeps,
  unboundSyncCapabilities,
} from "../sync/sync-capabilities.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { ConnectorServiceId } from "./connector-catalog.ts";

export type LocalOnlySyncServiceId = "blame" | "filesystem" | "obsidian" | "openapi";
// A Set, so membership is `has` rather than `includes` — which also removes the
// `as LocalOnlySyncServiceId` the array form needed at the call site to narrow a
// wider ConnectorServiceId, i.e. a cast that asserted the very thing being tested.
const LOCAL_ONLY_SYNC_SERVICE_IDS: ReadonlySet<string> = new Set<LocalOnlySyncServiceId>([
  "blame",
  "filesystem",
  "obsidian",
  "openapi",
]);

export const EMPTY_NIMBUS_VAULT: NimbusVault = {
  set: async () => {},
  get: async () => null,
  delete: async () => {},
  listKeys: async () => [],
};

export function createMemoryIndexDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

export function createStubVault(entries: Readonly<Record<string, string | null>>): NimbusVault {
  return {
    set: async () => {},
    get: async (k: string) => (Object.hasOwn(entries, k) ? (entries[k] ?? null) : null),
    delete: async () => {},
    listKeys: async () => [],
  };
}

export function silentSyncContextExtras(): Pick<
  SyncContext,
  | "logger"
  | "rateLimiter"
  | "sandboxCwd"
  | "credentialFor"
  | "runTeamList"
  | "depth"
  | "getSecret"
  | "getSharedSecret"
  | "scopedVaultView"
  | "accessToken"
  | "deleteItem"
  | "countItems"
  | "itemExists"
  | "bodyFetchState"
  | "itemMetadata"
  | "listIndexedMetadataValues"
  | "prEnrichCandidates"
  | "upsertBlameLines"
  | "prFileCandidates"
  | "recordPrChangedFiles"
  | "writeObsidianVault"
  | "writeApiEndpointsForSpec"
  | "pruneBlameForFile"
  | "upsertItem"
  | "resolvePerson"
> {
  return {
    // UNBOUND by default: these throw a named error if a test reaches one without having said
    // which service it is. Callers that DO have a db and vault should pass them — see the
    // overload below — or build the context with `syncTestContext(db, vault, serviceId)`.
    ...unboundSyncCapabilities(),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter(),
    // Wave 7b SyncContext members — personal-credential defaults for sync tests.
    sandboxCwd: os.tmpdir(),
    credentialFor: () => ({ credential: "personal" }),
    runTeamList: async () => [],
    // Connector sync tests exercise the full-body path unless a test overrides it.
    depth: "full",
  };
}

/**
 * @param serviceId Binds the scoped capabilities to that connector, exactly as
 * `sync/scheduler.ts` does in production. Omit it only for a test that never reaches a capability:
 * the unbound set THROWS a named error rather than returning undefined, so a test that does reach
 * one fails loudly instead of silently reading no secret and asserting a happy path.
 */
/**
 * The capability half of a test context, bound to a real service. For tests that build their
 * context as an object literal rather than through `syncTestContext` — spread it AFTER
 * `silentSyncContextExtras()`, whose defaults are the throwing unbound set.
 */
export function boundTestCapabilities(
  db: Database,
  vault: NimbusVault,
  serviceId: ConnectorServiceId,
): SyncCapabilities {
  return buildSyncCapabilities({ vault, db, depth: "full" }, serviceId);
}

export function syncTestContext(
  db: Database,
  vault: NimbusVault,
  serviceId?: ConnectorServiceId | LocalOnlySyncServiceId,
  /** Pass depth HERE, never by overriding `.depth` on the result — see SyncCapabilityDeps.depth. */
  depth: "metadata_only" | "summary" | "full" = "full",
  /** Likewise: `upsertItem` closes over this, so overriding it on the result does not reach it. */
  resolveServiceId?: SyncCapabilityDeps["resolveServiceId"],
): SyncContext {
  const extras = {
    ...silentSyncContextExtras(),
    depth,
    ...(resolveServiceId === undefined ? {} : { resolveServiceId }),
  };
  const capDeps = {
    vault,
    db,
    depth,
    ...(resolveServiceId === undefined ? {} : { resolveServiceId }),
  };
  const caps =
    serviceId === undefined
      ? unboundSyncCapabilities()
      : LOCAL_ONLY_SYNC_SERVICE_IDS.has(serviceId)
        ? buildLocalOnlySyncCapabilities(capDeps, serviceId as LocalOnlySyncServiceId)
        : buildSyncCapabilities(capDeps, serviceId as ConnectorServiceId);
  // `extras` carries the UNBOUND capability set as its default, so it must be spread FIRST — the
  // bound `caps` are the override, not the other way round. Reversed, every test silently got the
  // throwing capabilities back and 889 of them failed at once.
  return { ...extras, ...caps };
}

export function expectSyncNoopResult(
  r: Pick<SyncResult, "itemsUpserted" | "itemsDeleted" | "cursor">,
): void {
  expect(r.itemsUpserted).toBe(0);
  expect(r.itemsDeleted).toBe(0);
  expect(r.cursor).toBeNull();
}

export function expectServiceItemCount(db: Database, service: string, count: number): void {
  // db.query() is cache-managed by bun:sqlite and released on close; a bare
  // db.prepare() here left the database file pinned open for every connector
  // test that called this helper (#969).
  const row = db.query("SELECT COUNT(*) AS c FROM item WHERE service = ?").get(service) as {
    c: number;
  };
  expect(row.c).toBe(count);
}

export function testConnectorSyncNoop(
  name: string,
  createSyncable: () => Syncable,
  noopVault: NimbusVault,
): void {
  test(name, async () => {
    const db = createMemoryIndexDb();
    const sync = createSyncable();
    // Bind to the syncable's OWN declared service rather than a name derived from the test file:
    // the syncable is the authority on which connector it is.
    const r = await sync.sync(
      syncTestContext(db, noopVault, sync.serviceId as ConnectorServiceId),
      null,
    );
    expectSyncNoopResult(r);
  });
}

export type SyncTestFetchParams = Parameters<typeof fetch>;

export function urlFromFetchInput(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

export function describeWithFetchRestore(name: string, fn: () => void): void {
  describe(name, () => {
    const origFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = origFetch;
    });
    fn();
  });
}
