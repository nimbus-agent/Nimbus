/**
 * I26 wire contract: a federated invoke executes a tool by the key `@mastra/mcp`'s
 * `MCPClient.listTools()` gives it — `<server>_<tool>` — because `withConnectorSession` looks the
 * requested id up in that map verbatim. So the I26 predicate has to refuse a write in THAT form.
 *
 * Every unit test of the session/transport layer fakes the tool map with BARE ids
 * (`{ snowflake_list: ... }`), which is how the predicate came to match only bare ids: the one form
 * a real session cannot execute. This spawns REAL connectors through the gateway's own
 * `connectorSpawn`, lists them through a REAL `MCPClient` keyed the way the production spawners key
 * them, and checks the predicate against the keys a session actually holds. If the namespacing
 * scheme ever changes (a `.` separator, say), the prefix assertion fails here first.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPClient } from "@mastra/mcp";
import { isConnectorWriteToolId } from "../../../src/connectors/connector-write-registry.ts";
import { connectorSpawn } from "../../../src/connectors/lazy-mesh/keys.ts";
import { listLazyMeshClientTools } from "../../../src/connectors/lazy-mesh/tool-map.ts";
import { extensionProcessEnv } from "../../../src/extensions/spawn-env.ts";

/** Package id → the server key the production spawner registers it under. */
const CONNECTORS = [
  { pkg: "aws", server: "aws" },
  { pkg: "kubernetes", server: "kubernetes" },
  { pkg: "slack", server: "slack" },
  { pkg: "github-actions", server: "github_actions" }, // a key that itself contains `_`
] as const;

// No real profile reaches the children: listing tools needs no credentials, so every home and
// temp directory points at a throwaway one.
const sandboxHome = mkdtempSync(join(tmpdir(), "nimbus-i26-wire-"));
const childEnv = extensionProcessEnv(
  Object.fromEntries(
    ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP"].map((k) => [
      k,
      sandboxHome,
    ]),
  ),
);

afterAll(() => {
  rmSync(sandboxHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function sessionKeys(pkg: string, server: string): Promise<string[]> {
  const client = new MCPClient({
    id: `i26-wire-${pkg}`,
    servers: { [server]: { ...connectorSpawn(pkg), env: childEnv } },
    timeout: 60_000,
  });
  try {
    return Object.keys(await listLazyMeshClientTools(client));
  } finally {
    await client.disconnect().catch(() => {});
  }
}

describe("I26 — the predicate refuses a write in the form a federated session executes it", () => {
  test("namespacing never changes the verdict, on the keys real connectors list", async () => {
    const refused: string[] = [];
    for (const { pkg, server } of CONNECTORS) {
      const keys = await sessionKeys(pkg, server); // NOSONAR S9382: one connector process at a time — four concurrent spawns on a slow runner buy nothing in a single test
      expect(keys.length, `${pkg} listed no tools`).toBeGreaterThan(0);
      for (const key of keys) {
        expect(
          key.startsWith(`${server}_`),
          `${key}: tools are no longer keyed <server>_<tool>`,
        ).toBe(true);
        const bare = key.slice(server.length + 1);
        // Both directions: a namespaced write is refused (no bypass), a namespaced read is not
        // (no over-blocking).
        expect(isConnectorWriteToolId(key), key).toBe(isConnectorWriteToolId(bare));
        if (isConnectorWriteToolId(key)) refused.push(key);
      }
    }
    // Non-vacuity: a predicate that refused nothing would satisfy the equality above.
    expect(refused).toEqual(
      expect.arrayContaining([
        "aws_aws_ec2_instance_stop",
        "aws_aws_ecs_service_update",
        "kubernetes_k8s_pod_delete",
        "slack_slack_message_post_dm",
        "github_actions_gha_run_trigger",
      ]),
    );
  }, 120_000);
});
