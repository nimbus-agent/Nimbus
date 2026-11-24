/**
 * The MCP server reports the CLI's own release version as its server version, in both protocol
 * eras. It used to report a hard-coded `0.1.0` (the per-package placeholder), which an editor shows
 * as the server version and which says nothing about the install it is talking to.
 */
import { describe, expect, test } from "bun:test";

import { NIMBUS_VERSION } from "../version.ts";
import { buildMcpServer } from "./adapter.ts";
import type { AdapterDeps } from "./tool-runtime.ts";
import { connectUpstreamClient } from "./upstream-client.test-helpers.ts";

const deps: AdapterDeps = {
  getClient: () => Promise.reject(new Error("no gateway in this test")),
};

describe("the MCP server's reported version", () => {
  test("is the CLI release version, not the 0.1.0 placeholder (initialize era)", async () => {
    const client = await connectUpstreamClient(buildMcpServer(deps), "editor");
    try {
      const info = client.getServerVersion();
      expect(info?.name).toBe("nimbus");
      expect(info?.version).toBe(NIMBUS_VERSION);
      expect(info?.version).not.toBe("0.1.0");
    } finally {
      await client.close();
    }
  });

  test("is the CLI release version in a 2026-07-28 server/discover reply", async () => {
    const server = buildMcpServer(deps);
    const replies: unknown[] = [];
    const connection = server.connect((message) => {
      replies.push(message);
    });
    await connection.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "probe", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    connection.close();
    const text = JSON.stringify(replies);
    expect(text).toContain(`"version":"${NIMBUS_VERSION}"`);
    expect(text).not.toContain('"version":"0.1.0"');
  });
});
