/**
 * Child-process half of `test/integration/connectors/session-tool-resolution.integration.test.ts`.
 *
 * Lists REAL connector processes through a REAL `@mastra/mcp` `MCPClient`, one client per group in
 * the spec (the way the spawners group servers), then, against each REAL listing:
 *  - asks the gateway's `resolveServerTool` for every tool name any server in that client lists,
 *    and for every spelling that would name a nested sibling's tool (`github_` + `actions_<tool>`),
 *    from every server's point of view; and
 *  - runs each requested read end to end, through `drainTeamListSession` (the real
 *    `withConnectorSession` lookup), through `createConnectorDispatcher` (the mesh dispatcher), and
 *    through `spawnTeamToolAndCall` (the federated anchor's seam) by its bare id and by its listed
 *    `<server>_<tool>` key.
 * It prints one line, `SESSION_TOOL_RESOLUTION <json>` (a {@link ProbeReport}).
 *
 * A SEPARATE PROCESS on purpose, as `session-tool-keys-probe.ts` is: other test files
 * `mock.module("@mastra/mcp")` with fakes, and a module mock is process-global — inside the
 * one-process whole-repo run, an `MCPClient` imported by the test itself could be one of them,
 * which is the very blind spot this probe exists to close. The marker line keeps client logging on
 * stdout out of the parsed result. Every tool id arrives in the spec (argv[2]); none is named here.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPClient } from "@mastra/mcp";
import { connectorSpawn } from "../../src/connectors/lazy-mesh/keys.ts";
import {
  type LazyMeshToolMap,
  listLazyMeshClientTools,
  resolveServerTool,
} from "../../src/connectors/lazy-mesh/tool-map.ts";
import { createConnectorDispatcher } from "../../src/connectors/registry.ts";
import { __setSessionSpawnerForTest } from "../../src/teamvault/connector-session.ts";
import { drainTeamListSession } from "../../src/teamvault/team-tool-invoke.ts";
import { spawnTeamToolAndCall } from "../../src/teamvault/team-tool-spawn.ts";
import type { NimbusVault } from "../../src/vault/nimbus-vault.ts";

export interface ProbeSpec {
  /** Client name → `{ serverKey: connectorPackage }`. One real `MCPClient` per entry. */
  readonly clients: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Reads to run end to end on a client, by their bare tool id on `service`'s server. */
  readonly reads: ReadonlyArray<{ client: string; service: string; toolId: string }>;
}

export interface ProbeReport {
  readonly clients: Record<
    string,
    {
      /** `Object.keys(client.listTools())`. */
      readonly keys: string[];
      /** `client.listToolsets()`: each server's own, un-namespaced tool names. */
      readonly toolsets: Record<string, string[]>;
      /** server → requested id → the key of the tool `resolveServerTool` returned, or null. */
      readonly resolved: Record<string, Record<string, string | null>>;
    }
  >;
  /**
   * Each read's outcome, "ok" or the error text: through the session (a list drain), through the
   * dispatcher, and through the federated seam named by its bare id and by its listed key.
   */
  readonly reads: ReadonlyArray<{
    client: string;
    service: string;
    toolId: string;
    session: string;
    dispatcher: string;
    federatedBare: string;
    federatedListed: string;
  }>;
}

const MARKER = "SESSION_TOOL_RESOLUTION ";

const spec = JSON.parse(process.argv[2] ?? "{}") as ProbeSpec;
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;

/** Every id to ask `server` for: all names in the client, plus the nested-sibling spellings. */
function requestedIds(server: string, toolsets: Readonly<Record<string, string[]>>): string[] {
  const ids = new Set<string>();
  for (const [other, names] of Object.entries(toolsets)) {
    for (const name of names) {
      ids.add(name);
      // `${server}_` + this spelling is exactly `${other}_${name}` when `other` extends `server`.
      if (other.startsWith(`${server}_`)) ids.add(`${other.slice(server.length + 1)}_${name}`);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/** The key of the tool `resolveServerTool` returns, found by identity in the same listed map. */
function resolvedKey(tools: LazyMeshToolMap, server: string, toolId: string): string | null {
  const found = resolveServerTool(tools, server, toolId);
  if (found === undefined) return null;
  return Object.keys(tools).find((k) => tools[k] === found) ?? "<not a listed value>";
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "ok";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const NO_VAULT: NimbusVault = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  listKeys: async () => [],
};

const clients = new Map<string, MCPClient>();

/**
 * One read, through the real session lookup (a list drain and the federated seam) and then through
 * the real mesh dispatcher.
 */
async function runRead(read: ProbeSpec["reads"][number]): Promise<ProbeReport["reads"][number]> {
  const client = clients.get(read.client);
  if (client === undefined) throw new Error(`read names an unlisted client: ${read.client}`);
  // The real session code over the real client: only the spawn itself is supplied.
  __setSessionSpawnerForTest(() => ({
    listTools: () => listLazyMeshClientTools(client),
    disconnect: async () => {},
  }));
  const sandboxCwd = join(tmpdir(), "nimbus-session-tool-resolution");
  // `outcome` never throws, so the seam is always restored before the dispatcher runs.
  const session = await outcome(() =>
    drainTeamListSession({
      service: read.service,
      vaultView: NO_VAULT,
      sandboxCwd,
      listToolId: read.toolId,
    }),
  );
  const federated = (toolId: string) =>
    outcome(() =>
      spawnTeamToolAndCall({
        service: read.service,
        toolId,
        args: { cursor: null },
        vaultView: NO_VAULT,
        sandboxCwd,
      }),
    );
  const federatedBare = await federated(read.toolId);
  const federatedListed = await federated(`${read.service}_${read.toolId}`);
  __setSessionSpawnerForTest(undefined);
  const dispatcher = await outcome(() =>
    createConnectorDispatcher({ listTools: () => listLazyMeshClientTools(client) }).dispatch({
      type: `${read.service}.list`,
      payload: { mcpToolId: read.toolId, input: { cursor: null } },
    }),
  );
  return { ...read, session, dispatcher, federatedBare, federatedListed };
}

/** Start one client's connector processes, list them both ways, and resolve against the listing. */
async function listClient(
  name: string,
  servers: Readonly<Record<string, string>>,
): Promise<ProbeReport["clients"][string]> {
  const client = new MCPClient({
    id: `session-tool-resolution-${name}`,
    servers: Object.fromEntries(
      Object.entries(servers).map(([server, pkg]) => [server, { ...connectorSpawn(pkg), env }]),
    ),
    timeout: 60_000,
  });
  clients.set(name, client);
  const tools = await listLazyMeshClientTools(client);
  const toolsets: Record<string, string[]> = {};
  for (const [server, set] of Object.entries(await client.listToolsets())) {
    toolsets[server] = Object.keys(set);
  }
  const resolved: Record<string, Record<string, string | null>> = {};
  for (const server of Object.keys(servers)) {
    resolved[server] = Object.fromEntries(
      requestedIds(server, toolsets).map((id) => [id, resolvedKey(tools, server, id)]),
    );
  }
  return { keys: Object.keys(tools), toolsets, resolved };
}

const report: { clients: ProbeReport["clients"]; reads: ProbeReport["reads"][number][] } = {
  clients: {},
  reads: [],
};
try {
  for (const [name, servers] of Object.entries(spec.clients)) {
    // One client at a time, deterministic rather than fast; each lists its own servers concurrently.
    report.clients[name] = await listClient(name, servers); // NOSONAR S9382: one client's connector processes at a time
  }
  for (const read of spec.reads) {
    report.reads.push(await runRead(read)); // NOSONAR S9382: the session spawn seam is process-global, so reads cannot overlap
  }
} finally {
  await Promise.all([...clients.values()].map((c) => c.disconnect().catch(() => {})));
}
process.stdout.write(`\n${MARKER}${JSON.stringify(report)}\n`);
