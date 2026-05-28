import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino, { type Logger } from "pino";

import { LocalIndex } from "../../src/index/local-index.ts";
import { createMockVault } from "../../src/vault/mock.ts";
import type { NimbusVault } from "../../src/vault/nimbus-vault.ts";
import { MockNotificationLog } from "./mock-notification-log.ts";

export interface RpcFixture {
  readonly db: Database;
  readonly localIndex: LocalIndex;
  readonly vault: NimbusVault;
  readonly notifications: MockNotificationLog;
  readonly logger: Logger;
  readonly dataDir: string;
  readonly configDir: string;
  notify(method: string, params: Record<string, unknown>): void;
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
