import { Database } from "bun:sqlite";
import pino, { type Logger } from "pino";
import type { ConnectorServiceId } from "../../src/connectors/connector-catalog.ts";
import { LocalIndex } from "../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../src/sync/rate-limiter.ts";
import {
  buildSyncCapabilities,
  unboundSyncCapabilities,
} from "../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../src/sync/types.ts";
import { createMockVault } from "../../src/vault/mock.ts";
import type { NimbusVault } from "../../src/vault/nimbus-vault.ts";
import { MockFetch } from "./mock-fetch.ts";
import { MockNotificationLog } from "./mock-notification-log.ts";
import { MockSpawn } from "./mock-spawn.ts";

export interface ConnectorSyncFixture {
  readonly db: Database;
  readonly vault: NimbusVault;
  readonly fetchMock: MockFetch;
  readonly spawnMock: MockSpawn;
  readonly notifications: MockNotificationLog;
  readonly logger: Logger;
  readonly rateLimiter: ProviderRateLimiter;

  /**
   * @param serviceId The connector this context belongs to. Capabilities are scoped to it, so a
   * fixture that omits it gets the throwing unbound set rather than silently reading nothing.
   */
  createSyncContext(serviceId?: ConnectorServiceId): SyncContext;

  cleanup(): void;
}

export function createConnectorSyncFixture(): ConnectorSyncFixture {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);

  const vault = createMockVault();
  const fetchMock = new MockFetch();
  const spawnMock = new MockSpawn();
  const notifications = new MockNotificationLog();
  const logger = pino({ level: "silent" });
  const rateLimiter = new ProviderRateLimiter();

  return {
    db,
    vault,
    fetchMock,
    spawnMock,
    notifications,
    logger,
    rateLimiter,
    createSyncContext(serviceId?: ConnectorServiceId): SyncContext {
      return {
        ...(serviceId === undefined
          ? unboundSyncCapabilities()
          : buildSyncCapabilities({ vault, db, depth: "full" }, serviceId)),
        logger,
        rateLimiter,
      } as SyncContext;
    },
    cleanup(): void {
      fetchMock.restore();
      spawnMock.restore();
      db.close();
    },
  };
}
