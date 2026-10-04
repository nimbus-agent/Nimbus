import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectorServiceId } from "../connectors/connector-catalog.ts";
import {
  CONNECTOR_VAULT_SECRET_KEYS,
  TEAM_SECRET_ANYOF_GROUPS,
} from "../connectors/connector-secrets-manifest.ts";
import { CONNECTOR_WRITES } from "../connectors/connector-write-registry.ts";
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

// A team session now resolves a bare tool id to the `<server>_<tool>` key `MCPClient.listTools()`
// gives it, so a bare id a peer names CAN run where it used to be "not found". These drive the real
// `federation.invoke` handler (which wires I26's `isConnectorWriteToolId`), the real invoke gate,
// the real `invokeTeamTool` secret check and the real `spawnTeamToolAndCall` / `withConnectorSession`
// lookup — only the connector spawn is faked, serving a map keyed the way a real session lists it.
describe("federation.invoke over a session that resolves bare ids (I26)", () => {
  afterEach(() => __setSessionSpawnerForTest(undefined));

  /** One team entry per service, holding every secret its manifest names, granted to one peer. */
  function anchor(grants: ReadonlyArray<{ service: string; toolId: string }>): {
    db: Database;
    runTool: NonNullable<FederationRpcContext["teamVault"]>["runTool"];
  } {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const store = new TeamVaultStore(db);
    const secrets = new Map<string, string>();
    for (const { service, toolId } of grants) {
      const entry = `team-${service.replaceAll("_", "-")}`;
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
    return { db, runTool };
  }

  /** Serve, for any spawned service, its tools keyed `<service>_<tool>`; record spawns and runs. */
  function serveListed(toolsByService: ReadonlyMap<string, readonly string[]>): {
    spawns: string[];
    ran: string[];
  } {
    const spawns: string[] = [];
    const ran: string[] = [];
    __setSessionSpawnerForTest((req) => {
      spawns.push(req.service);
      const listed = (toolsByService.get(req.service) ?? []).map((t) => `${req.service}_${t}`);
      return {
        listTools: async () =>
          Object.fromEntries(
            listed.map((key) => [
              key,
              {
                execute: async () => {
                  ran.push(key);
                  return { ran: key };
                },
              },
            ]),
          ),
        disconnect: async () => {},
      };
    });
    return { spawns, ran };
  }

  const lastDecision = (db: Database): string =>
    (
      db.query(`SELECT action_type FROM audit_log ORDER BY id DESC LIMIT 1`).get() as {
        action_type: string;
      }
    ).action_type;

  // Every dispatchable connector write (from the registry, not a hand list) — each of those nine
  // connectors lists a `<service>_list` read — plus a migrated write on a single-service spawner.
  // The read is the control: the same entry, session and lookup, answered.
  const writes: ReadonlyArray<{ service: string; toolId: string; read: string }> = [
    ...CONNECTOR_WRITES.map((w) => ({
      service: w.service,
      toolId: w.toolId,
      read: `${w.service}_list`,
    })),
    { service: "github", toolId: "github_pr_merge", read: "github_pr_list" },
  ];

  for (const { read, ...write } of writes) {
    test(`${write.toolId}: a granted BARE write id is refused before runTool, though the session would run it`, async () => {
      const { db, runTool } = anchor([write, { service: write.service, toolId: read }]);
      const { spawns, ran } = serveListed(new Map([[write.service, [write.toolId, read]]]));
      const entry = `team-${write.service.replaceAll("_", "-")}`;
      const ctx: FederationRpcContext = {
        db,
        consentTimeoutMs: 1000,
        notify: () => {},
        discovery: { list: async () => [] } as never,
        pairing: { listPeers: () => [] } as never,
        teamVault: { quorumFor: () => undefined, runTool },
      };

      // Premise: the runTool this handler calls WOULD run the bare write — the session resolves it
      // to the listed `<service>_<tool>` key. Only I26, ahead of it, keeps it out.
      expect(
        await runTool({ entry, service: write.service, toolId: write.toolId, args: {} }),
      ).toEqual({ ran: `${write.service}_${write.toolId}` });
      expect(spawns).toEqual([write.service]);

      const refused = await dispatchFederationRpc(
        "federation.invoke",
        { peerId: PEER, entry, toolId: write.toolId, purpose: "p", args: {} },
        ctx,
      );
      expect(refused).toEqual({ kind: "hit", value: { kind: "error", error: "no_grant" } });
      expect(lastDecision(db)).toBe("teamvault.invoke.write_forbidden");
      expect(spawns).toEqual([write.service]); // no second spawn: refused before runTool
      expect(ran).toEqual([`${write.service}_${write.toolId}`]); // only the premise's run

      // Control: a granted bare READ on the same entry is answered through the same session.
      const answered = await dispatchFederationRpc(
        "federation.invoke",
        { peerId: PEER, entry, toolId: read, purpose: "p", args: {} },
        ctx,
      );
      expect(answered).toEqual({
        kind: "hit",
        value: { kind: "ok", result: { ran: `${write.service}_${read}` } },
      });
      expect(lastDecision(db)).toBe("teamvault.invoke.answered");
    });
  }
});
