import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRpcFixture, type RpcFixture } from "../../../test/helpers/rpc-harness.ts";
import type { ResolvedUserMcpRegistration } from "../../connectors/user-mcp-registration.ts";
import type { ConnectorRpcError } from "../connector-rpc-shared.ts";
import {
  handleConnectorAddMcp,
  handleConnectorSetInterval,
  resolveConnectorAddMcp,
} from "./config.ts";
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

const RESOLVED: ResolvedUserMcpRegistration = {
  serviceId: "mcp_test",
  command: "/opt/bin/echo",
  args: ["hi"],
  readPaths: ["/opt/notes"],
  netHosts: ["api.example.com"],
  modelAccess: true,
};

/** `resolveConnectorAddMcp` with a fake PATH/filesystem — nothing real is consulted. */
function resolveCtx(rec: Record<string, unknown>): ConnectorRpcHandlerContext {
  const { stub: scheduler } = makeStubScheduler();
  const mesh = {
    userMcpProtectedRoots: () => [],
  } as unknown as StubMesh;
  return {
    ...buildCtx({ rec, scheduler, mesh }),
    resolveCommand: (c: string) => `/opt/bin/${c}`,
    realpath: (p: string) => p,
  };
}

describe("resolveConnectorAddMcp — parameter validation", () => {
  test("missing syncScheduler or connectorMesh -> -32603", () => {
    const { stub: mesh } = makeStubMesh();
    const { stub: scheduler } = makeStubScheduler();
    for (const ctx of [
      buildCtx({ rec: { serviceId: "mcp_test", argv: ["echo"] }, mesh }),
      buildCtx({ rec: { serviceId: "mcp_test", argv: ["echo"] }, scheduler }),
    ]) {
      try {
        resolveConnectorAddMcp(ctx);
        throw new Error("expected throw");
      } catch (e) {
        expect((e as ConnectorRpcError).rpcCode).toBe(-32603);
        expect((e as ConnectorRpcError).message).toContain("sync and connector mesh");
      }
    }
  });

  test.each([
    ["non-string serviceId", { serviceId: 42, commandLine: "echo hi" }, "Missing serviceId"],
    ["non-string commandLine", { serviceId: "mcp_test", commandLine: 42 }, "commandLine"],
    ["empty commandLine", { serviceId: "mcp_test", commandLine: "   " }, "empty"],
    ["invalid serviceId format", { serviceId: "not-mcp", commandLine: "echo" }, "mcp_"],
  ])("%s -> -32602", (_label, rec, fragment) => {
    try {
      resolveConnectorAddMcp(resolveCtx(rec));
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32602);
      expect((e as ConnectorRpcError).message).toContain(fragment);
    }
  });

  test("a resolver refusal carries its ERR_USER_MCP_* code as the message prefix", () => {
    try {
      resolveConnectorAddMcp(
        resolveCtx({ serviceId: "mcp_test", argv: ["echo"], readPaths: ["relative/path"] }),
      );
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32602);
      expect((e as ConnectorRpcError).message.startsWith("ERR_USER_MCP_READ_PATH_RELATIVE: ")).toBe(
        true,
      );
    }
  });

  test("a non-resolver error from a seam propagates unchanged", () => {
    const ctx: ConnectorRpcHandlerContext = {
      ...resolveCtx({ serviceId: "mcp_test", argv: ["echo"] }),
      resolveCommand: () => {
        throw new TypeError("seam broke");
      },
    };
    expect(() => resolveConnectorAddMcp(ctx)).toThrow(TypeError);
  });
});

describe("handleConnectorAddMcp", () => {
  test("missing syncScheduler -> -32603", () => {
    const { stub: mesh } = makeStubMesh();
    try {
      handleConnectorAddMcp(buildCtx({ rec: undefined, mesh }), RESOLVED);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32603);
      expect((e as ConnectorRpcError).message).toContain("sync and connector mesh");
    }
  });

  test("missing connectorMesh -> -32603", () => {
    const { stub: scheduler } = makeStubScheduler();
    try {
      handleConnectorAddMcp(buildCtx({ rec: undefined, scheduler }), RESOLVED);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32603);
    }
  });

  test("happy path inserts the resolved row, registers syncable, returns ok", () => {
    const { stub: scheduler, calls: schedCalls } = makeStubScheduler();
    const { stub: mesh } = makeStubMesh();
    const result = handleConnectorAddMcp(buildCtx({ rec: undefined, scheduler, mesh }), RESOLVED);
    expect(result.kind).toBe("hit");
    expect(result.value).toEqual({ ok: true, serviceId: "mcp_test" });
    expect(schedCalls.registered).toEqual(["mcp_test"]);
    const row = fixture.db
      .query(
        "SELECT command, args_json, read_paths_json, net_hosts_json, model_access FROM user_mcp_connector WHERE service_id = ?",
      )
      .get("mcp_test");
    expect(row).toEqual({
      command: "/opt/bin/echo",
      args_json: '["hi"]',
      read_paths_json: '["/opt/notes"]',
      net_hosts_json: '["api.example.com"]',
      model_access: 1,
    });
  });

  test("UNIQUE conflict on re-insert -> -32602", () => {
    const { stub: scheduler } = makeStubScheduler();
    const { stub: mesh } = makeStubMesh();
    const ctx = buildCtx({ rec: undefined, scheduler, mesh });
    handleConnectorAddMcp(ctx, RESOLVED);
    try {
      handleConnectorAddMcp(ctx, RESOLVED);
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
