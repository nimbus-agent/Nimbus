import { describe, expect, mock, test } from "bun:test";
import type { ZodObjectSchema } from "./mcp-tool-kit.ts";
import {
  buildReadOnlyMcpConnector,
  runReadOnlyMcpConnector,
} from "./run-read-only-mcp-connector.ts";

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

/**
 * This is the function every connector entry point actually calls, and it was
 * covered by nothing — it built a real `StdioServerTransport` inline, so a test
 * could not run it without opening stdio on the test process. The
 * `createTransport` seam mirrors the existing `createServer` one and makes the
 * server↔transport wiring assertable.
 */
describe("runReadOnlyMcpConnector", () => {
  test("connects the built server to the transport", async () => {
    const connect = mock(async (_t: unknown) => undefined);
    const fakeServer = { tool: () => undefined, connect };
    const fakeTransport = { kind: "fake-transport" };

    await runReadOnlyMcpConnector("nimbus-acme", () => undefined, {
      createServer: () => fakeServer,
      createTransport: () => fakeTransport,
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0]?.[0]).toBe(fakeTransport);
  });

  test("registers the caller's tools before connecting", async () => {
    const order: string[] = [];
    const toolSpy = mock((..._a: unknown[]) => {
      order.push("register");
    });
    const fakeServer = {
      tool: toolSpy,
      connect: mock(async () => {
        order.push("connect");
      }),
    };

    await runReadOnlyMcpConnector(
      "nimbus-acme",
      (reg) => {
        reg("acme_list", "List acme items", syntheticSchema(), async () => ({
          content: [{ type: "text", text: "[]" }],
        }));
      },
      { createServer: () => fakeServer, createTransport: () => ({}) },
    );

    // A tool registered after connect would be invisible to the client that is
    // already handshaking.
    expect(order).toEqual(["register", "connect"]);
  });

  /**
   * The DEFAULT arms are the production ones — every connector entry point calls
   * these functions with no options at all. Injecting both seams in every test
   * would leave exactly the code that ships uncovered, so these two exercise the
   * real `McpServer` / `StdioServerTransport` factories.
   *
   * Safe to do: constructing `StdioServerTransport` is inert. Verified — it adds
   * no `data` listener to stdin and does not resume it; the transport only
   * attaches on `start()`, which `connect()` drives, and the fake server here
   * never calls it.
   */
  test("defaults to a real McpServer when no createServer is given", () => {
    const server = buildReadOnlyMcpConnector("nimbus-acme", () => undefined);
    expect(server).toBeDefined();
    expect(typeof (server as { connect?: unknown }).connect).toBe("function");
  });

  test("defaults to a real StdioServerTransport when no createTransport is given", async () => {
    const connect = mock(async (_t: unknown) => undefined);
    const stdinListenersBefore = process.stdin.listenerCount("data");

    await runReadOnlyMcpConnector("nimbus-acme", () => undefined, {
      createServer: () => ({ tool: () => undefined, connect }),
    });

    expect(connect).toHaveBeenCalledTimes(1);
    // It was handed a real transport instance, not undefined.
    expect(connect.mock.calls[0]?.[0]).toBeDefined();
    // ...and constructing it left stdin alone, which is what makes this test safe.
    expect(process.stdin.listenerCount("data")).toBe(stdinListenersBefore);
  });

  test("propagates a transport failure rather than resolving silently", async () => {
    const fakeServer = {
      tool: () => undefined,
      connect: async () => {
        throw new Error("stdio unavailable");
      },
    };
    await expect(
      runReadOnlyMcpConnector("nimbus-acme", () => undefined, {
        createServer: () => fakeServer,
        createTransport: () => ({}),
      }),
    ).rejects.toThrow(/stdio unavailable/);
  });
});
