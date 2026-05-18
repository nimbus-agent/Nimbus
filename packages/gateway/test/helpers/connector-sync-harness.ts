import { Database } from "bun:sqlite";
import pino, { type Logger } from "pino";

import { LocalIndex } from "../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../src/sync/rate-limiter.ts";
import type { SyncContext } from "../../src/sync/types.ts";
import { createMockVault } from "../../src/vault/mock.ts";
import type { NimbusVault } from "../../src/vault/nimbus-vault.ts";
import { MockFetch } from "./mock-fetch.ts";
import { MockNotificationLog } from "./mock-notification-log.ts";

export interface ConnectorSyncFixture {
  readonly db: Database;
  readonly vault: NimbusVault;
  readonly fetchMock: MockFetch;
  readonly notifications: MockNotificationLog;
  readonly logger: Logger;
  readonly rateLimiter: ProviderRateLimiter;

  /** Build the SyncContext shape consumed by `Syncable.sync(ctx, cursor)`. */
  createSyncContext(): SyncContext;

  /** Close the in-memory DB and restore the original `globalThis.fetch`. */
  cleanup(): void;
}

/**
 * Returns a fully-wired fixture for a single connector-sync test.
 *
 * Usage:
 *
 *   const fixture = createConnectorSyncFixture();
 *   fixture.fetchMock.install();
 *   try {
 *     await fixture.vault.set("slack.oauth", JSON.stringify({ access_token: "..." }));
 *     fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: true });
 *     // ...stage more responses, then:
 *     const result = await syncable.sync(fixture.createSyncContext(), null);
 *   } finally {
 *     fixture.cleanup();
 *   }
 *
 * Notes:
 * - No `seedVault` option: MockVault.set is async, so tests do explicit
 *   `await fixture.vault.set(...)`. Keeping the factory synchronous keeps
 *   teardown simple and avoids the fire-and-forget bug in the original WIP.
 * - `fetchMock.install()` is opt-in: tests that don't make HTTP calls can skip it.
 *   `cleanup()` always calls `restore()` — safe even if `install()` was never called.
 */
export function createConnectorSyncFixture(): ConnectorSyncFixture {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);

  const vault = createMockVault();
  const fetchMock = new MockFetch();
  const notifications = new MockNotificationLog();
  const logger = pino({ level: "silent" });
  const rateLimiter = new ProviderRateLimiter();

  return {
    db,
    vault,
    fetchMock,
    notifications,
    logger,
    rateLimiter,
    createSyncContext(): SyncContext {
      return {
        vault,
        db,
        logger,
        rateLimiter,
      };
    },
    cleanup(): void {
      fetchMock.restore();
      db.close();
    },
  };
}
