import type { Database } from "bun:sqlite";

import type { LazyConnectorMesh } from "../connectors/lazy-mesh/index.ts";
import { listUserMcpConnectors } from "../connectors/user-mcp-store.ts";
import { createUserMcpSyncable } from "../connectors/user-mcp-sync.ts";
import type { SyncScheduler } from "../sync/scheduler.ts";

export function registerUserMcpSyncablesFromDatabase(
  db: Database,
  syncScheduler: SyncScheduler,
  mesh: LazyConnectorMesh,
): void {
  for (const row of listUserMcpConnectors(db)) {
    syncScheduler.register(
      createUserMcpSyncable(row.service_id, () => mesh.ensureUserMcpRunning(row.service_id)),
    );
  }
}
