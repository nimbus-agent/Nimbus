import { describe, expect, mock, test } from "bun:test";
import type { ZodObjectSchema } from "./mcp-tool-kit.ts";
import { buildReadOnlyMcpConnector } from "./run-read-only-mcp-connector.ts";

type SyntheticArgs = { readonly id?: string };

function syntheticSchema(): ZodObjectSchema<SyntheticArgs> {
  return {
    shape: { id: {} },
    safeParse: (args: unknown) => ({
      success: true as const,
      data: args ?? {},
    }),
  };
}

describe("buildReadOnlyMcpConnector", () => {
  test("passes serverName and version 0.1.0 to the createServer factory", () => {
    const factory = mock((_info: { readonly name: string; readonly version: string }) => ({
      tool: () => undefined,
    }));
    buildReadOnlyMcpConnector("nimbus-acme", () => undefined, { createServer: factory });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[0]).toEqual({ name: "nimbus-acme", version: "0.1.0" });
  });

  test("invokes register with a registrar that delegates to server.tool", () => {
    const toolSpy = mock((..._args: unknown[]) => undefined);
    const fakeServer = { tool: toolSpy };
    buildReadOnlyMcpConnector(
      "nimbus-acme",
      (reg) => {
        reg("acme_list", "List acme items", syntheticSchema(), async () => ({
          content: [{ type: "text", text: "[]" }],
        }));
        reg("acme_get", "Get one acme item", syntheticSchema(), async () => ({
          content: [{ type: "text", text: "{}" }],
        }));
      },
      { createServer: () => fakeServer },
    );
    expect(toolSpy).toHaveBeenCalledTimes(2);
    expect(toolSpy.mock.calls[0]?.[0]).toBe("acme_list");
    expect(toolSpy.mock.calls[0]?.[1]).toBe("List acme items");
    expect(toolSpy.mock.calls[1]?.[0]).toBe("acme_get");
  });

  test("returns the constructed server instance", () => {
    const fakeServer = { tool: () => undefined };
    const result = buildReadOnlyMcpConnector("nimbus-acme", () => undefined, {
      createServer: () => fakeServer,
    });
    expect(result).toBe(fakeServer);
  });
});
