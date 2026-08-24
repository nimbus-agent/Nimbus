import { expect, test } from "bun:test";
import { upsertIndexedItem } from "../index/item-store.ts";
import {
  boundTestCapabilities,
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  EMPTY_NIMBUS_VAULT,
  expectSyncNoopResult,
  silentSyncContextExtras,
  syncTestContext,
  testConnectorSyncNoop,
} from "./connector-sync-test-helpers.ts";
import { createIacSyncable } from "./iac-sync.ts";

describeWithFetchRestore("iac-sync", () => {
  testConnectorSyncNoop(
    "no-op when iac not enabled",
    () => createIacSyncable({ ensureIacMcpRunning: async () => {} }),
    EMPTY_NIMBUS_VAULT,
  );

  test("heartbeat when enabled", async () => {
    const sync = createIacSyncable({ ensureIacMcpRunning: async () => {} });
    const db = createMemoryIndexDb();
    const ctx = {
      vault: createStubVault({ "iac.enabled": "1" }),
      db,
      ...silentSyncContextExtras(),
      ...boundTestCapabilities(db, createStubVault({ "iac.enabled": "1" }), "iac"),
    };
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    expect(r.bytesTransferred).toBe(0);
    const row = db
      .query(`SELECT id, type FROM item WHERE service = 'iac' AND external_id = 'drift_baseline'`)
      .get() as { id: string; type: string } | undefined;
    expect(row?.type).toBe("sync_heartbeat");
    expect(row?.id).toBe("iac:drift_baseline");
  });

  // ─── noop: enabled key is "0" (non-null but not "1") ────────────────────────
  test("no-op when iac enabled key is '0' (not '1')", async () => {
    const sync = createIacSyncable({ ensureIacMcpRunning: async () => {} });
    const db = createMemoryIndexDb();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "iac.enabled": "0" }), "iac"),
      null,
    );
    expectSyncNoopResult(r);
  });

  // ─── noop preserves existing cursor ─────────────────────────────────────────
  test("no-op returns the existing cursor unchanged", async () => {
    const sync = createIacSyncable({ ensureIacMcpRunning: async () => {} });
    const db = createMemoryIndexDb();
    const existingCursor = "nimbus-iac1:abc123";
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "iac.enabled": "0" }), "iac"),
      existingCursor,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.itemsDeleted).toBe(0);
    expect(r.cursor).toBe(existingCursor);
  });

  // ─── lambdaCount > 0: pre-seeded AWS lambda rows ───────────────────────────
  test("heartbeat body preview reflects pre-indexed AWS lambda count", async () => {
    const now = Date.now();
    const db = createMemoryIndexDb();

    // Pre-insert 3 AWS lambda_function items so the COUNT query returns 3
    for (let i = 0; i < 3; i++) {
      upsertIndexedItem(db, {
        service: "aws",
        type: "lambda_function",
        externalId: `fn-${String(i)}`,
        title: `Lambda ${String(i)}`,
        modifiedAt: now - i * 1000,
        syncedAt: now,
      });
    }

    const sync = createIacSyncable({ ensureIacMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "iac.enabled": "1" }), "iac"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);

    const row = db
      .query(
        `SELECT body_preview, metadata FROM item WHERE service = 'iac' AND external_id = 'drift_baseline'`,
      )
      .get() as { body_preview: string; metadata: string } | undefined;
    expect(row?.body_preview).toBe("AWS Lambda (indexed): 3");
    const meta = JSON.parse(row?.metadata ?? "{}") as { awsLambdaIndexedCount: number };
    expect(meta.awsLambdaIndexedCount).toBe(3);
  });

  // ─── defensive `lambdaRow?.c ?? 0` arms: COUNT query yields no row ───────────
  test("lambda COUNT returning no row → defensive ?? 0 fallback renders 0", async () => {
    const real = createMemoryIndexDb();
    // Proxy so ONLY the lambda COUNT query yields no row (.get() → undefined),
    // exercising the `lambdaRow?.c ?? 0` short-circuit + fallback arms. A real
    // SQLite COUNT(*) always returns one row, so these defensive branches are
    // otherwise unreachable. Every other call delegates to real SQLite.
    const db = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (sql: string) =>
            sql.includes("lambda_function")
              ? ({ get: () => undefined } as unknown as ReturnType<(typeof target)["query"]>)
              : target.query(sql);
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as unknown as typeof real;

    const sync = createIacSyncable({ ensureIacMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "iac.enabled": "1" }), "iac"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);

    const row = real
      .query(
        `SELECT body_preview, metadata FROM item WHERE service = 'iac' AND external_id = 'drift_baseline'`,
      )
      .get() as { body_preview: string; metadata: string } | undefined;
    expect(row?.body_preview).toBe("AWS Lambda (indexed): 0");
    const meta = JSON.parse(row?.metadata ?? "{}") as { awsLambdaIndexedCount: number };
    expect(meta.awsLambdaIndexedCount).toBe(0);
  });

  // ─── cursor encodes tick ─────────────────────────────────────────────────────
  test("returned cursor encodes the iac1 prefix and a tick timestamp", async () => {
    const sync = createIacSyncable({ ensureIacMcpRunning: async () => {} });
    const db = createMemoryIndexDb();
    const before = Date.now();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "iac.enabled": "1" }), "iac"),
      null,
    );
    const after = Date.now();

    expect(r.cursor).toMatch(/^nimbus-iac1:/);
    const b64 = r.cursor!.slice("nimbus-iac1:".length);
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as {
      tick: number;
    };
    expect(payload.tick).toBeGreaterThanOrEqual(before);
    expect(payload.tick).toBeLessThanOrEqual(after);
  });

  // ─── hasMore and itemsDeleted are always fixed ───────────────────────────────
  test("sync result has hasMore=false and itemsDeleted=0", async () => {
    const sync = createIacSyncable({ ensureIacMcpRunning: async () => {} });
    const db = createMemoryIndexDb();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "iac.enabled": "1" }), "iac"),
      null,
    );
    expect(r.hasMore).toBe(false);
    expect(r.itemsDeleted).toBe(0);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ─── ensureIacMcpRunning throws → propagates ────────────────────────────────
  test("propagates error thrown by ensureIacMcpRunning", async () => {
    const sync = createIacSyncable({
      ensureIacMcpRunning: async () => {
        throw new Error("MCP startup failure");
      },
    });
    const db = createMemoryIndexDb();
    await expect(
      sync.sync(syncTestContext(db, createStubVault({ "iac.enabled": "1" }), "iac"), null),
    ).rejects.toThrow("MCP startup failure");
  });

  // ─── ensureIacMcpRunning is called even before the enabled check ─────────────
  test("ensureIacMcpRunning is called before enabled check — throws before noop", async () => {
    let called = false;
    const sync = createIacSyncable({
      ensureIacMcpRunning: async () => {
        called = true;
        throw new Error("startup fail");
      },
    });
    const db = createMemoryIndexDb();
    // Even with empty vault (would be noop), the MCP runner is called first
    await expect(sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "iac"), null)).rejects.toThrow(
      "startup fail",
    );
    expect(called).toBe(true);
  });

  // ─── serviceId and interval are correct ────────────────────────────────────
  test("syncable has correct serviceId, defaultIntervalMs, and initialSyncDepthDays", () => {
    const sync = createIacSyncable({ ensureIacMcpRunning: async () => {} });
    expect(sync.serviceId).toBe("iac");
    expect(sync.defaultIntervalMs).toBe(120 * 1000);
    expect(sync.initialSyncDepthDays).toBe(1);
  });
});
