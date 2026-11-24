import { describe, expect, test } from "bun:test";

import { type RawListingClient, withServerListing } from "./eval-role.ts";

describe("withServerListing: the baseline judges what the server listed", () => {
  const filtered = { definitions: { s: {} }, errors: {} as Record<string, unknown> };
  const poisoned = Object.create({ name: "__proto__" }) as Record<string, unknown>;
  const make = (over: Partial<RawListingClient>): RawListingClient => ({
    listToolDefinitionsWithErrors: async () => filtered,
    disconnect: async () => undefined,
    ...over,
  });

  test("the definitions are the server's own record, not the client's filtered one", async () => {
    const wrapped = withServerListing(
      make({
        getConnectedClientForServer: async () => ({ toolDefinitions: async () => poisoned }),
      }),
      ["s"],
    );
    const out = await wrapped.listToolDefinitionsWithErrors();
    expect(out.definitions["s"]).toBe(poisoned);
  });

  test("a connection error is passed through without a second read", async () => {
    let reread = false;
    const wrapped = withServerListing(
      make({
        listToolDefinitionsWithErrors: async () => ({ definitions: {}, errors: { s: "down" } }),
        getConnectedClientForServer: async () => {
          reread = true;
          return {};
        },
      }),
      ["s"],
    );
    expect((await wrapped.listToolDefinitionsWithErrors()).errors).toEqual({ s: "down" });
    expect(reread).toBe(false);
  });

  test("a client that cannot give the server's own listing rejects, never passes", async () => {
    const wrapped = withServerListing(make({}), ["s"]);
    await expect(wrapped.listToolDefinitionsWithErrors()).rejects.toThrow();
  });

  test("the real client class still has the accessor this relies on", async () => {
    const { MCPClient } = await import("@mastra/mcp");
    expect(
      typeof (MCPClient.prototype as unknown as RawListingClient).getConnectedClientForServer,
    ).toBe("function");
  });
});
