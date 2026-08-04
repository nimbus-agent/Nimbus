/**
 * Phase 6 Slice 2 — Delegated HITL acceptance: an approval is recorded in BOTH logs.
 *
 * Owner A delegates `email.send` approvals to delegate B. A HITL action fires on A; A's executor
 * gate routes the approval to B OVER THE WIRE (`federation.requestApproval`); B approves and AUDITS
 * its own decision; A audits the final result. The decision lands in BOTH A's and B's audit logs.
 * When B is offline, A falls back to the local owner prompt (D10).
 *
 * Uses the real production mechanism end-to-end: `buildDelegatedRequestRemote` (owner side) + the
 * `federation.requestApproval` handler with its delegate-side `delegateApproval` prompter.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { NULL_EGRESS_SINK } from "../../../src/egress/egress-ledger.ts";
import { buildDelegatedRequestRemote } from "../../../src/engine/delegated-request-remote.ts";
import { DelegationStore } from "../../../src/engine/delegation-store.ts";
import { ToolExecutor } from "../../../src/engine/executor.ts";
import type { ConsentChannel } from "../../../src/engine/types.ts";
import { buildFederationRuntime } from "../../../src/federation/federation-runtime.ts";
import { buildFederationLanServer } from "../../../src/federation/federation-server.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { generateBoxKeypair } from "../../../src/ipc/lan-crypto.ts";
import { generatePairingCode } from "../../../src/ipc/lan-pairing.ts";

const FAR_FUTURE = 9e15; // absolute ms; the gate + requestRemote read real Date.now()
const noConnector = { dispatch: async () => ({}) };

test("a delegated HITL approval is recorded in BOTH the owner's and the delegate's audit logs; offline falls back to the owner", async () => {
  // --- Delegate B: a real LanServer whose delegateApproval auto-approves and audits on B's db. ---
  const bDb = new Database(":memory:");
  runIndexedSchemaMigrations(bDb, 35);
  const bIndex = new LocalIndex(bDb);
  const bIdentity = generateBoxKeypair();
  let bPrompted = 0;
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
    delegateApproval: async () => {
      bPrompted += 1;
      return true; // B's human approves
    },
  });
  await bBuilt.lanServer.start();
  const bPort = bBuilt.lanServer.listenAddr()?.port as number;

  // --- Owner A: real runtime + a DelegationStore that routes email.send approvals to B. ---
  const aDb = new Database(":memory:");
  runIndexedSchemaMigrations(aDb, 35);
  const aIndex = new LocalIndex(aDb);
  const askerKp = generateBoxKeypair();
  const aRuntime = buildFederationRuntime(
    { enabled: true, consentTimeoutSeconds: 30, mdnsEnabled: false, mdnsBind: "127.0.0.1" },
    aIndex,
    askerKp,
  );
  if (aRuntime === undefined) throw new Error("runtime enabled");

  const aStore = new DelegationStore(aDb);

  try {
    // Pair so A knows B's address and B can authenticate A's session.
    const code = generatePairingCode();
    bBuilt.pairingWindow.open(code);
    const bPeerId = await aRuntime.pairing.initiatePair("127.0.0.1", bPort, code);

    // A delegates email.send approvals to B.
    aStore.create({
      delegatePeer: bPeerId,
      scopeKind: "action_type",
      scopeValue: "email.send",
      expiresAt: FAR_FUTURE,
      nowMs: 1,
    });

    let localPrompted = 0;
    const consent: ConsentChannel = {
      requestApproval: async () => {
        localPrompted += 1;
        return true;
      },
    };
    const requestRemote = buildDelegatedRequestRemote({
      store: aStore,
      index: aIndex,
      selfIdentity: askerKp,
    });
    const exec = new ToolExecutor(
      consent,
      aIndex,
      noConnector,
      {
        store: aStore,
        isOperatorValid: () => true,
        requestRemote,
      },
      NULL_EGRESS_SINK,
    );

    // --- Online: the approval routes to B; B approves; both logs record it; no local prompt. ---
    const r = await exec.gate({ type: "email.send", payload: {} });
    expect(r).toBe("proceed");
    expect(bPrompted).toBe(1); // B decided
    expect(localPrompted).toBe(0); // A did NOT fall back to a local prompt

    const aRow = aDb
      .query(
        `SELECT hitl_status FROM audit_log WHERE action_type = 'email.send' ORDER BY id DESC LIMIT 1`,
      )
      .get() as { hitl_status: string } | null;
    expect(aRow?.hitl_status).toBe("approved"); // owner's log

    // The delegate's row records its answer in federation_json (I4: hitl_status is gate-output-only,
    // so this non-HITL-gated meta-record stays `not_required` — the decision is the federation field).
    const bRow = bDb
      .query(
        `SELECT hitl_status, federation_json FROM audit_log WHERE action_type = 'hitl.delegate.answered' ORDER BY id DESC LIMIT 1`,
      )
      .get() as { hitl_status: string; federation_json: string } | null;
    expect(bRow?.hitl_status).toBe("not_required"); // I4: never gate-forged outside executor
    expect(JSON.parse(bRow?.federation_json ?? "{}").decision).toBe("approved"); // delegate's decision

    // --- Offline: stop B → the wire request fails → A falls back to the local owner prompt (D10). ---
    await bBuilt.lanServer.stop();
    const r2 = await exec.gate({ type: "email.send", payload: {} });
    expect(r2).toBe("proceed");
    expect(localPrompted).toBe(1); // A prompted its own owner
  } finally {
    await bBuilt.lanServer.stop().catch(() => {});
    aIndex.close();
    aDb.close();
    bIndex.close();
    bDb.close();
  }
});
