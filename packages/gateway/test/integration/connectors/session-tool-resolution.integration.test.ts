/**
 * Bare connector tool ids against REAL session listings.
 *
 * A credentialed connector session lists its tools through `@mastra/mcp`'s `MCPClient.listTools()`,
 * which keys every tool `<server>_<tool>` — the snowflake connector's `snowflake_list` arrives as
 * `snowflake_snowflake_list` — while the gateway names each tool by its own MCP name. Every unit
 * test of the session layer used to fake BARE-keyed maps, the one shape a real session never has,
 * which is how the connector-write transport, both list drains and the tribal KB capture came to
 * fail with "tool not found" against real connectors while all of their tests passed.
 *
 * This lists REAL connector processes through a REAL `MCPClient` — in a child process,
 * `test/fixtures/session-tool-resolution-probe.ts`, because other test files `mock.module` it with
 * bare-keyed fakes — and holds the gateway to the listings it got:
 *   1. the key scheme: `listTools()` keys are exactly `<server>_<tool>` over `listToolsets()`;
 *   2. `resolveServerTool`, for every tool any listed server has, from every server's side: its own
 *      server's key and never another's, the nested pair the github spawner puts in ONE client
 *      (`github`, `github_actions`) included;
 *   3. each fixed caller, driven here over maps keyed by the real listing, with the bare ids the
 *      gateway really sends — from its registries, syncables and gates, not copied into this file —
 *      and the ONE caller that must not resolve: the federated anchor's seam, which runs a peer's
 *      id only as the exact listed key, for every tool every listed server has;
 *   4. one real read end to end, through the real session, the real dispatcher and the federated
 *      seam (by its listed key; by its bare id it is not found), reaching the connector's own
 *      handler — which fails before any network call, for want of credentials.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBotToolCall } from "../../../src/chatops/chatops-bot-spawn-call.ts";
import { buildConnectorPost } from "../../../src/chatops/transport/connector-post.ts";
import { createBigeyeSyncable } from "../../../src/connectors/bigeye-sync.ts";
import type { ConnectorServiceId } from "../../../src/connectors/connector-catalog.ts";
import { EMPTY_NIMBUS_VAULT } from "../../../src/connectors/connector-sync-test-helpers.ts";
import { CONNECTOR_WRITES } from "../../../src/connectors/connector-write-registry.ts";
import { invokeConnectorWrite } from "../../../src/connectors/connector-write-transport.ts";
import {
  type LazyMeshToolMap,
  serviceIdForToolKey,
} from "../../../src/connectors/lazy-mesh/tool-map.ts";
import { createLookerSyncable } from "../../../src/connectors/looker-sync.ts";
import { createMonteCarloSyncable } from "../../../src/connectors/monte-carlo-sync.ts";
import { createPowerBiSyncable } from "../../../src/connectors/powerbi-sync.ts";
import { createConnectorDispatcher } from "../../../src/connectors/registry.ts";
import { createSnowflakeSyncable } from "../../../src/connectors/snowflake-sync.ts";
import { createTableauSyncable } from "../../../src/connectors/tableau-sync.ts";
import { NULL_EGRESS_SINK } from "../../../src/egress/egress-ledger.ts";
import { ToolExecutor } from "../../../src/engine/executor.ts";
import { extensionProcessEnv } from "../../../src/extensions/spawn-env.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { Syncable, SyncContext } from "../../../src/sync/types.ts";
import { __setSessionSpawnerForTest } from "../../../src/teamvault/connector-session.ts";
import { drainTeamListSession } from "../../../src/teamvault/team-tool-invoke.ts";
import {
  spawnTeamToolAndCall,
  spawnTeamWriteAndCall,
} from "../../../src/teamvault/team-tool-spawn.ts";
import type { TribalCluster } from "../../../src/tribal/cluster-store.ts";
import { captureToKnowledgeBase } from "../../../src/tribal/tribal-write-gate.ts";
import type { ProbeReport, ProbeSpec } from "../../fixtures/session-tool-resolution-probe.ts";

/** Client name → `{ serverKey: connectorPackage }`, keyed the way the production spawners key them. */
const CLIENTS: ProbeSpec["clients"] = {
  // The phase-3 bundle spawner registers every configured warehouse/BI and GitOps/ML connector as a
  // server of ONE client. These nine are every connector with a dispatchable write; aws rides in
  // the same bundle and lists `aws_ec2_instance_stop` / `_start`, mutations a federated peer must
  // not reach by their bare names whatever the I26 predicate says of them.
  phase3: {
    snowflake: "snowflake",
    tableau: "tableau",
    looker: "looker",
    powerbi: "powerbi",
    montecarlo: "monte-carlo",
    bigeye: "bigeye",
    argocd: "argocd",
    flux: "flux",
    mlflow: "mlflow",
    aws: "aws",
  },
  // The github spawner registers both servers in one client: the pair whose names nest.
  github: { github: "github", github_actions: "github-actions" },
  // Separate clients in production (the ChatOps bot spawn gives slack and teams one each); listed
  // together here, which only adds collisions to look for.
  comms: { notion: "notion", confluence: "confluence", slack: "slack", teams: "teams" },
};

/** Run end to end: a real read that fails in the connector before any network call, and a miss. */
const READS: ProbeSpec["reads"] = [
  { client: "phase3", service: "snowflake", toolId: "snowflake_list" },
  { client: "phase3", service: "snowflake", toolId: "snowflake_no_such_tool" },
];

const PROBE = join(import.meta.dir, "..", "..", "fixtures", "session-tool-resolution-probe.ts");
const MARKER = "SESSION_TOOL_RESOLUTION ";

// No real profile reaches the children, and no credential either: listing tools needs none, and the
// end-to-end read must fail in the connector for want of one.
const sandboxHome = mkdtempSync(join(tmpdir(), "nimbus-session-tool-resolution-"));
const childEnv = extensionProcessEnv(
  Object.fromEntries(
    ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP"].map((k) => [
      k,
      sandboxHome,
    ]),
  ),
);

afterAll(() => {
  __setSessionSpawnerForTest(undefined);
  rmSync(sandboxHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function runProbe(): Promise<ProbeReport> {
  const spec: ProbeSpec = { clients: CLIENTS, reads: READS };
  const proc = Bun.spawn([process.execPath, PROBE, JSON.stringify(spec)], {
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const deadline = setTimeout(() => proc.kill(), 150_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code, `probe exited ${String(code)}: ${stderr}`).toBe(0);
    const line = stdout.split("\n").find((l) => l.startsWith(MARKER));
    expect(line, `probe printed no result: ${stdout}\n${stderr}`).toBeDefined();
    return JSON.parse((line ?? "").slice(MARKER.length)) as ProbeReport;
  } finally {
    clearTimeout(deadline);
  }
}

let probed: Promise<ProbeReport> | undefined;
/** The probe runs once; the first test to ask pays for it, under its own timeout. */
function report(): Promise<ProbeReport> {
  probed ??= runProbe();
  return probed;
}

const PROBE_TIMEOUT_MS = 180_000;

/** A map keyed exactly as `client` listed its tools, each recording its key in `ran`. */
async function listedMap(client: string, ran: string[]): Promise<LazyMeshToolMap> {
  const keys = (await report()).clients[client]?.keys ?? [];
  return Object.fromEntries(
    keys.map((key) => [
      key,
      {
        execute: async () => {
          ran.push(key);
          // An empty list page for a list tool, an id for anything else; both are harmless here.
          return { content: [{ type: "text", text: '{"items":[],"nextCursor":null}' }], id: key };
        },
      },
    ]),
  );
}

/** Serve `client`'s real listing to every session the gateway opens. */
async function serveSessions(client: string, ran: string[]): Promise<void> {
  const tools = await listedMap(client, ran);
  __setSessionSpawnerForTest(() => ({ listTools: async () => tools, disconnect: async () => {} }));
}

describe("the key scheme a real session lists", () => {
  test(
    "listTools() keys are exactly <server>_<tool> over listToolsets(), for every server",
    async () => {
      const { clients } = await report();
      for (const [client, servers] of Object.entries(CLIENTS)) {
        const listed = clients[client];
        expect(listed, `${client} was not listed`).toBeDefined();
        for (const server of Object.keys(servers)) {
          expect(
            listed?.toolsets[server]?.length ?? 0,
            `${server} listed no tools`,
          ).toBeGreaterThan(0);
        }
        const expected = Object.entries(listed?.toolsets ?? {}).flatMap(([server, names]) =>
          names.map((name) => `${server}_${name}`),
        );
        const byName = (a: string, b: string) => a.localeCompare(b);
        expect([...(listed?.keys ?? [])].sort(byName)).toEqual(expected.sort(byName));
      }
    },
    PROBE_TIMEOUT_MS,
  );
});

describe("resolveServerTool over every real listing", () => {
  test(
    "each server resolves exactly its own tools by bare id, and never another server's",
    async () => {
      const { clients } = await report();
      let refusedNested = 0;
      for (const [client, listed] of Object.entries(clients)) {
        for (const [server, byId] of Object.entries(listed.resolved)) {
          const own = new Set(listed.toolsets[server]);
          for (const [id, key] of Object.entries(byId)) {
            const where = `${client}: ${server} asked for ${id}`;
            expect(key, where).toBe(own.has(id) ? `${server}_${id}` : null);
            if (key === null && serviceIdForToolKey(`${server}_${id}`) !== server) refusedNested++;
          }
        }
      }
      // Non-vacuity: the github client really does nest, so some spelling formed a sibling's key
      // and was refused — `github_` + `actions_gha_run_trigger` among them.
      expect(clients["github"]?.resolved["github"]?.["actions_gha_run_trigger"]).toBeNull();
      expect(refusedNested).toBeGreaterThan(0);
    },
    PROBE_TIMEOUT_MS,
  );
});

describe("the bare ids the gateway sends, through each caller, over the real listing", () => {
  test(
    "every dispatchable connector write: personal transport, and the local team write's seam",
    async () => {
      const ran: string[] = [];
      await serveSessions("phase3", ran);
      const personal = {
        vault: EMPTY_NIMBUS_VAULT,
        sandboxCwd: sandboxHome,
        isConnectorAllowed: () => true,
        credentialFor: () => ({ credential: "personal" as const }),
        runTeamInvoke: () => Promise.reject(new Error("not the team path")),
      };
      for (const w of CONNECTOR_WRITES) {
        const key = `${w.service}_${w.toolId}`;
        ran.length = 0;
        await invokeConnectorWrite(personal, {
          service: w.service,
          writeToolId: w.toolId,
          args: {},
        });
        expect(ran, `personal ${w.toolId}`).toEqual([key]);
        ran.length = 0;
        // The team-credentialed local write (`localOpInvokeCtx`) spawns through this seam.
        await spawnTeamWriteAndCall({
          service: w.service,
          toolId: w.toolId,
          args: {},
          vaultView: EMPTY_NIMBUS_VAULT,
          sandboxCwd: sandboxHome,
        });
        expect(ran, `team ${w.toolId}`).toEqual([key]);
      }
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "the federated seam runs a peer's id only as the exact listed key, for every real tool",
    async () => {
      // The owner's grant, its revocation, the quorum rule and I26 all judge a peer's id as a
      // string, so the federated anchor's seam must not give any tool a second spelling: for every
      // tool every listed server has — reads and writes, classified by I26 or not — its bare name
      // runs nothing, and its listed key runs exactly that tool.
      const { clients } = await report();
      let checked = 0;
      for (const client of Object.keys(CLIENTS)) {
        const ran: string[] = [];
        await serveSessions(client, ran);
        for (const [server, names] of Object.entries(clients[client]?.toolsets ?? {})) {
          for (const name of names) {
            const call = (toolId: string) =>
              spawnTeamToolAndCall({
                service: server,
                toolId,
                args: {},
                vaultView: EMPTY_NIMBUS_VAULT,
                sandboxCwd: sandboxHome,
              });
            ran.length = 0;
            await expect(call(name), `${server}: bare ${name}`).rejects.toThrow(
              `connector-session: tool "${name}" not found for service "${server}"`,
            );
            expect(ran, `${server}: bare ${name}`).toEqual([]);
            await call(`${server}_${name}`);
            expect(ran, `${server}: listed ${name}`).toEqual([`${server}_${name}`]);
            checked++;
          }
        }
      }
      // Non-vacuity: the listings are real and large, and carry the mutations a peer must not reach
      // by bare name — gate-confined writes and writes once registered as reads among them.
      expect(checked).toBeGreaterThan(100);
      for (const [server, name] of [
        ["aws", "aws_ec2_instance_stop"],
        ["aws", "aws_ec2_instance_start"],
        ["notion", "notion_kb_append"],
        ["confluence", "confluence_kb_append"],
        ["slack", "slack_chat_post"],
        ["teams", "teams_chat_post"],
      ] as const) {
        const client = server === "aws" ? "phase3" : "comms";
        expect(clients[client]?.toolsets[server], `${server} lists ${name}`).toContain(name);
      }
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "every warehouse/BI syncable drains its lists, with a personal and with a team credential",
    async () => {
      const ran: string[] = [];
      await serveSessions("phase3", ran);
      const syncables: readonly Syncable[] = [
        createSnowflakeSyncable(),
        createTableauSyncable(),
        createLookerSyncable(),
        createPowerBiSyncable(),
        createMonteCarloSyncable(),
        createBigeyeSyncable(),
      ];
      for (const syncable of syncables) {
        const service = syncable.serviceId as ConnectorServiceId;
        for (const credential of ["personal", "team"] as const) {
          ran.length = 0;
          const ctx: SyncContext = {
            ...buildSyncCapabilities(
              { vault: EMPTY_NIMBUS_VAULT, db: new Database(":memory:"), depth: "full" },
              service,
            ),
            logger: {} as SyncContext["logger"],
            rateLimiter: {} as SyncContext["rateLimiter"],
            sandboxCwd: sandboxHome,
            depth: "full",
            credentialFor: () =>
              credential === "team"
                ? { credential: "team", teamEntry: `team-${service}` }
                : { credential: "personal" },
            // The production team drain, past the gate (which only checks the entry's service).
            runTeamList: (req) =>
              drainTeamListSession({
                service: req.service,
                vaultView: EMPTY_NIMBUS_VAULT,
                sandboxCwd: sandboxHome,
                listToolId: req.listToolId,
              }),
          };
          const result = await syncable.sync(ctx, null);
          expect(result.hasMore, `${service} ${credential}`).toBe(false);
          expect(ran.length, `${service} ${credential} drained nothing`).toBeGreaterThan(0);
          for (const key of ran) expect(serviceIdForToolKey(key), key).toBe(service);
        }
      }
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "the tribal KB capture, through the executor and the mesh dispatcher",
    async () => {
      for (const target of ["notion", "confluence"] as const) {
        const ran: string[] = [];
        const tools = await listedMap("comms", ran);
        const executor = new ToolExecutor(
          { requestApproval: async () => true },
          { recordAudit: () => {} },
          createConnectorDispatcher({ listTools: async () => tools }),
          undefined,
          NULL_EGRESS_SINK,
        );
        const captured: string[] = [];
        const result = await captureToKnowledgeBase(
          {
            cfg: {
              notion: { databaseId: "db" },
              confluence: { spaceKey: "ENG", parentPageId: "1" },
            },
            synthesize: async () => ({ title: "t", bodyMarkdown: "b", citations: [] }),
            submitAction: async (action) => {
              const res = await executor.execute({ type: action.type, payload: action.payload });
              return res.status === "ok"
                ? { status: "approved", result: { pageRef: `${target}:p` } }
                : { status: "rejected" };
            },
            store: { markCaptured: (id: string) => void captured.push(id) } as never,
            cooldownDays: 1,
            now: () => 1,
          },
          { clusterId: "c1" } as TribalCluster,
          target,
        );
        expect(result, target).toEqual({ ok: true, pageRef: `${target}:p` });
        expect(ran, target).toEqual([`${target}_${target}_kb_append`]);
        expect(captured).toEqual(["c1"]);
      }
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "the ChatOps operational posts, through the bot session lookup",
    async () => {
      const ran: string[] = [];
      const tools = await listedMap("comms", ran);
      const botClient = {
        listTools: async () => tools,
        disconnect: async () => {},
      } as unknown as Parameters<typeof runBotToolCall>[0];
      // The real I23 post builder names the post tools; the bot runner resolves them.
      const post = buildConnectorPost(
        (platform, toolId, args) => runBotToolCall(botClient, platform, toolId, args),
        () => undefined,
      );
      await post("slack", "C1", "hi");
      await post("teams", "conv-1", "hi");
      expect(ran).toEqual(["slack_slack_chat_post", "teams_teams_chat_post"]);
    },
    PROBE_TIMEOUT_MS,
  );
});

describe("a real read, end to end", () => {
  test(
    "reaches the connector's own handler through the real session, dispatcher and federated seam",
    async () => {
      const { reads } = await report();
      const [hit, miss] = reads;
      // The connector itself answered: it was found, ran, and failed for want of a credential —
      // before any network call. A lookup miss would say "not found" instead.
      expect(hit?.session).toContain("SNOWFLAKE_ACCOUNT is not set");
      expect(hit?.dispatcher).toContain("SNOWFLAKE_ACCOUNT is not set");
      // The federated seam reaches it by its listed key only; the bare id is no name for it there.
      expect(hit?.federatedListed).toContain("SNOWFLAKE_ACCOUNT is not set");
      expect(hit?.federatedBare).toBe(
        'connector-session: tool "snowflake_list" not found for service "snowflake"',
      );
      // Control: a tool the connector does not list is still a miss, on every path.
      expect(miss?.session).toMatch(
        /tool "snowflake_no_such_tool" not found for service "snowflake"/,
      );
      expect(miss?.dispatcher).toMatch(/Tool not found/);
      expect(miss?.federatedBare).toMatch(/tool "snowflake_no_such_tool" not found/);
      expect(miss?.federatedListed).toMatch(/tool "snowflake_snowflake_no_such_tool" not found/);
    },
    PROBE_TIMEOUT_MS,
  );
});
