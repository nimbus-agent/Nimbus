import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import os from "node:os";
import pino from "pino";
import type { LazyConnectorMesh } from "../connectors/lazy-mesh/index.ts";
import { LocalIndex } from "../index/local-index.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import type { SyncScheduler } from "../sync/scheduler.ts";
import { unboundSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { Syncable, SyncContext } from "../sync/types.ts";
import { registerUserMcpSyncablesFromDatabase } from "./register-user-mcp-sync.ts";

interface RegisteredCall {
  serviceId: string;
}

interface CapturedWarn {
  obj: Record<string, unknown>;
  msg: string | undefined;
}

/** Scheduler that captures the full Syncable objects for post-registration inspection. */
function fakeSchedulerFull(): {
  scheduler: SyncScheduler;
  syncables: Syncable[];
  registered: RegisteredCall[];
} {
  const syncables: Syncable[] = [];
  const registered: RegisteredCall[] = [];
  const scheduler = {
    register(syncable: Syncable): void {
      syncables.push(syncable);
      registered.push({ serviceId: syncable.serviceId });
    },
  } as unknown as SyncScheduler;
  return { scheduler, syncables, registered };
}

function fakeScheduler(): {
  scheduler: SyncScheduler;
  registered: RegisteredCall[];
} {
  const { scheduler, registered } = fakeSchedulerFull();
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

/** Mesh that throws an Error on ensureRunning. */
function fakeErrorMesh(errMsg: string): LazyConnectorMesh {
  return {
    async ensureUserMcpRunning(_id: string): Promise<void> {
      throw new Error(errMsg);
    },
  } as unknown as LazyConnectorMesh;
}

/** Mesh that throws a non-Error string on ensureRunning. */
function fakeStringErrorMesh(errValue: string): LazyConnectorMesh {
  return {
    ensureUserMcpRunning(_id: string): Promise<void> {
      return Promise.reject(errValue);
    },
  } as unknown as LazyConnectorMesh;
}

/** SyncContext with a capturing warn logger. */
function makeSyncContext(_db: Database): { ctx: SyncContext; warns: CapturedWarn[] } {
  const warns: CapturedWarn[] = [];
  const baseLogger = pino({ level: "silent" });
  const logger = Object.create(baseLogger) as typeof baseLogger;
  (logger as unknown as { warn: (...args: unknown[]) => void }).warn = (
    obj: unknown,
    msg?: unknown,
  ) => {
    warns.push({
      obj: (obj ?? {}) as Record<string, unknown>,
      msg: typeof msg === "string" ? msg : undefined,
    });
  };
  return {
    ctx: {
      ...unboundSyncCapabilities(),
      logger,
      rateLimiter: new ProviderRateLimiter(),
      sandboxCwd: os.tmpdir(),
      credentialFor: () => ({ credential: "personal" }),
      runTeamList: async () => [],
      depth: "full",
    },
    warns,
  };
}

function makeDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

describe("registerUserMcpSyncablesFromDatabase", () => {
  it("is a no-op when no user MCP rows exist (empty-store / vault-key-missing analog)", () => {
    const db = makeDb();
    const { scheduler, registered } = fakeScheduler();
    const { mesh } = fakeMesh();
    registerUserMcpSyncablesFromDatabase(db, scheduler, mesh);
    expect(registered).toEqual([]);
  });

  it("registers a Syncable per row, threading the row's service_id; the syncable defers to mesh.ensureUserMcpRunning", async () => {
    const db = makeDb();
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
    expect(registered.map((r) => r.serviceId)).toEqual(["mcp_alpha", "mcp_beta"]);
    expect(ensureCalls).toEqual([]);
  });

  it("sync() on the returned syncable invokes mesh.ensureUserMcpRunning with the correct service_id (success path)", async () => {
    const db = makeDb();
    db.run(
      `INSERT INTO user_mcp_connector (service_id, command, args_json, created_at) VALUES (?, ?, ?, ?)`,
      ["mcp_gamma", "node", '["server.js"]', Date.now()],
    );
    const { scheduler, syncables } = fakeSchedulerFull();
    const { mesh, ensureCalls } = fakeMesh();
    registerUserMcpSyncablesFromDatabase(db, scheduler, mesh);

    expect(syncables).toHaveLength(1);
    const syncable = syncables[0];
    if (syncable === undefined) throw new Error("syncable must exist");

    const { ctx, warns } = makeSyncContext(db);
    const result = await syncable.sync(ctx, null);

    // ensureRunning was called with the correct service_id
    expect(ensureCalls).toEqual(["mcp_gamma"]);
    // Returns a noop result with the default cursor
    expect(result.cursor).toBe("user_mcp");
    expect(result.itemsUpserted).toBe(0);
    expect(result.itemsDeleted).toBe(0);
    expect(result.hasMore).toBe(false);
    // No warnings on success path
    expect(warns).toHaveLength(0);
  });

  it("sync() preserves an inbound cursor (non-null) via the ?? fallback", async () => {
    const db = makeDb();
    db.run(
      `INSERT INTO user_mcp_connector (service_id, command, args_json, created_at) VALUES (?, ?, ?, ?)`,
      ["mcp_delta", "python", '["mcp_server.py"]', Date.now()],
    );
    const { scheduler, syncables } = fakeSchedulerFull();
    const { mesh } = fakeMesh();
    registerUserMcpSyncablesFromDatabase(db, scheduler, mesh);

    const syncable = syncables[0];
    if (syncable === undefined) throw new Error("syncable must exist");

    const { ctx } = makeSyncContext(db);
    const result = await syncable.sync(ctx, "watermark-2024-06-01");

    // Inbound cursor is preserved (not overwritten by "user_mcp" default)
    expect(result.cursor).toBe("watermark-2024-06-01");
    expect(result.itemsUpserted).toBe(0);
  });

  it("sync() catches an Error from ensureRunning, warns with err.message + serviceId, returns noop", async () => {
    const db = makeDb();
    db.run(
      `INSERT INTO user_mcp_connector (service_id, command, args_json, created_at) VALUES (?, ?, ?, ?)`,
      ["mcp_error_test", "missing-binary", "[]", Date.now()],
    );
    const { scheduler, syncables } = fakeSchedulerFull();
    registerUserMcpSyncablesFromDatabase(db, scheduler, fakeErrorMesh("spawn failed: ENOENT"));

    const syncable = syncables[0];
    if (syncable === undefined) throw new Error("syncable must exist");

    const { ctx, warns } = makeSyncContext(db);
    const result = await syncable.sync(ctx, null);

    // Still returns a noop result (error is swallowed)
    expect(result.cursor).toBe("user_mcp");
    expect(result.itemsUpserted).toBe(0);
    // Warning was emitted with the Error message
    expect(warns).toHaveLength(1);
    expect(warns[0]?.obj["serviceId"]).toBe("mcp_error_test");
    expect(warns[0]?.obj["err"]).toBe("spawn failed: ENOENT");
    expect(warns[0]?.msg).toBe("user_mcp: ensureRunning failed");
  });

  it("sync() catches a non-Error thrown value, uses String(e) as err, returns noop (e instanceof Error = false arm)", async () => {
    const db = makeDb();
    db.run(
      `INSERT INTO user_mcp_connector (service_id, command, args_json, created_at) VALUES (?, ?, ?, ?)`,
      ["mcp_string_throw", "bad-cmd", "[]", Date.now()],
    );
    const { scheduler, syncables } = fakeSchedulerFull();
    registerUserMcpSyncablesFromDatabase(db, scheduler, fakeStringErrorMesh("raw-string-error"));

    const syncable = syncables[0];
    if (syncable === undefined) throw new Error("syncable must exist");

    const { ctx, warns } = makeSyncContext(db);
    const result = await syncable.sync(ctx, null);

    expect(result.cursor).toBe("user_mcp");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.obj["err"]).toBe("raw-string-error");
    expect(warns[0]?.obj["serviceId"]).toBe("mcp_string_throw");
    expect(warns[0]?.msg).toBe("user_mcp: ensureRunning failed");
  });

  it("registers multiple rows and each syncable is independently wired to its own service_id", async () => {
    const db = makeDb();
    db.run(
      `INSERT INTO user_mcp_connector (service_id, command, args_json, created_at) VALUES (?, ?, ?, ?)`,
      ["mcp_first", "cmd1", "[]", Date.now()],
    );
    db.run(
      `INSERT INTO user_mcp_connector (service_id, command, args_json, created_at) VALUES (?, ?, ?, ?)`,
      ["mcp_second", "cmd2", "[]", Date.now()],
    );
    const { scheduler, syncables } = fakeSchedulerFull();
    const { mesh, ensureCalls } = fakeMesh();
    registerUserMcpSyncablesFromDatabase(db, scheduler, mesh);

    expect(syncables).toHaveLength(2);

    const first = syncables[0];
    const second = syncables[1];
    if (first === undefined || second === undefined) throw new Error("both syncables must exist");

    const { ctx } = makeSyncContext(db);
    await first.sync(ctx, null);
    await second.sync(ctx, null);

    // Each syncable passed the correct service_id to ensureUserMcpRunning
    expect(ensureCalls).toEqual(["mcp_first", "mcp_second"]);
    expect(first.serviceId).toBe("mcp_first");
    expect(second.serviceId).toBe("mcp_second");
  });
});
