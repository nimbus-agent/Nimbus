/**
 * Test-only: connects the UPSTREAM MCP SDK's client to a server built on
 * `@nimbus-dev/sdk/mcp-server`. The upstream client opens with `initialize`, so this is the
 * legacy era, driven by an implementation that is not ours: what an editor that has not moved to
 * revision 2026-07-28 does. `@modelcontextprotocol/sdk` is a devDependency for this reason only.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@nimbus-dev/sdk/mcp-server";

export async function connectUpstreamClient(server: McpServer, name: string): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const connection = server.connect((message) => {
    void serverTransport.send(message as JSONRPCMessage);
  });
  serverTransport.onmessage = (message) => {
    void connection.receive(message);
  };
  serverTransport.onclose = () => {
    connection.close();
  };
  await serverTransport.start();
  const client = new Client({ name, version: "0" });
  await client.connect(clientTransport);
  return client;
}
