import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import pino from "pino";

import { LocalIndex } from "../index/local-index.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

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
  "logger" | "rateLimiter" | "sandboxCwd" | "credentialFor" | "runTeamList" | "depth"
> {
  return {
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

export function syncTestContext(db: Database, vault: NimbusVault): SyncContext {
  return { db, vault, ...silentSyncContextExtras() };
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
    const r = await sync.sync(syncTestContext(db, noopVault), null);
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
