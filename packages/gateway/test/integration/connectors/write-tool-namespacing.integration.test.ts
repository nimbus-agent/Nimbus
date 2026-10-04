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
 *
 * The listing runs in a CHILD process (`test/fixtures/session-tool-keys-probe.ts`): other test
 * files `mock.module("@mastra/mcp")` with bare-keyed fakes, and in the one-process whole-repo run a
 * client imported here would be one of them. The prefix assertion is what caught that, in-process.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isConnectorWriteToolId } from "../../../src/connectors/connector-write-registry.ts";
import { extensionProcessEnv } from "../../../src/extensions/spawn-env.ts";

/** Package id → the server key the production spawner registers it under. */
const CONNECTORS = [
  { pkg: "aws", server: "aws" },
  { pkg: "kubernetes", server: "kubernetes" },
  { pkg: "slack", server: "slack" },
  { pkg: "github-actions", server: "github_actions" }, // a key that itself contains `_`
] as const;

const PROBE = join(import.meta.dir, "..", "..", "fixtures", "session-tool-keys-probe.ts");
const MARKER = "SESSION_TOOL_KEYS ";

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

/** Run the probe and return each package's session tool keys. */
async function sessionKeysByPackage(): Promise<Record<string, string[]>> {
  const proc = Bun.spawn(
    [process.execPath, PROBE, ...CONNECTORS.map((c) => `${c.pkg}=${c.server}`)],
    { env: childEnv, stdout: "pipe", stderr: "pipe", windowsHide: true },
  );
  const deadline = setTimeout(() => proc.kill(), 100_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code, `probe exited ${String(code)}: ${stderr}`).toBe(0);
    const line = stdout.split("\n").find((l) => l.startsWith(MARKER));
    expect(line, `probe printed no result: ${stdout}\n${stderr}`).toBeDefined();
    return JSON.parse((line ?? "").slice(MARKER.length)) as Record<string, string[]>;
  } finally {
    clearTimeout(deadline);
  }
}

describe("I26 — the predicate refuses a write in the form a federated session executes it", () => {
  test("namespacing never changes the verdict, on the keys real connectors list", async () => {
    const keysByPackage = await sessionKeysByPackage();
    const refused: string[] = [];
    for (const { pkg, server } of CONNECTORS) {
      const keys = keysByPackage[pkg] ?? [];
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
        "slack_slack_chat_post", // a gate-confined write (D17), refused through its gate's set
        "github_actions_gha_run_trigger",
      ]),
    );
  }, 120_000);
});
