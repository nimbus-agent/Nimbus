import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino from "pino";
import { createRpcFixture, type RpcFixture } from "../../../test/helpers/rpc-harness.ts";
import type { Syncable, SyncContext } from "../../sync/types.ts";
import { ConnectorRpcError } from "../connector-rpc-shared.ts";
import { handleConnectorAddMcp } from "./config.ts";
import type { ConnectorRpcHandlerContext } from "./context.ts";

/**
 * `connector.addMcp` past the happy path `config.test.ts` covers: the syncable it registers must
 * start the user's MCP server through the mesh when the scheduler runs it, and a store failure
 * must be classified by what it IS — a duplicate (-32602, the caller's fault) versus anything
 * else (-32603, ours) — with nothing registered for a row that was never saved.
 */

let fixture: RpcFixture;

beforeEach(() => {
  fixture = createRpcFixture();
});

afterEach(() => {
  fixture.cleanup();
});

type Harness = {
  ctx: ConnectorRpcHandlerContext;
  registered: Syncable[];
  ensured: string[];
};

function harness(serviceId: string): Harness {
  const registered: Syncable[] = [];
  const ensured: string[] = [];
  const scheduler = {
    register(syncable: Syncable): void {
      registered.push(syncable);
    },
  } as unknown as ConnectorRpcHandlerContext["syncScheduler"];
  const mesh = {
    async ensureUserMcpRunning(id: string): Promise<void> {
      ensured.push(id);
    },
  } as unknown as ConnectorRpcHandlerContext["connectorMesh"];
  return {
    registered,
    ensured,
    ctx: {
      rec: { serviceId, commandLine: "node server.js --stdio" },
      vault: fixture.vault,
      localIndex: fixture.localIndex,
      openUrl: async () => {},
      syncScheduler: scheduler,
      connectorMesh: mesh,
      notify: fixture.notify,
    },
  };
}

function rpcErrorOf(fn: () => unknown): ConnectorRpcError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConnectorRpcError) return e;
    throw e;
  }
  throw new Error("expected a ConnectorRpcError");
}

describe("handleConnectorAddMcp — the registered syncable", () => {
  test("running it starts THIS service's MCP server through the mesh, and indexes nothing", async () => {
    const h = harness("mcp_notes");
    handleConnectorAddMcp(h.ctx);

    expect(h.registered.map((s) => s.serviceId)).toEqual(["mcp_notes"]);
    expect(h.ensured).toEqual([]); // registration alone starts nothing
    const syncable = h.registered[0];
    if (syncable === undefined) throw new Error("no syncable registered");

    const syncCtx = { logger: pino({ level: "silent" }) } as unknown as SyncContext;
    const result = await syncable.sync(syncCtx, null);

    expect(h.ensured).toEqual(["mcp_notes"]);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor).toBe("user_mcp");
  });
});

describe("handleConnectorAddMcp — store failures", () => {
  test("a failure that is not a uniqueness conflict is -32603 'Failed to save', and nothing is registered", () => {
    fixture.db.run("DROP TABLE user_mcp_connector");
    const h = harness("mcp_lost");

    const err = rpcErrorOf(() => handleConnectorAddMcp(h.ctx));

    expect(err.rpcCode).toBe(-32603);
    expect(err.message.startsWith("Failed to save user MCP connector: ")).toBe(true);
    expect(err.message).toContain("user_mcp_connector");
    expect(err.message).not.toContain("already exists");
    expect(h.registered).toEqual([]);
  });

  test("a uniqueness failure reported in lower case is still classified as already-exists", () => {
    fixture.db.run(
      `CREATE TRIGGER reject_dup BEFORE INSERT ON user_mcp_connector
         WHEN NEW.service_id = 'mcp_lower'
       BEGIN SELECT RAISE(ABORT, 'service id must be unique'); END`,
    );
    const h = harness("mcp_lower");

    const err = rpcErrorOf(() => handleConnectorAddMcp(h.ctx));

    expect(err.rpcCode).toBe(-32602);
    expect(err.message).toBe("User MCP connector already exists: mcp_lower");
    expect(h.registered).toEqual([]);
  });
});
