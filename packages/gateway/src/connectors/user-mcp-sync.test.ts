import { describe, expect, test } from "bun:test";
import os from "node:os";
import pino from "pino";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { unboundSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { SyncContext } from "../sync/types.ts";
import { createMemoryIndexDb, EMPTY_NIMBUS_VAULT } from "./connector-sync-test-helpers.ts";
import { createUserMcpSyncable } from "./user-mcp-sync.ts";

interface CapturedWarn {
  readonly obj: Record<string, unknown>;
  readonly msg: string | undefined;
}

function makeCapturingContext(): {
  ctx: SyncContext;
  warns: CapturedWarn[];
} {
  const db = createMemoryIndexDb();
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
      db,
      vault: EMPTY_NIMBUS_VAULT,
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

describe("createUserMcpSyncable", () => {
  test("exposes serviceId, defaultIntervalMs (24h), initialSyncDepthDays (0)", () => {
    const sync = createUserMcpSyncable("my-mcp", async () => {});
    expect(sync.serviceId).toBe("my-mcp");
    expect(sync.defaultIntervalMs).toBe(86_400_000);
    expect(sync.initialSyncDepthDays).toBe(0);
  });

  test("first sync (null cursor) invokes ensureRunning and returns 'user_mcp' cursor noop", async () => {
    let called = 0;
    const sync = createUserMcpSyncable("svc-a", async () => {
      called += 1;
    });
    const { ctx, warns } = makeCapturingContext();

    const result = await sync.sync(ctx, null);

    expect(called).toBe(1);
    expect(result.cursor).toBe("user_mcp");
    expect(result.itemsUpserted).toBe(0);
    expect(result.itemsDeleted).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(warns).toHaveLength(0);
  });

  test("incremental sync (existing cursor) preserves the inbound cursor", async () => {
    const sync = createUserMcpSyncable("svc-b", async () => {});
    const { ctx } = makeCapturingContext();

    const result = await sync.sync(ctx, "watermark-2024-01-01");

    expect(result.cursor).toBe("watermark-2024-01-01");
    expect(result.itemsUpserted).toBe(0);
    expect(result.itemsDeleted).toBe(0);
  });

  test("ensureRunning Error → warn with err message + serviceId; still returns noop result", async () => {
    const sync = createUserMcpSyncable("svc-c", async () => {
      throw new Error("spawn failed: ENOENT");
    });
    const { ctx, warns } = makeCapturingContext();

    const result = await sync.sync(ctx, null);

    expect(result.cursor).toBe("user_mcp");
    expect(result.itemsUpserted).toBe(0);

    expect(warns).toHaveLength(1);
    const captured = warns[0];
    expect(captured?.obj["serviceId"]).toBe("svc-c");
    expect(captured?.obj["err"]).toBe("spawn failed: ENOENT");
    expect(captured?.msg).toBe("user_mcp: ensureRunning failed");
  });

  test("ensureRunning throws non-Error (string) → warn uses String(e); still returns noop", async () => {
    const sync = createUserMcpSyncable("svc-d", async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal -- intentional non-Error path
      throw "boom-string";
    });
    const { ctx, warns } = makeCapturingContext();

    const result = await sync.sync(ctx, "keep-me");

    expect(result.cursor).toBe("keep-me");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.obj["err"]).toBe("boom-string");
    expect(warns[0]?.obj["serviceId"]).toBe("svc-d");
  });

  test("ensureRunning is invoked again on every sync call (no caching of success)", async () => {
    let calls = 0;
    const sync = createUserMcpSyncable("svc-e", async () => {
      calls += 1;
    });
    const { ctx } = makeCapturingContext();

    await sync.sync(ctx, null);
    await sync.sync(ctx, "cursor-2");
    await sync.sync(ctx, "cursor-3");

    expect(calls).toBe(3);
  });

  test("ensureRunning is invoked again after a failure (no quarantine of the syncable)", async () => {
    let attempt = 0;
    const sync = createUserMcpSyncable("svc-f", async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("first try fails");
      }
    });
    const { ctx, warns } = makeCapturingContext();

    const r1 = await sync.sync(ctx, null);
    const r2 = await sync.sync(ctx, null);

    expect(attempt).toBe(2);
    expect(warns).toHaveLength(1);
    expect(r1.cursor).toBe("user_mcp");
    expect(r2.cursor).toBe("user_mcp");
  });
});
