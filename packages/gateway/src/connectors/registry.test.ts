import { describe, expect, test } from "bun:test";

import type { PlannedAction } from "../engine/types.ts";
import {
  createConnectorDispatcher,
  type McpToolListingClient,
  meshDispatcherClient,
} from "./registry.ts";

describe("createConnectorDispatcher", () => {
  test("dispatches by action.type when mcpToolId is absent", async () => {
    const client: McpToolListingClient = {
      async listTools() {
        return {
          filesystem_list_directory: {
            async execute(input: unknown) {
              return { echoed: input };
            },
          },
        };
      },
    };
    const d = createConnectorDispatcher(client);
    const action: PlannedAction = {
      type: "filesystem_list_directory",
      payload: { path: "/tmp" },
    };
    await expect(d.dispatch(action)).resolves.toEqual({ echoed: { path: "/tmp" } });
  });

  test("dispatches by payload.mcpToolId and uses payload.input", async () => {
    const client: McpToolListingClient = {
      async listTools() {
        return {
          filesystem_read_file: {
            async execute(input: unknown) {
              return { file: input };
            },
          },
        };
      },
    };
    const d = createConnectorDispatcher(client);
    const action: PlannedAction = {
      type: "ignored",
      payload: { mcpToolId: "filesystem_read_file", input: { path: "a.txt" } },
    };
    await expect(d.dispatch(action)).resolves.toEqual({ file: { path: "a.txt" } });
  });

  test("lists tools once (cached)", async () => {
    let calls = 0;
    const client: McpToolListingClient = {
      async listTools() {
        calls += 1;
        return {
          t: {
            async execute() {
              return 1;
            },
          },
        };
      },
    };
    const d = createConnectorDispatcher(client);
    await d.dispatch({ type: "t" });
    await d.dispatch({ type: "t" });
    expect(calls).toBe(1);
  });

  test("throws when tool is missing", async () => {
    const client: McpToolListingClient = {
      async listTools() {
        return {};
      },
    };
    const d = createConnectorDispatcher(client);
    await expect(d.dispatch({ type: "missing_tool" })).rejects.toThrow(/Tool not found/);
  });
});

// The mesh lists every connector tool as `<server>_<tool>` (each server named by its service id),
// so the notion connector's `notion_kb_append` reaches the dispatcher as `notion_notion_kb_append`.
describe("createConnectorDispatcher — a bare mcpToolId against a mesh-keyed tool map", () => {
  function meshListing(ran: string[]): McpToolListingClient {
    const listed = (key: string) => ({
      async execute(input: unknown) {
        ran.push(key);
        return { key, input };
      },
    });
    return {
      async listTools() {
        return {
          notion_notion_kb_append: listed("notion_notion_kb_append"),
          confluence_confluence_kb_append: listed("confluence_confluence_kb_append"),
          github_github_pr_list: listed("github_github_pr_list"),
          github_actions_gha_run_trigger: listed("github_actions_gha_run_trigger"),
        };
      },
    };
  }

  test("resolves the bare id on the server of the action type the gate approved", async () => {
    const ran: string[] = [];
    const d = createConnectorDispatcher(meshListing(ran));
    const out = await d.dispatch({
      type: "notion.knowledge.write",
      payload: { mcpToolId: "notion_kb_append", input: { databaseId: "db" } },
    });
    expect(out).toEqual({ key: "notion_notion_kb_append", input: { databaseId: "db" } });
    expect(ran).toEqual(["notion_notion_kb_append"]);
  });

  test("never resolves a bare id onto a different connector than the action type's", async () => {
    const ran: string[] = [];
    const d = createConnectorDispatcher(meshListing(ran));
    // A notion action naming confluence's KB tool: `notion_confluence_kb_append` is no tool.
    await expect(
      d.dispatch({
        type: "notion.knowledge.write",
        payload: { mcpToolId: "confluence_kb_append", input: {} },
      }),
    ).rejects.toThrow(/Tool not found/);
    // `github_` + `actions_gha_run_trigger` spells github_actions' trigger: refused, not run.
    await expect(
      d.dispatch({ type: "github.pr.list", payload: { mcpToolId: "actions_gha_run_trigger" } }),
    ).rejects.toThrow(/Tool not found/);
    expect(ran).toEqual([]);
  });

  test("an exact mesh key still dispatches as before, whatever the action type", async () => {
    const ran: string[] = [];
    const d = createConnectorDispatcher(meshListing(ran));
    await d.dispatch({ type: "github_github_pr_list", payload: {} });
    expect(ran).toEqual(["github_github_pr_list"]);
  });
});

describe("createConnectorDispatcher G8 — size cap + timeout", () => {
  test("rejects oversized tool result (S8-F5)", async () => {
    const big = "x".repeat(5 * 1024 * 1024);
    const client: McpToolListingClient = {
      async listTools() {
        return {
          big_tool: {
            async execute() {
              return { content: big };
            },
          },
        };
      },
    };
    const d = createConnectorDispatcher(client);
    await expect(d.dispatch({ type: "big_tool" })).rejects.toThrow(/result size/);
  });

  test("aborts a tool call that exceeds the timeout (S8-F5)", async () => {
    const client: McpToolListingClient = {
      async listTools() {
        return {
          slow_tool: {
            execute: () => new Promise(() => {}),
          },
        };
      },
    };
    const d = createConnectorDispatcher(client, { toolTimeoutMs: 200 });
    await expect(d.dispatch({ type: "slow_tool" })).rejects.toThrow(/exceeded.*200ms/);
  });

  test("permits result under cap and within timeout", async () => {
    const client: McpToolListingClient = {
      async listTools() {
        return {
          small_tool: {
            async execute() {
              return { ok: true };
            },
          },
        };
      },
    };
    const d = createConnectorDispatcher(client, {
      maxResultBytes: 1024,
      toolTimeoutMs: 5000,
    });
    await expect(d.dispatch({ type: "small_tool" })).resolves.toEqual({ ok: true });
  });
});

// I42: a user-MCP tool needs the LOCAL owner's approval on every call, and the gate decides that
// from `action.type` alone (I3). So the dispatcher must never let a payload's `mcpToolId` run a
// user-MCP tool under any action type but that tool's own — otherwise an action of another type
// (approved by a delegate, or needing no approval at all) could smuggle the call through.
describe("createConnectorDispatcher — user-MCP keys dispatch only under their own action type (I42)", () => {
  function listing(ran: string[]): McpToolListingClient {
    const listed = (key: string) => ({
      async execute() {
        ran.push(key);
        return { key };
      },
    });
    return {
      async listTools() {
        return {
          mcp_x_echo: listed("mcp_x_echo"),
          mcp_x_y_echo: listed("mcp_x_y_echo"),
          github_github_pr_list: listed("github_github_pr_list"),
        };
      },
    };
  }

  test("a user-MCP key smuggled under a first-party action type is refused and never runs", async () => {
    const ran: string[] = [];
    const d = createConnectorDispatcher(listing(ran));
    await expect(
      d.dispatch({ type: "github.pr_list", payload: { mcpToolId: "mcp_x_echo" } }),
    ).rejects.toThrow(/ERR_USER_MCP_ACTION_MISMATCH/);
    // A bare user-MCP key as the action type itself is no user-MCP action type either.
    await expect(d.dispatch({ type: "mcp_x_echo", payload: {} })).rejects.toThrow(
      /ERR_USER_MCP_ACTION_MISMATCH/,
    );
    expect(ran).toEqual([]);
  });

  test("a user-MCP key under ANOTHER user-MCP server's action type is refused", async () => {
    const ran: string[] = [];
    const d = createConnectorDispatcher(listing(ran));
    await expect(
      d.dispatch({ type: "mcp_x.y_echo", payload: { mcpToolId: "mcp_x_y_echo" } }),
    ).resolves.toEqual({ key: "mcp_x_y_echo" });
    // ...but the owner approved `mcp_x.echo`; running `mcp_x_y_echo` under it is refused.
    await expect(
      d.dispatch({ type: "mcp_x.echo", payload: { mcpToolId: "mcp_x_y_echo" } }),
    ).rejects.toThrow(/ERR_USER_MCP_ACTION_MISMATCH/);
    expect(ran).toEqual(["mcp_x_y_echo"]);
  });

  test("a user-MCP action type cannot dispatch a first-party tool through mcpToolId", async () => {
    const ran: string[] = [];
    const d = createConnectorDispatcher(listing(ran));
    await expect(
      d.dispatch({ type: "mcp_x.echo", payload: { mcpToolId: "github_github_pr_list" } }),
    ).rejects.toThrow(/ERR_USER_MCP_ACTION_MISMATCH/);
    expect(ran).toEqual([]);
  });

  test("the user-MCP key under its own action type still dispatches", async () => {
    const ran: string[] = [];
    const d = createConnectorDispatcher(listing(ran));
    await expect(
      d.dispatch({ type: "mcp_x.echo", payload: { mcpToolId: "mcp_x_echo" } }),
    ).resolves.toEqual({ key: "mcp_x_echo" });
    expect(ran).toEqual(["mcp_x_echo"]);
  });

  test("a model-requested user-MCP call hands the tool exactly payload.input — requestedBy never reaches the server", async () => {
    const received: unknown[] = [];
    const d = createConnectorDispatcher({
      listTools: async () => ({
        mcp_x_echo: {
          execute: async (input: unknown) => {
            received.push(input);
            return {};
          },
        },
      }),
    });
    await d.dispatch({
      type: "mcp_x.echo",
      payload: { mcpToolId: "mcp_x_echo", input: { q: "hi" }, requestedBy: "model" },
    });
    expect(received).toEqual([{ q: "hi" }]);
  });
});

// Running one user-MCP tool must not list (and so spawn) the whole mesh: the dispatcher resolves a
// user-MCP action against that server's own listing only, keeping the I42 pairing check.
describe("createConnectorDispatcher — a user-MCP action lists only its own server", () => {
  function perServer(ran: string[]): {
    client: McpToolListingClient;
    calls: { whole: number; perServer: string[] };
  } {
    const calls = { whole: 0, perServer: [] as string[] };
    const listed = (key: string) => ({
      async execute() {
        ran.push(key);
        return { key };
      },
    });
    const servers: Record<string, Record<string, ReturnType<typeof listed>>> = {
      mcp_a: { mcp_a_x: listed("mcp_a_x") },
      mcp_b: { mcp_b_x: listed("mcp_b_x") },
    };
    return {
      calls,
      client: {
        async listTools() {
          calls.whole += 1;
          return {
            mcp_a_x: listed("mcp_a_x"),
            mcp_b_x: listed("mcp_b_x"),
            github_github_pr_list: listed("github_github_pr_list"),
          };
        },
        async listUserMcpTools(serviceId: string) {
          calls.perServer.push(serviceId);
          return servers[serviceId];
        },
      },
    };
  }

  test("mcp_a.x lists mcp_a exactly once and the whole mesh zero times", async () => {
    const ran: string[] = [];
    const { client, calls } = perServer(ran);
    const d = createConnectorDispatcher(client);
    await expect(
      d.dispatch({ type: "mcp_a.x", payload: { mcpToolId: "mcp_a_x", input: { q: 1 } } }),
    ).resolves.toEqual({ key: "mcp_a_x" });
    expect(calls.perServer).toEqual(["mcp_a"]);
    expect(calls.whole).toBe(0);
    expect(ran).toEqual(["mcp_a_x"]);
  });

  test("an unknown tool on the server still fails with Tool not found", async () => {
    const ran: string[] = [];
    const { client, calls } = perServer(ran);
    const d = createConnectorDispatcher(client);
    await expect(
      d.dispatch({ type: "mcp_a.nope", payload: { mcpToolId: "mcp_a_nope" } }),
    ).rejects.toThrow(/Tool not found/);
    expect(calls.perServer).toEqual(["mcp_a"]);
    expect(calls.whole).toBe(0);
    expect(ran).toEqual([]);
  });

  test("an unregistered server lists nothing and fails with Tool not found", async () => {
    const ran: string[] = [];
    const { client, calls } = perServer(ran);
    const d = createConnectorDispatcher(client);
    await expect(
      d.dispatch({ type: "mcp_zz.x", payload: { mcpToolId: "mcp_zz_x" } }),
    ).rejects.toThrow(/Tool not found/);
    expect(calls.whole).toBe(0);
  });

  test("I42 pairing is still refused on the per-server path, before any listing", async () => {
    const ran: string[] = [];
    const { client, calls } = perServer(ran);
    const d = createConnectorDispatcher(client);
    // Another server's key under mcp_a's action type.
    await expect(
      d.dispatch({ type: "mcp_a.x", payload: { mcpToolId: "mcp_b_x" } }),
    ).rejects.toThrow(/ERR_USER_MCP_ACTION_MISMATCH/);
    // A first-party key under a user-MCP action type.
    await expect(
      d.dispatch({ type: "mcp_a.x", payload: { mcpToolId: "github_github_pr_list" } }),
    ).rejects.toThrow(/ERR_USER_MCP_ACTION_MISMATCH/);
    expect(calls.perServer).toEqual([]);
    expect(calls.whole).toBe(0);
    expect(ran).toEqual([]);
  });

  test("a first-party action still uses the whole-mesh listing (and the smuggle refusal)", async () => {
    const ran: string[] = [];
    const { client, calls } = perServer(ran);
    const d = createConnectorDispatcher(client);
    await expect(
      d.dispatch({ type: "github.pr_list", payload: { mcpToolId: "mcp_a_x" } }),
    ).rejects.toThrow(/ERR_USER_MCP_ACTION_MISMATCH/);
    expect(calls.whole).toBe(1);
    expect(calls.perServer).toEqual([]);
    expect(ran).toEqual([]);
  });
});

describe("meshDispatcherClient", () => {
  test("routes each listing to the matching mesh method", async () => {
    const seen: string[] = [];
    const client = meshDispatcherClient({
      async listToolsForDispatcher() {
        seen.push("whole");
        return {};
      },
      getToolsEpoch: () => 7,
      async listUserMcpToolsForDispatcher(serviceId: string) {
        seen.push(`one:${serviceId}`);
        return undefined;
      },
    });
    await client.listTools();
    expect(await client.listUserMcpTools?.("mcp_a")).toBeUndefined();
    expect(client.getToolsEpoch?.()).toBe(7);
    expect(seen).toEqual(["whole", "one:mcp_a"]);
  });
});
