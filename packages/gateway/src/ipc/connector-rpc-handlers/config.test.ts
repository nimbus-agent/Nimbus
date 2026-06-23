import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRpcFixture, type RpcFixture } from "../../../test/helpers/rpc-harness.ts";
import type { ConnectorRpcError } from "../connector-rpc-shared.ts";
import { handleConnectorAddMcp, handleConnectorSetInterval } from "./config.ts";
import type { ConnectorRpcHandlerContext } from "./context.ts";

let fixture: RpcFixture;

beforeEach(() => {
  fixture = createRpcFixture();
});

afterEach(() => {
  fixture.cleanup();
});

type StubScheduler = ConnectorRpcHandlerContext["syncScheduler"];
type StubMesh = ConnectorRpcHandlerContext["connectorMesh"];

interface SchedulerCalls {
  registered: string[];
  setIntervalCalls: Array<{ id: string; ms: number }>;
}

function makeStubScheduler(): { stub: StubScheduler; calls: SchedulerCalls } {
  const calls: SchedulerCalls = { registered: [], setIntervalCalls: [] };
  const stub = {
    register(syncable: { serviceId: string }): void {
      calls.registered.push(syncable.serviceId);
    },
    setInterval(id: string, ms: number): void {
      calls.setIntervalCalls.push({ id, ms });
    },
  } as unknown as StubScheduler;
  return { stub, calls };
}

function makeStubMesh(): { stub: StubMesh; calls: { ensured: string[] } } {
  const calls = { ensured: [] as string[] };
  const stub = {
    async ensureUserMcpRunning(id: string): Promise<void> {
      calls.ensured.push(id);
    },
  } as unknown as StubMesh;
  return { stub, calls };
}

function buildCtx(args: {
  rec: Record<string, unknown> | undefined;
  scheduler?: StubScheduler;
  mesh?: StubMesh;
}): ConnectorRpcHandlerContext {
  return {
    rec: args.rec,
    vault: fixture.vault,
    localIndex: fixture.localIndex,
    openUrl: async () => {},
    syncScheduler: args.scheduler,
    connectorMesh: args.mesh,
    notify: fixture.notify,
  };
}

describe("handleConnectorAddMcp", () => {
  test("missing syncScheduler -> -32603", async () => {
    const { stub: mesh } = makeStubMesh();
    try {
      await handleConnectorAddMcp(
        buildCtx({ rec: { serviceId: "mcp_test", commandLine: "echo hi" }, mesh }),
      );
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32603);
      expect((e as ConnectorRpcError).message).toContain("sync and connector mesh");
    }
  });

  test("missing connectorMesh -> -32603", async () => {
    const { stub: scheduler } = makeStubScheduler();
    try {
      await handleConnectorAddMcp(
        buildCtx({ rec: { serviceId: "mcp_test", commandLine: "echo hi" }, scheduler }),
      );
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32603);
    }
  });

  test("non-string serviceId -> -32602", async () => {
    const { stub: scheduler } = makeStubScheduler();
    const { stub: mesh } = makeStubMesh();
    try {
      await handleConnectorAddMcp(
        buildCtx({ rec: { serviceId: 42, commandLine: "echo hi" }, scheduler, mesh }),
      );
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32602);
      expect((e as ConnectorRpcError).message).toContain("Missing serviceId");
    }
  });

  test("non-string commandLine -> -32602", async () => {
    const { stub: scheduler } = makeStubScheduler();
    const { stub: mesh } = makeStubMesh();
    try {
      await handleConnectorAddMcp(
        buildCtx({ rec: { serviceId: "mcp_test", commandLine: 42 }, scheduler, mesh }),
      );
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32602);
    }
  });

  test("invalid serviceId format -> -32602", async () => {
    const { stub: scheduler } = makeStubScheduler();
    const { stub: mesh } = makeStubMesh();
    try {
      await handleConnectorAddMcp(
        buildCtx({
          rec: { serviceId: "not-mcp-prefixed", commandLine: "echo hi" },
          scheduler,
          mesh,
        }),
      );
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32602);
      expect((e as ConnectorRpcError).message).toContain("mcp_");
    }
  });

  test("happy path inserts row, registers syncable, returns ok", async () => {
    const { stub: scheduler, calls: schedCalls } = makeStubScheduler();
    const { stub: mesh } = makeStubMesh();
    const result = await handleConnectorAddMcp(
      buildCtx({
        rec: { serviceId: "mcp_test", commandLine: "echo hi" },
        scheduler,
        mesh,
      }),
    );
    expect(result.kind).toBe("hit");
    expect(result.value).toEqual({ ok: true, serviceId: "mcp_test" });
    expect(schedCalls.registered).toEqual(["mcp_test"]);
    const row = fixture.db
      .query("SELECT service_id FROM user_mcp_connector WHERE service_id = ?")
      .get("mcp_test");
    expect(row).not.toBeNull();
  });

  test("UNIQUE conflict on re-insert -> -32602", async () => {
    const { stub: scheduler } = makeStubScheduler();
    const { stub: mesh } = makeStubMesh();
    const ctx = buildCtx({
      rec: { serviceId: "mcp_dup", commandLine: "echo hi" },
      scheduler,
      mesh,
    });
    await handleConnectorAddMcp(ctx);
    try {
      await handleConnectorAddMcp(ctx);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32602);
      expect((e as ConnectorRpcError).message).toContain("already exists");
    }
  });
});

describe("handleConnectorSetInterval", () => {
  beforeEach(() => {
    fixture.localIndex.ensureConnectorSchedulerRegistration("github", 60_000, 1_700_000_000_000);
  });

  test("non-number intervalMs -> -32602", () => {
    try {
      handleConnectorSetInterval(buildCtx({ rec: { serviceId: "github", intervalMs: "fast" } }));
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32602);
      expect((e as ConnectorRpcError).message).toContain("intervalMs");
    }
  });

  test("non-finite intervalMs (Infinity) -> -32602", () => {
    try {
      handleConnectorSetInterval(
        buildCtx({ rec: { serviceId: "github", intervalMs: Number.POSITIVE_INFINITY } }),
      );
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32602);
    }
  });

  test("intervalMs < 1 -> -32602", () => {
    try {
      handleConnectorSetInterval(buildCtx({ rec: { serviceId: "github", intervalMs: 0 } }));
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32602);
    }
  });

  test("happy path with scheduler defined floors the ms value", () => {
    const { stub: scheduler, calls } = makeStubScheduler();
    const r = handleConnectorSetInterval(
      buildCtx({ rec: { serviceId: "github", intervalMs: 60_500.7 }, scheduler }),
    );
    expect(r.kind).toBe("hit");
    expect(calls.setIntervalCalls).toEqual([{ id: "github", ms: 60_500 }]);
    expect(
      fixture.notifications.payloadsFor("connector.configChanged").length,
    ).toBeGreaterThanOrEqual(1);
  });

  test("happy path with scheduler undefined still persists + notifies", () => {
    const r = handleConnectorSetInterval(
      buildCtx({ rec: { serviceId: "github", intervalMs: 90_000 } }),
    );
    expect(r.kind).toBe("hit");
    expect(fixture.notifications.payloadsFor("connector.configChanged")).toHaveLength(1);
  });
});
