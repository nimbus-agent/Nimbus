import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectorServiceId } from "../connectors/connector-catalog.ts";
import {
  CONNECTOR_VAULT_SECRET_KEYS,
  TEAM_SECRET_ANYOF_GROUPS,
} from "../connectors/connector-secrets-manifest.ts";
import {
  CONNECTOR_WRITES,
  isConnectorWriteToolId,
} from "../connectors/connector-write-registry.ts";
import { type LazyMeshToolMap, resolveServerTool } from "../connectors/lazy-mesh/tool-map.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { __setSessionSpawnerForTest } from "../teamvault/connector-session.ts";
import { invokeTeamTool } from "../teamvault/team-tool-invoke.ts";
import { spawnTeamToolAndCall } from "../teamvault/team-tool-spawn.ts";
import { teamVaultKey } from "../teamvault/team-vault-keys.ts";
import { TeamVaultStore } from "../teamvault/team-vault-store.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { dispatchFederationRpc, type FederationRpcContext } from "./federation-rpc.ts";

const PEER = "peer:abc";

function ctx(db: Database): FederationRpcContext {
  return {
    db,
    consentTimeoutMs: 1000,
    notify: () => {},
    discovery: { list: async () => [] } as never,
    pairing: { listPeers: () => [] } as never,
    teamVault: {
      quorumFor: () => undefined,
      runTool: async () => ({ ok: 1 }),
      isConnectorAllowed: () => true,
    },
  };
}

describe("federation.invoke dispatch", () => {
  it("returns no_grant when no grant exists (peerId forced by caller)", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    new TeamVaultStore(db).createEntry("prod-aws", "aws", "owner", 1);
    const out = await dispatchFederationRpc(
      "federation.invoke",
      { peerId: "peer:abc", entry: "prod-aws", toolId: "aws.lambda.invoke", purpose: "x" },
      ctx(db),
    );
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      expect(out.value).toEqual({ kind: "error", error: "no_grant" });
    }
  });

  it("runs the tool and returns ok for a granted (entry,peer,tool)", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const store = new TeamVaultStore(db);
    store.createEntry("prod-aws", "aws", "owner", 1);
    store.grant("prod-aws", "peer:abc", "aws.ec2.instance.stop", 1);
    const out = await dispatchFederationRpc(
      "federation.invoke",
      { peerId: "peer:abc", entry: "prod-aws", toolId: "aws.ec2.instance.stop", purpose: "x" },
      ctx(db),
    );
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      expect(out.value).toEqual({ kind: "ok", result: { ok: 1 } });
    }
  });

  it("hands the gate the context's own connector allowlist (I22): a blocked entry never runs", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const store = new TeamVaultStore(db);
    store.createEntry("prod-aws", "aws", "owner", 1);
    store.grant("prod-aws", "peer:abc", "aws.ec2.instance.stop", 1);
    const asked: string[] = [];
    let ran = 0;
    const base = ctx(db);
    const blocking: FederationRpcContext = {
      ...base,
      teamVault: {
        quorumFor: () => undefined,
        runTool: async () => {
          ran++;
          return { ok: 1 };
        },
        isConnectorAllowed: (service) => {
          asked.push(service);
          return false;
        },
      },
    };
    const out = await dispatchFederationRpc(
      "federation.invoke",
      { peerId: "peer:abc", entry: "prod-aws", toolId: "aws.ec2.instance.stop", purpose: "x" },
      blocking,
    );
    expect(out).toEqual({ kind: "hit", value: { kind: "error", error: "no_grant" } });
    expect({ asked, ran }).toEqual({ asked: ["aws"], ran: 0 });
  });

  it("federation.quorumRespond feeds the coordinator (no live request → matched false)", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const out = await dispatchFederationRpc(
      "federation.quorumRespond",
      { requestId: "nope", peerId: "peer:a", approved: true },
      ctx(db),
    );
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      expect(out.value).toEqual({ ok: true, matched: false });
    }
  });
});

// A team session lists every tool `<server>_<tool>` (`MCPClient.listTools()`), and the gateway's
// own callers now find a tool by its bare name on the session's server. The FEDERATED path must
// not: the owner's grant, its revocation, the quorum rule and I26's write predicate all judge the
// peer's id as a STRING, so that string has to be the one key that runs. These drive the real
// `federation.invoke` handler (which wires I26's `isConnectorWriteToolId`), the real invoke gate,
// the real `invokeTeamTool` secret check and the real `spawnTeamToolAndCall` / `withConnectorSession`
// lookup. Only the connector spawn is faked, serving a map keyed the way a real session lists it.
describe("federation.invoke over a real-shaped session: the peer names the listed key, exactly", () => {
  afterEach(() => __setSessionSpawnerForTest(undefined));

  const entryFor = (service: string): string => `team-${service.replaceAll("_", "-")}`;

  /** One team entry per service, holding every secret its manifest names; `grants` go to PEER. */
  function anchor(grants: ReadonlyArray<{ service: string; toolId: string }>): {
    db: Database;
    store: TeamVaultStore;
    runTool: NonNullable<FederationRpcContext["teamVault"]>["runTool"];
  } {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const store = new TeamVaultStore(db);
    const secrets = new Map<string, string>();
    for (const { service, toolId } of grants) {
      const entry = entryFor(service);
      if (store.getEntry(entry) === undefined) store.createEntry(entry, service, "owner", 1);
      store.grant(entry, PEER, toolId, 1);
      for (const key of CONNECTOR_VAULT_SECRET_KEYS[service as ConnectorServiceId]) {
        secrets.set(teamVaultKey(entry, key), "x");
      }
    }
    const vault: NimbusVault = {
      get: async (k) => secrets.get(k) ?? null,
      set: async () => {},
      delete: async () => {},
      listKeys: async () => [...secrets.keys()],
    };
    // The anchor's production runTool (platform/assemble.ts `teamVault.runTool`).
    const runTool: NonNullable<FederationRpcContext["teamVault"]>["runTool"] = (input) =>
      invokeTeamTool(
        {
          vault,
          sandboxCwd: join(tmpdir(), "nimbus-federation-invoke-session-test"),
          requiredSecretKeysFor: (s) => CONNECTOR_VAULT_SECRET_KEYS[s as ConnectorServiceId],
          anyOfSecretGroupsFor: (s) => TEAM_SECRET_ANYOF_GROUPS[s as ConnectorServiceId],
          spawnAndCall: spawnTeamToolAndCall,
        },
        input,
      );
    return { db, store, runTool };
  }

  /** `names` keyed the way a real session lists them, `<service>_<name>`; each run records its key. */
  function listedTools(service: string, names: readonly string[], ran: string[]): LazyMeshToolMap {
    return Object.fromEntries(
      names.map((name) => {
        const key = `${service}_${name}`;
        const tool = {
          execute: async () => {
            ran.push(key);
            return { ran: key };
          },
        };
        return [key, tool];
      }),
    );
  }

  /** Serve, for any spawned service, its listed tools; record spawns and runs. */
  function serveListed(toolsByService: ReadonlyMap<string, readonly string[]>): {
    spawns: string[];
    ran: string[];
  } {
    const spawns: string[] = [];
    const ran: string[] = [];
    __setSessionSpawnerForTest((req) => {
      spawns.push(req.service);
      const tools = listedTools(req.service, toolsByService.get(req.service) ?? [], ran);
      return { listTools: async () => tools, disconnect: async () => {} };
    });
    return { spawns, ran };
  }

  /** The handler's context over `runTool`, recording every id the quorum rule is asked about. */
  function rpc(
    db: Database,
    runTool: NonNullable<FederationRpcContext["teamVault"]>["runTool"],
    quorumAsked: string[] = [],
  ): FederationRpcContext {
    return {
      db,
      consentTimeoutMs: 1000,
      notify: () => {},
      discovery: { list: async () => [] } as never,
      pairing: { listPeers: () => [] } as never,
      teamVault: {
        quorumFor: (toolId) => {
          quorumAsked.push(toolId);
          return undefined;
        },
        runTool,
        isConnectorAllowed: () => true,
      },
    };
  }

  /** Invoke as PEER: the dispatch result, or the message it rejected with. */
  async function invoke(
    c: FederationRpcContext,
    service: string,
    toolId: string,
  ): Promise<{ readonly value: unknown } | { readonly error: string }> {
    try {
      const value = await dispatchFederationRpc(
        "federation.invoke",
        { peerId: PEER, entry: entryFor(service), toolId, purpose: "p", args: {} },
        c,
      );
      return { value };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  const REFUSED = { value: { kind: "hit", value: { kind: "error", error: "no_grant" } } };

  const lastDecision = (db: Database): string | undefined =>
    (
      db.query(`SELECT action_type FROM audit_log ORDER BY id DESC LIMIT 1`).get() as
        | { action_type: string }
        | undefined
    )?.action_type;

  test("a granted sibling server's key on a github entry runs only when the policy allows that server too (I22)", async () => {
    // The github spawner registers `github_actions` beside `github` in ONE client, so a github
    // session lists the sibling's tools under the sibling's name, and the anchor runs a peer's key
    // exactly as listed. The entry names github; the tool that would run is github_actions'.
    const siblingKey = "github_actions_gha_run_list";
    const { db, runTool } = anchor([{ service: "github", toolId: siblingKey }]);
    const spawns: string[] = [];
    const ran: string[] = [];
    __setSessionSpawnerForTest((req) => {
      spawns.push(req.service);
      const tools = listedTools("github_actions", ["gha_run_list"], ran);
      return { listTools: async () => tools, disconnect: async () => {} };
    });
    const allowing = (allowed: ReadonlySet<string>): FederationRpcContext => {
      const base = rpc(db, runTool);
      const tv = base.teamVault;
      if (tv === undefined) throw new Error("rpc() builds a teamVault");
      return { ...base, teamVault: { ...tv, isConnectorAllowed: (s) => allowed.has(s) } };
    };

    // Premise: with both servers allowed the anchor does run the sibling's tool on the github session.
    expect(
      await invoke(allowing(new Set(["github", "github_actions"])), "github", siblingKey),
    ).toEqual({ value: { kind: "hit", value: { kind: "ok", result: { ran: siblingKey } } } });
    expect({ spawns, ran }).toEqual({ spawns: ["github"], ran: [siblingKey] });

    // Blocking github_actions refuses it though the entry names github: nothing more spawns or runs.
    expect(await invoke(allowing(new Set(["github"])), "github", siblingKey)).toEqual(REFUSED);
    expect({ spawns, ran }).toEqual({ spawns: ["github"], ran: [siblingKey] });
    expect(lastDecision(db)).toBe("teamvault.invoke.connector_blocked");
  });

  // Every dispatchable connector write (from the registry, not a hand list), plus a migrated
  // write on a single-service spawner.
  const writes: ReadonlyArray<{ service: string; toolId: string }> = [
    ...CONNECTOR_WRITES.map((w) => ({ service: w.service, toolId: w.toolId })),
    { service: "github", toolId: "github_pr_merge" },
  ];

  for (const write of writes) {
    test(`${write.toolId}: a granted BARE write id is refused at the I26 door, before any spawn`, async () => {
      const { db, runTool } = anchor([write]);
      const { spawns, ran } = serveListed(new Map([[write.service, [write.toolId]]]));
      // Premise: the shared resolver exists and WOULD map this bare id to the listed write.
      expect(
        resolveServerTool(
          listedTools(write.service, [write.toolId], []),
          write.service,
          write.toolId,
        ),
      ).toBeDefined();

      expect(await invoke(rpc(db, runTool), write.service, write.toolId)).toEqual(REFUSED);
      expect(lastDecision(db)).toBe("teamvault.invoke.write_forbidden");
      expect(spawns).toEqual([]); // refused before runTool: nothing was spawned
      expect(ran).toEqual([]);
    });
  }

  // The federated seam never resolves a bare id, so whether a granted bare id may run does not
  // depend on how complete I26's write predicate is. These are reads, and mutations whose
  // classification by that predicate this test deliberately does not rely on: where the predicate
  // classifies one, I26 refuses it before any spawn; where it does not, the connector is spawned and
  // the bare id is not found. Neither path runs it.
  const bareIds: ReadonlyArray<{ service: string; toolId: string }> = [
    { service: "snowflake", toolId: "snowflake_list" },
    { service: "github", toolId: "github_pr_list" },
    { service: "aws", toolId: "aws_ec2_instance_stop" },
    { service: "aws", toolId: "aws_ec2_instance_start" },
    { service: "notion", toolId: "notion_kb_append" },
    { service: "confluence", toolId: "confluence_kb_append" },
    { service: "slack", toolId: "slack_chat_post" },
    { service: "slack", toolId: "slack_message_post_dm" },
    { service: "teams", toolId: "teams_chat_post" },
    { service: "teams", toolId: "teams_message_post_chat" },
  ];

  for (const { service, toolId } of bareIds) {
    test(`${toolId}: a granted BARE id runs nothing on the federated path, whatever I26 says of it`, async () => {
      const { db, runTool } = anchor([{ service, toolId }]);
      const { spawns, ran } = serveListed(new Map([[service, [toolId]]]));
      // Premise: the tool is there — the resolver the gateway's own callers use WOULD find it.
      expect(resolveServerTool(listedTools(service, [toolId], []), service, toolId)).toBeDefined();

      const outcome = await invoke(rpc(db, runTool), service, toolId);

      expect(ran).toEqual([]);
      if (isConnectorWriteToolId(toolId)) {
        expect(outcome).toEqual(REFUSED);
        expect(spawns).toEqual([]);
      } else {
        expect(outcome).toEqual({
          error: `connector-session: tool "${toolId}" not found for service "${service}"`,
        });
        expect(spawns).toEqual([service]);
      }
    });
  }

  test("the granted LISTED key is answered, and quorum is asked about that same key", async () => {
    const key = "snowflake_snowflake_list";
    const { db, runTool } = anchor([{ service: "snowflake", toolId: key }]);
    const { ran } = serveListed(new Map([["snowflake", ["snowflake_list"]]]));
    const quorumAsked: string[] = [];

    expect(await invoke(rpc(db, runTool, quorumAsked), "snowflake", key)).toEqual({
      value: { kind: "hit", value: { kind: "ok", result: { ran: key } } },
    });
    expect(ran).toEqual([key]);
    expect(quorumAsked).toEqual([key]);
    expect(lastDecision(db)).toBe("teamvault.invoke.answered");
  });

  test("one string, one tool: a grant on either spelling never authorizes the other", async () => {
    const key = "snowflake_snowflake_list";
    const bare = "snowflake_list";
    const { spawns, ran } = serveListed(new Map([["snowflake", [bare]]]));

    // Granted the listed key only: the bare spelling is refused at the grant check.
    const listedOnly = anchor([{ service: "snowflake", toolId: key }]);
    const quorumAsked: string[] = [];
    expect(
      await invoke(rpc(listedOnly.db, listedOnly.runTool, quorumAsked), "snowflake", bare),
    ).toEqual(REFUSED);
    expect(lastDecision(listedOnly.db)).toBe("teamvault.invoke.no_grant");

    // Granted the bare spelling only: the listed key is refused at the grant check, and the bare
    // grant itself runs nothing (it was inert before this change and stays inert).
    const bareOnly = anchor([{ service: "snowflake", toolId: bare }]);
    expect(await invoke(rpc(bareOnly.db, bareOnly.runTool, quorumAsked), "snowflake", key)).toEqual(
      REFUSED,
    );
    expect(lastDecision(bareOnly.db)).toBe("teamvault.invoke.no_grant");
    expect(await invoke(rpc(bareOnly.db, bareOnly.runTool), "snowflake", bare)).toEqual({
      error: `connector-session: tool "${bare}" not found for service "snowflake"`,
    });

    expect(ran).toEqual([]);
    expect(spawns).toEqual(["snowflake"]); // only the inert bare grant's attempt spawned
    expect(quorumAsked).toEqual([]); // neither refusal got as far as the quorum rule
  });

  test("revoking the listed key cuts access, even beside a stale grant on the bare spelling", async () => {
    const key = "snowflake_snowflake_list";
    const bare = "snowflake_list";
    const { db, store, runTool } = anchor([
      { service: "snowflake", toolId: key },
      { service: "snowflake", toolId: bare },
    ]);
    const { ran } = serveListed(new Map([["snowflake", [bare]]]));
    const c = rpc(db, runTool);
    expect(await invoke(c, "snowflake", key)).toEqual({
      value: { kind: "hit", value: { kind: "ok", result: { ran: key } } },
    });

    store.revoke(entryFor("snowflake"), PEER, key, 2);

    expect(await invoke(c, "snowflake", key)).toEqual(REFUSED);
    expect(await invoke(c, "snowflake", bare)).toEqual({
      error: `connector-session: tool "${bare}" not found for service "snowflake"`,
    });
    expect(ran).toEqual([key]); // only the run before the revocation
  });
});
