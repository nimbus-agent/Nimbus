import { describe, expect, test } from "bun:test";

import type { PlannedAction } from "../engine/types.ts";
import { createConnectorDispatcher, type McpToolListingClient } from "./registry.ts";

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
