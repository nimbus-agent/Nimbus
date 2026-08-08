import { describe, expect, it } from "bun:test";
import { CLOUDWATCH_TOOL_NAMES, registerCloudwatchTools } from "../src/tools.ts";

/**
 * Minimal stub MCP server that captures registered tool handlers keyed by name.
 */
function stubServer() {
  const tools: Record<string, (input: unknown) => Promise<unknown>> = {};
  return {
    server: (
      name: string,
      _desc: string,
      _schema: unknown,
      cb: (i: unknown) => Promise<unknown>,
    ) => {
      tools[name] = cb;
    },
    tools,
  };
}

describe("registerCloudwatchTools", () => {
  it("registers all expected cloudwatch tools", () => {
    const { server, tools } = stubServer();

    registerCloudwatchTools(server as never);

    for (const name of CLOUDWATCH_TOOL_NAMES) {
      expect(typeof tools[name]).toBe("function");
    }
    expect(Object.keys(tools)).toHaveLength(CLOUDWATCH_TOOL_NAMES.length);
  });
});
