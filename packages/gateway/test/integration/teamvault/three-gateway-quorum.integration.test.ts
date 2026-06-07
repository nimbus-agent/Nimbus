/**
 * Phase 6 Slice 2 — Quorum HITL acceptance: a single approval stays locked.
 *
 * Teammate A invokes a quorum-gated tool on anchor B over a REAL NaCl-box socket. The anchor's
 * invoke gate broadcasts a quorum request and BLOCKS the wire response until quorum resolves:
 *
 *   - a SINGLE distinct approval lets the window elapse → quorum_failed, the tool NEVER runs.
 *   - TWO DISTINCT approvals → approved → the tool runs exactly once.
 *
 * The approvals are fed to the process-wide QuorumCoordinator (the same singleton the anchor's
 * gate awaits) with distinct peer ids — this is what an authenticated federation.quorumRespond
 * resolves to (the wire path for a single respond is covered in federation-rpc-invoke.test.ts).
 * Distinct-peer counting (I21) is the property under test.
 */
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { quorumCoordinator } from "../../../src/engine/quorum/quorum-singleton.ts";
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

afterEach(() => {
  quorumCoordinator.setBroadcast(() => {});
});

test("a single approval stays locked; two distinct approvals unlock the team tool", async () => {
  const bDb = new Database(":memory:");
  runIndexedSchemaMigrations(bDb, 35);
  const bIndex = new LocalIndex(bDb);
  const bIdentity = generateBoxKeypair();
  const bStore = new TeamVaultStore(bDb);

  const askerKp = generateBoxKeypair();
  bStore.createEntry("prod-aws", "aws", "owner", 1);
  bStore.grant("prod-aws", peerIdFor(askerKp.publicKey), "iac.terraform.destroy", 1);

  let runToolCalls = 0;
  const bBuilt = buildFederationLanServer({
    db: bDb,
    index: bIndex,
    identity: bIdentity,
    lan: {
      bind: "127.0.0.1",
      port: 0,
      pairingWindowSeconds: 60,
      maxFailedAttempts: 5,
      lockoutSeconds: 60,
    },
    consentTimeoutMs: 100,
    notify: () => {},
    teamVault: {
      quorumFor: (toolId) =>
        toolId === "iac.terraform.destroy" ? { approvers: 2, windowSeconds: 1 } : undefined,
      runTool: async ({ toolId }) => {
        runToolCalls += 1;
        return { destroyed: true, tool: toolId };
      },
    },
  });
  await bBuilt.lanServer.start();
  const bPort = bBuilt.lanServer.listenAddr()?.port as number;

  const aDb = new Database(":memory:");
  runIndexedSchemaMigrations(aDb, 35);
  const aIndex = new LocalIndex(aDb);
  const aRuntime = buildFederationRuntime(
    { enabled: true, consentTimeoutSeconds: 30, mdnsEnabled: false, mdnsBind: "127.0.0.1" },
    aIndex,
    askerKp,
  );
  if (aRuntime === undefined) throw new Error("runtime enabled");

  /** Resolves with the requestId the anchor's gate broadcasts when it enters the quorum wait. */
  const nextRequestId = (): Promise<string> =>
    new Promise<string>((resolve) => quorumCoordinator.setBroadcast((rid) => resolve(rid)));

  const invoke = () =>
    sendFederatedOverWire("127.0.0.1", bPort, askerKp, bIdentity.publicKey, "federation.invoke", {
      entry: "prod-aws",
      toolId: "iac.terraform.destroy",
      purpose: "teardown",
      args: {},
    }) as Promise<WireInvokeResult>;

  try {
    const code = generatePairingCode();
    bBuilt.pairingWindow.open(code);
    await aRuntime.pairing.initiatePair("127.0.0.1", bPort, code);

    // --- Case 1: a SINGLE distinct approval → the 1s window elapses → quorum_failed, no run. ---
    let ridP = nextRequestId();
    const lockedInvoke = invoke();
    const rid1 = await ridP;
    quorumCoordinator.respond(rid1, "peer:carol", true); // only one distinct approver
    const locked = await lockedInvoke;
    expect(locked).toEqual({ kind: "error", error: "quorum_failed" });
    expect(runToolCalls).toBe(0);

    // --- Case 2: TWO DISTINCT approvals → approved → the tool runs exactly once. ---
    ridP = nextRequestId();
    const unlockInvoke = invoke();
    const rid2 = await ridP;
    quorumCoordinator.respond(rid2, "peer:carol", true);
    quorumCoordinator.respond(rid2, "peer:carol", true); // duplicate — must NOT count (I21)
    quorumCoordinator.respond(rid2, "peer:dave", true); // the distinct 2nd approver
    const unlocked = await unlockInvoke;
    expect(unlocked.kind).toBe("ok");
    if (unlocked.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(unlocked)}`);
    expect(unlocked.result).toEqual({ destroyed: true, tool: "iac.terraform.destroy" });
    expect(runToolCalls).toBe(1);
  } finally {
    await bBuilt.lanServer.stop();
    aIndex.close();
    aDb.close();
    bIndex.close();
    bDb.close();
  }
});
