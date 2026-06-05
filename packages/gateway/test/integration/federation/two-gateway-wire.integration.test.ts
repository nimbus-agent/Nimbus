/**
 * Phase 6 Slice 1 — Federation over-the-wire acceptance (the PAYOFF).
 *
 * Two in-process federation gateways (asker A, answerer B) over a REAL loopback NaCl-box socket,
 * walking the full Slice-1 acceptance in ONE ordered sequence:
 *
 *   discover → pair (real handshake) → publish → grant → consented leak-proof query →
 *   undeclared-empty → revoke → audit.verify → expertise → consent-timeout → impersonation.
 *
 * This is the end-to-end proof of the three Slice-1 deferred seams:
 *   (a) the production OUTBOUND LAN client wired into PeerPairing.initiatePair (real handshake),
 *   (b) the LanServer answering federated queries over the encrypted channel,
 *   (c) the owner-consent round-trip via the federationConsent broker.
 *
 * Wire shape note: `sendFederatedOverWire` returns the dispatcher's `out.value` (the unwrapped
 * `result`). For `federation.query` that value is the AnswerResult itself —
 * `{ kind: "ok"; response: { items } } | { kind: "error"; error }` — so wire-level federation
 * errors (no_grant, timeout_waiting_for_consent, …) arrive as a resolved `{ kind: "error" }`,
 * NOT a thrown JS error.
 */
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { verifyAuditChain } from "../../../src/db/audit-verify.ts";
import { federationConsent } from "../../../src/federation/consent-broker.ts";
import { InMemoryDiscoveryProvider } from "../../../src/federation/discovery.ts";
import { buildFederationRuntime } from "../../../src/federation/federation-runtime.ts";
import { buildFederationLanServer } from "../../../src/federation/federation-server.ts";
import { PeerPairing } from "../../../src/federation/peer-pairing.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import type { FederationRpcContext } from "../../../src/ipc/federation-rpc.ts";
import { dispatchFederationRpc } from "../../../src/ipc/federation-rpc.ts";
import { sendFederatedOverWire } from "../../../src/ipc/lan-client.ts";
import { generateBoxKeypair } from "../../../src/ipc/lan-crypto.ts";
import { generatePairingCode } from "../../../src/ipc/lan-pairing.ts";

/** Same formula as federation-server.ts / peer-pairing.ts: first 8 bytes of the box pubkey, hex. */
const peerIdFor = (pub: Uint8Array): string => `peer:${bytesToHex(pub.subarray(0, 8))}`;

/** The leak-proof FederatedItem key set — the ONLY keys a shared item may carry. */
const FEDERATED_ITEM_KEYS = ["id", "modifiedAt", "service", "snippet", "title", "type"];

afterEach(() => {
  // Reset the broker broadcast so one step's auto-response never leaks into the next.
  federationConsent.setBroadcast(() => {});
});

type WireQueryResult =
  | { kind: "ok"; response: { items: Array<Record<string, unknown>> } }
  | { kind: "error"; error: string };

test("payoff: two gateways over a real NaCl-box socket — discover → pair → publish → grant → leak-proof query → undeclared-empty → revoke → audit → expertise → consent-timeout → impersonation", async () => {
  // ---------------------------------------------------------------------------
  // SETUP — Answerer B (real LanServer on a loopback port) + Asker A (real runtime).
  // ---------------------------------------------------------------------------
  const bDb = new Database(":memory:");
  runIndexedSchemaMigrations(bDb, 33);
  const bIndex = new LocalIndex(bDb);
  const bIdentity = generateBoxKeypair();

  // Seed B with three items. The gmail email carries a metadata secret to prove it NEVER leaks.
  bDb.run(
    `INSERT INTO item (id,service,type,external_id,title,body_preview,modified_at,synced_at,metadata)
     VALUES ('github:pr1','github','pull_request','pr1','Fix auth bug','Patches the auth flow',10,1,'{}')`,
  );
  bDb.run(
    `INSERT INTO item (id,service,type,external_id,title,body_preview,modified_at,synced_at,metadata)
     VALUES ('github:pr2','github','pull_request','pr2','Add cache','Adds an LRU cache',20,1,'{}')`,
  );
  bDb.run(
    `INSERT INTO item (id,service,type,external_id,title,body_preview,modified_at,synced_at,metadata)
     VALUES ('gmail:e1','gmail','email','e1','Salaries','TOP SECRET payroll',30,1,'{"secret":"x"}')`,
  );

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
  });
  await bBuilt.lanServer.start();
  const bPort = bBuilt.lanServer.listenAddr()?.port as number;
  expect(typeof bPort).toBe("number");

  // Asker A: real runtime gives `pairing` with the production outbound handshake closed over A's id.
  const aDb = new Database(":memory:");
  runIndexedSchemaMigrations(aDb, 33);
  const aIndex = new LocalIndex(aDb);
  const askerKp = generateBoxKeypair();
  const aRuntime = buildFederationRuntime(
    {
      enabled: true,
      consentTimeoutSeconds: 30,
      mdnsEnabled: false,
      mdnsBind: "127.0.0.1",
    },
    aIndex,
    askerKp,
  );
  if (aRuntime === undefined) throw new Error("federation runtime should be enabled");

  // B-side management context (publish/grant/revoke are local-only).
  const bCtx: FederationRpcContext = {
    db: bDb,
    consentTimeoutMs: 100,
    notify: () => {},
    discovery: new InMemoryDiscoveryProvider(),
    pairing: new PeerPairing(bIndex),
  };

  const askerPeerId = peerIdFor(askerKp.publicKey);
  const NS = "project:zurich-wire";

  try {
    // -------------------------------------------------------------------------
    // 1. discover (criterion 9): A's discovery surfaces B as a peer.
    // -------------------------------------------------------------------------
    const aDiscCtx: FederationRpcContext = {
      db: aDb,
      consentTimeoutMs: 100,
      notify: () => {},
      discovery: new InMemoryDiscoveryProvider([
        { instanceName: "gw-b", host: "127.0.0.1", port: bPort },
      ]),
      pairing: aRuntime.pairing,
    };
    const disc = await dispatchFederationRpc("federation.discover", {}, aDiscCtx);
    expect(disc.kind).toBe("hit");
    if (disc.kind === "hit") {
      expect((disc.value as { peers: unknown[] }).peers.length).toBe(1);
    }

    // -------------------------------------------------------------------------
    // 2. pair (REAL handshake): A initiates, B accepts inside its pairing window.
    //    Proves mutual registration over the wire.
    // -------------------------------------------------------------------------
    const code = generatePairingCode();
    bBuilt.pairingWindow.open(code);
    const bPeerId = await aRuntime.pairing.initiatePair("127.0.0.1", bPort, code);
    expect(bPeerId).toBe(peerIdFor(bIdentity.publicKey));

    // A knows B (outbound, with host/port from the handshake args).
    const aKnowsB = aIndex.getLanPeerByPubkey(bIdentity.publicKey);
    expect(aKnowsB).toBeDefined();
    expect(aKnowsB?.direction).toBe("outbound");
    expect(aKnowsB?.host_port).toBe(bPort);

    // B registered A during the handshake (inbound) — so B can authenticate A's session later.
    const bKnowsA = bIndex.getLanPeerByPubkey(askerKp.publicKey);
    expect(bKnowsA).toBeDefined();
    expect(bKnowsA?.direction).toBe("inbound");

    // -------------------------------------------------------------------------
    // 3. publish + grant (criterion 2): B publishes a filtered namespace and grants A
    //    a NON-standing viewer grant (→ consent prompt path).
    // -------------------------------------------------------------------------
    const pub = await dispatchFederationRpc(
      "federation.namespace.publish",
      {
        name: NS,
        filters: [
          { kind: "type", value: "pull_request" },
          { kind: "service", value: "github" },
        ],
      },
      bCtx,
    );
    expect(pub.kind).toBe("hit");
    const grant = await dispatchFederationRpc(
      "federation.namespace.grant",
      { namespace: NS, peerId: askerPeerId, role: "viewer", standingConsent: false },
      bCtx,
    );
    expect(grant.kind).toBe("hit");

    // -------------------------------------------------------------------------
    // 4. consented query (criteria 2 + 5, LEAK-PROOF): B's owner approves; A receives ONLY
    //    the two github pull_requests, with ONLY the FederatedItem keys. The gmail email and
    //    every metadata/secret field stay on B.
    // -------------------------------------------------------------------------
    federationConsent.setBroadcast((_m, params) => {
      const rid = (params as { requestId: string }).requestId;
      queueMicrotask(() => federationConsent.respond(rid, true));
    });
    const res = (await sendFederatedOverWire(
      "127.0.0.1",
      bPort,
      askerKp,
      bIdentity.publicKey,
      "federation.query",
      { namespace: NS, purpose: "review" },
    )) as WireQueryResult;
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(res)}`);
    expect(res.response.items.length).toBe(2);
    expect(res.response.items.map((i) => i["id"]).sort()).toEqual(["github:pr1", "github:pr2"]);
    for (const item of res.response.items) {
      expect(Object.keys(item).sort()).toEqual(FEDERATED_ITEM_KEYS);
      expect(item["service"]).toBe("github");
    }
    // Hard leak guard: no secret/metadata/raw/external_id/author_id anywhere in the serialized answer.
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("metadata");
    expect(serialized).not.toContain("external_id");
    expect(serialized).not.toContain("author_id");
    expect(serialized).not.toContain("gmail");

    // -------------------------------------------------------------------------
    // 5. undeclared-type query (criterion 5): asking for `email` (undeclared) returns EMPTY,
    //    never revealing the gmail item exists. Consent broadcast stays approving → a real
    //    consented-but-empty answer (not a denied/timeout error).
    // -------------------------------------------------------------------------
    const undeclared = (await sendFederatedOverWire(
      "127.0.0.1",
      bPort,
      askerKp,
      bIdentity.publicKey,
      "federation.query",
      { namespace: NS, purpose: "snoop", types: ["email"] },
    )) as WireQueryResult;
    expect(undeclared.kind).toBe("ok");
    if (undeclared.kind !== "ok") throw new Error("expected ok");
    expect(undeclared.response.items.length).toBe(0);
    expect(JSON.stringify(undeclared)).not.toContain("gmail");

    // -------------------------------------------------------------------------
    // 6. revoke (criterion 4): revocation is immediate AND invalidates cached session consent.
    // -------------------------------------------------------------------------
    const rev = await dispatchFederationRpc(
      "federation.namespace.revoke",
      { namespace: NS, peerId: askerPeerId },
      bCtx,
    );
    expect(rev.kind).toBe("hit");
    const afterRevoke = (await sendFederatedOverWire(
      "127.0.0.1",
      bPort,
      askerKp,
      bIdentity.publicKey,
      "federation.query",
      { namespace: NS, purpose: "review" },
    )) as WireQueryResult;
    expect(afterRevoke.kind).toBe("error");
    if (afterRevoke.kind !== "error") throw new Error("expected error");
    expect(afterRevoke.error).toBe("no_grant");

    // -------------------------------------------------------------------------
    // 7. audit.verify (criterion 3): B's Blake3 audit chain still verifies, and federation
    //    events were recorded.
    // -------------------------------------------------------------------------
    const v = verifyAuditChain(new LocalIndex(bDb), { fromId: 0 });
    expect(v.ok).toBe(true);
    const fedRows = bDb
      .query(`SELECT COUNT(*) AS n FROM audit_log WHERE federation_json IS NOT NULL`)
      .get() as { n: number };
    expect(fedRows.n).toBeGreaterThanOrEqual(1);

    // -------------------------------------------------------------------------
    // 8. expertise (criterion 6): content-free rank only — ZERO item content over the wire.
    // -------------------------------------------------------------------------
    const exp = await sendFederatedOverWire(
      "127.0.0.1",
      bPort,
      askerKp,
      bIdentity.publicKey,
      "federation.expertise",
      { query: "auth", purpose: "who-knows" },
    );
    expect(Object.keys(exp as object)).toEqual(["rank"]);
    const expSerialized = JSON.stringify(exp);
    expect(expSerialized).not.toContain("pr1");
    expect(expSerialized).not.toContain("items");
    expect(expSerialized).not.toContain("title");
    expect(expSerialized).not.toContain("snippet");

    // -------------------------------------------------------------------------
    // 9. consent-timeout (criterion 10): a fresh NON-standing grant with NO owner response
    //    times out via B's 100ms consentTimeoutMs. (Re-grant after the revoke; the broker is
    //    silent.) Adds ~100ms wall-clock.
    // -------------------------------------------------------------------------
    await dispatchFederationRpc(
      "federation.namespace.grant",
      { namespace: NS, peerId: askerPeerId, role: "viewer", standingConsent: false },
      bCtx,
    );
    federationConsent.setBroadcast(() => {}); // no owner ever answers
    const timedOut = (await sendFederatedOverWire(
      "127.0.0.1",
      bPort,
      askerKp,
      bIdentity.publicKey,
      "federation.query",
      { namespace: NS, purpose: "review" },
    )) as WireQueryResult;
    expect(timedOut.kind).toBe("error");
    if (timedOut.kind !== "error") throw new Error("expected error");
    expect(timedOut.error).toBe("timeout_waiting_for_consent");

    // -------------------------------------------------------------------------
    // 10. impersonation (R1 / I17): a STANDING grant to A. A spoofs a body peerId of
    //     "peer:imposter" (which holds NO grant). B answers using A's NaCl-AUTHENTICATED
    //     session id (which holds the standing grant), NOT the body — so the answer is `ok`.
    //     A body-supplied peerId cannot impersonate.
    // -------------------------------------------------------------------------
    await dispatchFederationRpc(
      "federation.namespace.grant",
      { namespace: NS, peerId: askerPeerId, role: "viewer", standingConsent: true },
      bCtx,
    );
    const spoofed = (await sendFederatedOverWire(
      "127.0.0.1",
      bPort,
      askerKp,
      bIdentity.publicKey,
      "federation.query",
      { namespace: NS, purpose: "review", peerId: "peer:imposter" },
    )) as WireQueryResult;
    expect(spoofed.kind).toBe("ok");
    if (spoofed.kind !== "ok") throw new Error("expected ok — body peerId must be ignored");
    expect(spoofed.response.items.length).toBe(2);
  } finally {
    await bBuilt.lanServer.stop();
    bIndex.close();
    aIndex.close();
    bDb.close();
    aDb.close();
  }
});
