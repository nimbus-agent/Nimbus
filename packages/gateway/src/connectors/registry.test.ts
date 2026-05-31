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
