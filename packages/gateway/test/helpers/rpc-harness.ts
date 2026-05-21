import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino, { type Logger } from "pino";

import { LocalIndex } from "../../src/index/local-index.ts";
import { createMockVault } from "../../src/vault/mock.ts";
import type { NimbusVault } from "../../src/vault/nimbus-vault.ts";
import { MockNotificationLog } from "./mock-notification-log.ts";

/**
 * Fixture for IPC RPC dispatcher tests. Provides the boilerplate that every
 * `*-rpc.test.ts` was duplicating: a fresh in-memory SQLite with the full
 * LocalIndex schema, a MockVault, a MockNotificationLog (with a bound
 * `notify` callback for ctx shapes that take one), a silent pino logger,
 * and a temp dataDir/configDir.
 *
 * The fixture deliberately does NOT define a single `ServerCtx` — each RPC
 * dispatcher (DiagnosticsRpcContext, ConnectorRpcHandlerContext, etc.)
 * has its own context type. Tests build the exact shape they need using
 * the primitive fields exposed here.
 *
 * Usage:
 *
 *   const fixture = createRpcFixture();
 *   try {
 *     const result = dispatchPeopleRpc({
 *       method: "people.list",
 *       params: { limit: 10 },
 *       localIndex: fixture.localIndex,
 *     });
 *     expect(result.kind).toBe("hit");
 *   } finally {
 *     fixture.cleanup();
 *   }
 */
export interface RpcFixture {
  readonly db: Database;
  readonly localIndex: LocalIndex;
  readonly vault: NimbusVault;
  readonly notifications: MockNotificationLog;
  readonly logger: Logger;
  /** mkdtemp-backed temp dir; doubles as configDir for tests that need both. */
  readonly dataDir: string;
  readonly configDir: string;
  /** Convenience callback bound to `notifications.emit`. */
  notify(method: string, params: Record<string, unknown>): void;
  /** Close the in-memory DB and remove the temp dir. */
  cleanup(): void;
}

export function createRpcFixture(): RpcFixture {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const localIndex = new LocalIndex(db);

  const vault = createMockVault();
  const notifications = new MockNotificationLog();
  const logger = pino({ level: "silent" });
  const dataDir = mkdtempSync(join(tmpdir(), "nimbus-rpc-"));

  return {
    db,
    localIndex,
    vault,
    notifications,
    logger,
    dataDir,
    configDir: dataDir,
    notify(method: string, params: Record<string, unknown>): void {
      notifications.emit(method, params);
    },
    cleanup(): void {
      try {
        db.close();
      } catch {
        /* best-effort */
      }
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* best-effort — Windows can pin temp dirs briefly */
      }
    },
  };
}
