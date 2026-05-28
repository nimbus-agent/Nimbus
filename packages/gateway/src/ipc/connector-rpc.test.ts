import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { dispatchConnectorRpc } from "./connector-rpc.ts";
import { ConnectorRpcError } from "./connector-rpc-shared.ts";

function makeIndex(): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const idx = new LocalIndex(db);
  db.run(
    `INSERT INTO scheduler_state
       (service_id, cursor, interval_ms, last_sync_at, next_sync_at, status, error_msg, consecutive_failures, paused)
     VALUES ('github', NULL, 60000, NULL, ?, 'ok', NULL, 0, 0)`,
    [Date.now()],
  );
  return idx;
}

const baseOpts = {
  vault: {} as unknown as NimbusVault,
  openUrl: async (_url: string): Promise<void> => {},
  syncScheduler: undefined,
} as const;

describe("connector.setConfig", () => {
  test("returns miss for unknown method", async () => {
    const r = await dispatchConnectorRpc({
      ...baseOpts,
      localIndex: makeIndex(),
      method: "connector.unknown",
      params: {},
    });
    expect(r.kind).toBe("miss");
  });

  test("sets intervalMs only", async () => {
    const r = await dispatchConnectorRpc({
      ...baseOpts,
      localIndex: makeIndex(),
      method: "connector.setConfig",
      params: { serviceId: "github", intervalMs: 120000 },
    });
    expect(r.kind).toBe("hit");
    const v = (
      r as {
        kind: "hit";
        value: { service: string; intervalMs: number | null; enabled: boolean | null };
      }
    ).value;
    expect(v.service).toBe("github");
    expect(v.intervalMs).toBe(120000);
    expect(v.enabled).toBeNull();
  });

  test("sets enabled=false only (pause)", async () => {
    const r = await dispatchConnectorRpc({
      ...baseOpts,
      localIndex: makeIndex(),
      method: "connector.setConfig",
      params: { serviceId: "github", enabled: false },
    });
    expect(r.kind).toBe("hit");
    const v = (
      r as {
        kind: "hit";
        value: { service: string; intervalMs: number | null; enabled: boolean | null };
      }
    ).value;
    expect(v.service).toBe("github");
    expect(v.intervalMs).toBeNull();
    expect(v.enabled).toBe(false);
  });

  test("sets intervalMs and enabled=true together", async () => {
    const r = await dispatchConnectorRpc({
      ...baseOpts,
      localIndex: makeIndex(),
      method: "connector.setConfig",
      params: { serviceId: "github", intervalMs: 120000, enabled: true },
    });
    expect(r.kind).toBe("hit");
    const v = (
      r as {
        kind: "hit";
        value: { service: string; intervalMs: number | null; enabled: boolean | null };
      }
    ).value;
    expect(v.service).toBe("github");
    expect(v.intervalMs).toBe(120000);
    expect(v.enabled).toBe(true);
  });

  test("rejects missing serviceId", async () => {
    await expect(
      dispatchConnectorRpc({
        ...baseOpts,
        localIndex: makeIndex(),
        method: "connector.setConfig",
        params: {},
      }),
    ).rejects.toBeInstanceOf(ConnectorRpcError);
  });

  test("rejects unregistered serviceId", async () => {
    await expect(
      dispatchConnectorRpc({
        ...baseOpts,
        localIndex: makeIndex(),
        method: "connector.setConfig",
        params: { serviceId: "slack" },
      }),
    ).rejects.toBeInstanceOf(ConnectorRpcError);
  });

  test("rejects invalid intervalMs (zero)", async () => {
    await expect(
      dispatchConnectorRpc({
        ...baseOpts,
        localIndex: makeIndex(),
        method: "connector.setConfig",
        params: { serviceId: "github", intervalMs: 0 },
      }),
    ).rejects.toBeInstanceOf(ConnectorRpcError);
  });

  test("rejects invalid intervalMs (non-finite)", async () => {
    await expect(
      dispatchConnectorRpc({
        ...baseOpts,
        localIndex: makeIndex(),
        method: "connector.setConfig",
        params: { serviceId: "github", intervalMs: Number.POSITIVE_INFINITY },
      }),
    ).rejects.toBeInstanceOf(ConnectorRpcError);
  });

  test("floors fractional intervalMs", async () => {
    const r = await dispatchConnectorRpc({
      ...baseOpts,
      localIndex: makeIndex(),
      method: "connector.setConfig",
      params: { serviceId: "github", intervalMs: 90000.9 },
    });
    expect(r.kind).toBe("hit");
    const v = (r as { kind: "hit"; value: { intervalMs: number | null } }).value;
    expect(v.intervalMs).toBe(90000);
  });

  test("delegates to syncScheduler.setInterval and resume when provided", async () => {
    const calls: string[] = [];
    const syncScheduler = {
      setInterval: (id: string, ms: number) => {
        calls.push(`setInterval:${id}:${ms}`);
      },
      pause: (id: string) => {
        calls.push(`pause:${id}`);
      },
      resume: (id: string) => {
        calls.push(`resume:${id}`);
      },
    } as never;
    const r = await dispatchConnectorRpc({
      ...baseOpts,
      localIndex: makeIndex(),
      syncScheduler,
      method: "connector.setConfig",
      params: { serviceId: "github", intervalMs: 60000, enabled: true },
    });
    expect(r.kind).toBe("hit");
    expect(calls).toContain("setInterval:github:60000");
    expect(calls).toContain("resume:github");
  });

  test("delegates to syncScheduler.pause when enabled=false", async () => {
    const calls: string[] = [];
    const syncScheduler = {
      setInterval: (_id: string, _ms: number) => {},
      pause: (id: string) => {
        calls.push(`pause:${id}`);
      },
      resume: (_id: string) => {},
    } as never;
    await dispatchConnectorRpc({
      ...baseOpts,
      localIndex: makeIndex(),
      syncScheduler,
      method: "connector.setConfig",
      params: { serviceId: "github", enabled: false },
    });
    expect(calls).toContain("pause:github");
  });
});

describe("connector.startAuth deprecated alias (S4-F2)", () => {
  test("connector.startAuth dispatches to the same handler as connector.auth", async () => {
    const baseLocalIndex = makeIndex();
    const start = dispatchConnectorRpc({
      ...baseOpts,
      localIndex: baseLocalIndex,
      method: "connector.startAuth",
      params: { service: "totally-not-a-real-connector" },
    });
    const auth = dispatchConnectorRpc({
      ...baseOpts,
      localIndex: baseLocalIndex,
      method: "connector.auth",
      params: { service: "totally-not-a-real-connector" },
    });
    let startErr: unknown;
    let authErr: unknown;
    try {
      await start;
    } catch (e) {
      startErr = e;
    }
    try {
      await auth;
    } catch (e) {
      authErr = e;
    }
    expect(startErr).toBeDefined();
    expect(authErr).toBeDefined();
    expect((startErr as Error).constructor.name).toBe((authErr as Error).constructor.name);
    expect((startErr as Error).message).toBe((authErr as Error).message);
  });

  test("connector.unknown returns miss; connector.startAuth does not", async () => {
    const idx = makeIndex();
    const miss = await dispatchConnectorRpc({
      ...baseOpts,
      localIndex: idx,
      method: "connector.unknownMethod",
      params: {},
    });
    expect(miss.kind).toBe("miss");
    await expect(
      dispatchConnectorRpc({
        ...baseOpts,
        localIndex: idx,
        method: "connector.startAuth",
        params: {},
      }),
    ).rejects.toBeDefined();
  });
});
