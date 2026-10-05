/**
 * Child-process half of `test/integration/connectors/write-tool-namespacing.integration.test.ts`.
 *
 * Lists real connector processes through a real `@mastra/mcp` `MCPClient`, each under the server
 * key given on the command line as `<package>=<serverKey>`, and prints one line,
 * `SESSION_TOOL_KEYS <json>`, mapping each package to the tool keys the client returned.
 *
 * A SEPARATE PROCESS on purpose. Other test files `mock.module("@mastra/mcp")` with fakes keyed by
 * bare tool ids, and a module mock is process-global: inside the one-process whole-repo test run, an
 * `MCPClient` imported by the test itself would be one of those fakes — the very blind spot the test
 * exists to close. The marker line keeps any client logging on stdout out of the parsed result.
 */
import { MCPClient } from "@mastra/mcp";
import { connectorSpawn } from "../../src/connectors/lazy-mesh/keys.ts";
import { listLazyMeshClientTools } from "../../src/connectors/lazy-mesh/tool-map.ts";

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;

const keys: Record<string, string[]> = {};
for (const arg of process.argv.slice(2)) {
  const [pkg, server] = arg.split("=");
  if (pkg === undefined || server === undefined || pkg === "" || server === "") {
    throw new Error(`expected <package>=<serverKey>, got ${JSON.stringify(arg)}`);
  }
  const client = new MCPClient({
    id: `session-tool-keys-${pkg}`,
    servers: { [server]: { ...connectorSpawn(pkg), env } },
    timeout: 60_000,
  });
  try {
    keys[pkg] = Object.keys(await listLazyMeshClientTools(client)); // NOSONAR S9382: one connector process at a time — this probe exists to be deterministic, not fast
  } finally {
    await client.disconnect().catch(() => {});
  }
}
process.stdout.write(`\nSESSION_TOOL_KEYS ${JSON.stringify(keys)}\n`);
