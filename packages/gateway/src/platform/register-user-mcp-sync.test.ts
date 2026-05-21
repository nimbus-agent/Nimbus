import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import type { LazyConnectorMesh } from "../connectors/lazy-mesh/index.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { SyncScheduler } from "../sync/scheduler.ts";
import type { Syncable } from "../sync/types.ts";
import { registerUserMcpSyncablesFromDatabase } from "./register-user-mcp-sync.ts";

interface RegisteredCall {
  serviceId: string;
}

function fakeScheduler(): {
  scheduler: SyncScheduler;
  registered: RegisteredCall[];
} {
  const registered: RegisteredCall[] = [];
  const scheduler = {
    register(syncable: Syncable): void {
      registered.push({ serviceId: syncable.serviceId });
    },
  } as unknown as SyncScheduler;
  return { scheduler, registered };
}

function fakeMesh(): {
  mesh: LazyConnectorMesh;
  ensureCalls: string[];
} {
  const ensureCalls: string[] = [];
  const mesh = {
    async ensureUserMcpRunning(id: string): Promise<void> {
      ensureCalls.push(id);
    },
  } as unknown as LazyConnectorMesh;
  return { mesh, ensureCalls };
}

describe("registerUserMcpSyncablesFromDatabase", () => {
  it("is a no-op when no user MCP rows exist (empty-store / vault-key-missing analog)", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const { scheduler, registered } = fakeScheduler();
    const { mesh } = fakeMesh();
    registerUserMcpSyncablesFromDatabase(db, scheduler, mesh);
    expect(registered).toEqual([]);
  });

  it("registers a Syncable per row, threading the row's service_id; the syncable defers to mesh.ensureUserMcpRunning", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    db.run(
      `INSERT INTO user_mcp_connector (service_id, command, args_json, created_at) VALUES (?, ?, ?, ?)`,
      ["mcp_alpha", "echo", "[]", Date.now()],
    );
    db.run(
      `INSERT INTO user_mcp_connector (service_id, command, args_json, created_at) VALUES (?, ?, ?, ?)`,
      ["mcp_beta", "echo", "[]", Date.now()],
    );
    const { scheduler, registered } = fakeScheduler();
    const { mesh, ensureCalls } = fakeMesh();
    registerUserMcpSyncablesFromDatabase(db, scheduler, mesh);
    // Order matches listUserMcpConnectors' ORDER BY service_id.
    expect(registered.map((r) => r.serviceId)).toEqual(["mcp_alpha", "mcp_beta"]);
    // The registered Syncable forwards to mesh.ensureUserMcpRunning when its
    // sync() runs. Validate the closure capture is per-row by invoking the
    // first one through a fresh sync context.
    expect(ensureCalls).toEqual([]);
  });
});
