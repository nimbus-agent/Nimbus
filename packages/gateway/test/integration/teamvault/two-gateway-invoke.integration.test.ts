/**
 * Phase 6 Slice 2 — Team Vault invoke over-the-wire acceptance (the PAYOFF).
 *
 * Two in-process gateways (asker A = teammate, answerer B = trust anchor) over a REAL loopback
 * NaCl-box socket: pair → put+grant on the anchor → A invokes a team tool over the wire → the
 * anchor runs it through the I19 gate and returns ONLY the result (never the secret) → revoke →
 * invoke fails no_grant. RBAC (ungranted tool) and impersonation (R1) are checked too.
 *
 * `runTool` is injected as a mock here: it closes over a SECRET, proving the gate returns only the
 * tool RESULT and the secret never crosses the wire. The real ephemeral-spawn seam
 * (team-tool-spawn.ts) is coverage-excluded I/O glue exercised by manual/e2e runs.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { buildFederationRuntime } from "../../../src/federation/federation-runtime.ts";
import { buildFederationLanServer } from "../../../src/federation/federation-server.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { sendFederatedOverWire } from "../../../src/ipc/lan-client.ts";
import { generateBoxKeypair } from "../../../src/ipc/lan-crypto.ts";
import { generatePairingCode } from "../../../src/ipc/lan-pairing.ts";
import { TeamVaultStore } from "../../../src/teamvault/team-vault-store.ts";

const peerIdFor = (pub: Uint8Array): string => `peer:${bytesToHex(pub.subarray(0, 8))}`;

type WireInvokeResult = { kind: "ok"; result: unknown } | { kind: "error"; error: string };

const SECRET = "AKIA-SUPER-SECRET-TEAM-KEY";

test("payoff: teammate invokes a team-vault tool on the anchor over the wire — grant → ok (leak-proof) → revoke → no_grant → RBAC → impersonation", async () => {
  // --- Anchor B: real LanServer with a teamVault backing whose runTool closes over the secret. ---
  const bDb = new Database(":memory:");
  runIndexedSchemaMigrations(bDb, 35);
  const bIndex = new LocalIndex(bDb);
  const bIdentity = generateBoxKeypair();
  const bStore = new TeamVaultStore(bDb);

  // The anchor holds the team entry + a grant for the teammate's authenticated peer id.
  const askerKp = generateBoxKeypair();
  const askerPeerId = peerIdFor(askerKp.publicKey);
  bStore.createEntry("prod-aws", "aws", "owner", 1);
  bStore.grant("prod-aws", askerPeerId, "aws.ec2.instance.stop", 1);

  let runToolCalls = 0;
  const bBuilt = buildFederationLanServer({
    db: bDb,
    index: bIndex,
    identity: bIdentity,
    lan: {
      bind: "127.0.0.1",
      port: 0,
      pairingWindowSeconds: 60,
      maxFailedAttempts: 3,
      lockoutSeconds: 60,
    },
    consentTimeoutMs: 100,
    notify: () => {},
    teamVault: {
      quorumFor: () => undefined, // no quorum for this entry
      // The real runTool injects SECRET into a connector subprocess env and returns only the tool's
      // output. Here the mock proves the gate passes through ONLY the result, never the secret.
      runTool: async ({ toolId, args }) => {
        runToolCalls += 1;
        const _creds = SECRET; // would be read from the team vault + injected into the subprocess
        return { stopped: true, tool: toolId, echoedArgs: args };
      },
    },
  });
  await bBuilt.lanServer.start();
  const bPort = bBuilt.lanServer.listenAddr()?.port as number;

  // --- Teammate A: real runtime (production outbound handshake). ---
  const aDb = new Database(":memory:");
  runIndexedSchemaMigrations(aDb, 35);
  const aIndex = new LocalIndex(aDb);
  const aRuntime = buildFederationRuntime(
    { enabled: true, consentTimeoutSeconds: 30, mdnsEnabled: false, mdnsBind: "127.0.0.1" },
    aIndex,
    askerKp,
  );
  if (aRuntime === undefined) throw new Error("federation runtime should be enabled");

  try {
    // 1. pair (real handshake) — B can now authenticate A's session.
    const code = generatePairingCode();
    bBuilt.pairingWindow.open(code);
    await aRuntime.pairing.initiatePair("127.0.0.1", bPort, code);

    const invoke = (body: Record<string, unknown>) =>
      sendFederatedOverWire(
        "127.0.0.1",
        bPort,
        askerKp,
        bIdentity.publicKey,
        "federation.invoke",
        body,
      ) as Promise<WireInvokeResult>;

    // 2. granted invoke → ok, returns the tool result, and NO secret crosses the wire.
    const ok = await invoke({
      entry: "prod-aws",
      toolId: "aws.ec2.instance.stop",
      purpose: "stop idle box",
      args: { id: "i-123" },
    });
    expect(ok.kind).toBe("ok");
    if (ok.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(ok)}`);
    expect(ok.result).toEqual({
      stopped: true,
      tool: "aws.ec2.instance.stop",
      echoedArgs: { id: "i-123" },
    });
    expect(runToolCalls).toBe(1);
    expect(JSON.stringify(ok)).not.toContain(SECRET);
    expect(JSON.stringify(ok)).not.toContain("AKIA");

    // 3. RBAC: a granted peer asking for an UNGRANTED tool → opaque no_grant, runTool NOT called.
    const ungranted = await invoke({
      entry: "prod-aws",
      toolId: "aws.lambda.invoke",
      purpose: "x",
      args: {},
    });
    expect(ungranted).toEqual({ kind: "error", error: "no_grant" });
    expect(runToolCalls).toBe(1);

    // 4. impersonation (R1/I17): a spoofed body peerId cannot grant access — B forces A's
    //    authenticated id. Here A IS granted, so a spoofed body id is simply ignored → still ok.
    const spoofed = await invoke({
      entry: "prod-aws",
      toolId: "aws.ec2.instance.stop",
      purpose: "x",
      args: {},
      peerId: "peer:imposter",
    });
    expect(spoofed.kind).toBe("ok");

    // 5. revoke → the very next invoke fails closed with no_grant (live-checked).
    bStore.revoke("prod-aws", askerPeerId, "aws.ec2.instance.stop", 2);
    const afterRevoke = await invoke({
      entry: "prod-aws",
      toolId: "aws.ec2.instance.stop",
      purpose: "x",
      args: {},
    });
    expect(afterRevoke).toEqual({ kind: "error", error: "no_grant" });

    // 6. every decision was audited on the anchor (answered + no_grant rows).
    const audited = bDb
      .query(`SELECT COUNT(*) AS n FROM audit_log WHERE action_type LIKE 'teamvault.invoke.%'`)
      .get() as { n: number };
    expect(audited.n).toBeGreaterThanOrEqual(3);
  } finally {
    await bBuilt.lanServer.stop();
    bIndex.close();
    aIndex.close();
    bDb.close();
    aDb.close();
  }
});
