import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import { bytesToHex } from "@noble/hashes/utils.js";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { federationConsent } from "../federation/consent-broker.ts";
import { InMemoryDiscoveryProvider } from "../federation/discovery.ts";
import { buildFederationLanServer } from "../federation/federation-server.ts";
import { PeerPairing } from "../federation/peer-pairing.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { type DeletionRecord, verifyDeletionRecord } from "../policy/deletion-record.ts";
import { signPolicy } from "../policy/policy-signing.ts";
import { PolicyStore } from "../policy/policy-store.ts";
import type { FederationRpcContext } from "./federation-rpc.ts";
import { dispatchFederationRpc } from "./federation-rpc.ts";
import { generateBoxKeypair } from "./lan-crypto.ts";

let db: Database;
let index: LocalIndex;
let notes: Array<{ method: string; params: unknown }>;
function ctx(): FederationRpcContext {
  return {
    db,
    consentTimeoutMs: 1000,
    notify: (method, params) => notes.push({ method, params }),
    discovery: new InMemoryDiscoveryProvider([
      { instanceName: "bob", host: "gateway-b.test", port: 7475 },
    ]),
    pairing: new PeerPairing(index),
  };
}
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  index = new LocalIndex(db);
  notes = [];
});
afterEach(() => {
  db.close();
  federationConsent.setBroadcast(() => {});
});

test("federation.discover lists provider peers; federation.peers lists paired peers", async () => {
  const disc = await dispatchFederationRpc("federation.discover", {}, ctx());
  expect(disc.kind).toBe("hit");
  if (disc.kind === "hit") {
    expect((disc.value as { peers: unknown[] }).peers.length).toBe(1);
  }
  const peers = await dispatchFederationRpc("federation.peers", {}, ctx());
  expect(peers.kind).toBe("hit");
});

test("namespace.publish then unknown method miss", async () => {
  const pub = await dispatchFederationRpc(
    "federation.namespace.publish",
    { name: "project:zurich", filters: [{ kind: "type", value: "pull_request" }] },
    ctx(),
  );
  expect(pub.kind).toBe("hit");
  const miss = await dispatchFederationRpc("federation.unknown", {}, ctx());
  expect(miss.kind).toBe("miss");
});

test("federation.query with no grant returns the no_grant error shape (wrapped in a hit)", async () => {
  await dispatchFederationRpc(
    "federation.namespace.publish",
    { name: "ns", filters: [{ kind: "type", value: "pull_request" }] },
    ctx(),
  );
  const res = await dispatchFederationRpc(
    "federation.query",
    { peerId: "stranger", namespace: "ns", purpose: "x" },
    ctx(),
  );
  expect(res.kind).toBe("hit");
  if (res.kind === "hit") {
    const v = res.value as { kind: string; error?: string };
    expect(v.kind).toBe("error");
    expect(v.error).toBe("no_grant");
  }
});

test("federation.expertise returns a content-free rank", async () => {
  const res = await dispatchFederationRpc(
    "federation.expertise",
    { query: "auth bug", purpose: "who-knows" },
    ctx(),
  );
  expect(res.kind).toBe("hit");
  if (res.kind === "hit") {
    expect(Object.keys(res.value as object)).toEqual(["rank"]);
  }
});

test("namespace.grant then revoke invalidates and returns ok", async () => {
  await dispatchFederationRpc(
    "federation.namespace.publish",
    { name: "ns", filters: [{ kind: "type", value: "pull_request" }] },
    ctx(),
  );
  const g = await dispatchFederationRpc(
    "federation.namespace.grant",
    { namespace: "ns", peerId: "peerA", role: "viewer", standingConsent: true },
    ctx(),
  );
  expect(g.kind).toBe("hit");
  const r = await dispatchFederationRpc(
    "federation.namespace.revoke",
    { namespace: "ns", peerId: "peerA" },
    ctx(),
  );
  expect(r.kind).toBe("hit");
});

test("missing required param throws a FederationRpcError (invalid params)", async () => {
  await expect(
    dispatchFederationRpc("federation.namespace.publish", { filters: [] }, ctx()),
  ).rejects.toThrow();
});

test("federation.pair throws 'not wired' when no outbound handshake is configured", async () => {
  await expect(
    dispatchFederationRpc(
      "federation.pair",
      { host: "gateway-b.test", port: 7475, code: "abc" },
      ctx(),
    ),
  ).rejects.toThrow(/not wired/);
});

test("federation.query with a non-standing grant and no broker response times out", async () => {
  // Broker broadcast is a no-op (reset by afterEach); query-gate's own timeout (1000ms) fires first,
  // producing timeout_waiting_for_consent. Broker TTL is consentTimeoutMs+5000 = 6000ms — longer —
  // so the gate's timer wins.
  const c = ctx();
  await dispatchFederationRpc(
    "federation.namespace.publish",
    { name: "ns-consent", filters: [{ kind: "type", value: "pull_request" }] },
    c,
  );
  await dispatchFederationRpc(
    "federation.namespace.grant",
    { namespace: "ns-consent", peerId: "peer-consent-1", role: "viewer", standingConsent: false },
    c,
  );
  const res = await dispatchFederationRpc(
    "federation.query",
    { peerId: "peer-consent-1", namespace: "ns-consent", purpose: "review" },
    c,
  );
  expect(res.kind).toBe("hit");
  if (res.kind === "hit") {
    const v = res.value as { kind: string; error?: string };
    expect(v.kind).toBe("error");
    expect(v.error).toBe("timeout_waiting_for_consent");
  }
});

test("requireString rejects an empty string", async () => {
  await expect(
    dispatchFederationRpc(
      "federation.namespace.publish",
      { name: "", filters: [{ kind: "type", value: "pull_request" }] },
      ctx(),
    ),
  ).rejects.toThrow(/non-empty string/);
});

test("parseFilters rejects a bad filter kind", async () => {
  await expect(
    dispatchFederationRpc(
      "federation.namespace.publish",
      { name: "ns-badkind", filters: [{ kind: "nope", value: "x" }] },
      ctx(),
    ),
  ).rejects.toThrow();
});

test("namespace.grant rejects an unknown role", async () => {
  await dispatchFederationRpc(
    "federation.namespace.publish",
    { name: "ns-role", filters: [{ kind: "type", value: "pull_request" }] },
    ctx(),
  );
  await expect(
    dispatchFederationRpc(
      "federation.namespace.grant",
      { namespace: "ns-role", peerId: "peer-role-1", role: "superadmin", standingConsent: false },
      ctx(),
    ),
  ).rejects.toThrow();
});

test("federation.consentRespond resolves and reports matched=false for an unknown id", async () => {
  const c = ctx();
  const out = await dispatchFederationRpc(
    "federation.consentRespond",
    { requestId: "x", approved: true },
    c,
  );
  expect(out.kind).toBe("hit");
  expect((out as { kind: "hit"; value: { ok: boolean; matched: boolean } }).value.matched).toBe(
    false,
  );
});

test("federation.query blocks then unblocks on consent approve via the broker", async () => {
  // Wire the broker so it auto-approves the first consent request via queueMicrotask.
  federationConsent.setBroadcast((_m, params) => {
    const rid = (params as { requestId: string }).requestId;
    queueMicrotask(() => federationConsent.respond(rid, true));
  });
  const c = ctx(); // consentTimeoutMs: 1000
  await dispatchFederationRpc(
    "federation.namespace.publish",
    { name: "ns-c7", filters: [{ kind: "type", value: "pull_request" }] },
    c,
  );
  await dispatchFederationRpc(
    "federation.namespace.grant",
    { namespace: "ns-c7", peerId: "peer:z", role: "viewer", standingConsent: false },
    c,
  );
  const out = await dispatchFederationRpc(
    "federation.query",
    { peerId: "peer:z", namespace: "ns-c7", purpose: "p" },
    c,
  );
  // Approved → answered (possibly empty items, but a hit not a wire error)
  expect(out.kind).toBe("hit");
  if (out.kind === "hit") {
    const v = out.value as { kind: string };
    expect(v.kind).toBe("ok");
  }
});

test("federation.ask throws ASKER_UNAVAILABLE when index/identity not wired", async () => {
  await expect(
    dispatchFederationRpc("federation.ask", { peerId: "x", namespace: "ns", purpose: "p" }, ctx()),
  ).rejects.toThrow(/ERR_FEDERATION_ASKER_UNAVAILABLE/);
});

test("federation.askExpertise throws ASKER_UNAVAILABLE when index/identity not wired", async () => {
  await expect(
    dispatchFederationRpc(
      "federation.askExpertise",
      { peerId: "x", query: "q", purpose: "p" },
      ctx(),
    ),
  ).rejects.toThrow(/ERR_FEDERATION_ASKER_UNAVAILABLE/);
});

test("federation.ask throws UNKNOWN_PEER for a peer with no host/port", async () => {
  const peerDb = new Database(":memory:");
  runIndexedSchemaMigrations(peerDb, 33);
  const peerIndex = new LocalIndex(peerDb);
  const selfKp = generateBoxKeypair();
  // inbound-only peer: hostIp present but hostPort omitted → host_port = null → guard fires
  peerIndex.addLanPeer({
    peerId: "peer:nohost",
    peerPubkey: new Uint8Array(32).fill(9),
    direction: "inbound",
    hostIp: "127.0.0.1",
  });
  const askCtx: FederationRpcContext = {
    db: peerDb,
    consentTimeoutMs: 1000,
    notify: () => {},
    discovery: new InMemoryDiscoveryProvider(),
    pairing: new PeerPairing(peerIndex),
    index: peerIndex,
    selfIdentity: selfKp,
  };
  try {
    await expect(
      dispatchFederationRpc(
        "federation.ask",
        { peerId: "peer:nohost", namespace: "ns", purpose: "p" },
        askCtx,
      ),
    ).rejects.toThrow(/ERR_UNKNOWN_PEER/);
  } finally {
    peerIndex.close();
  }
});

test("federation.ask sends the query over the wire to a paired peer and returns its answer", async () => {
  const peerIdFor = (pub: Uint8Array) => `peer:${bytesToHex(pub.subarray(0, 8))}`;

  // Build a local FederationRpcContext for a given (db, index), optionally asker-wired.
  const makeCtx = (
    ctxDb: Database,
    ctxIndex: LocalIndex,
    asker?: { index: LocalIndex; selfIdentity: ReturnType<typeof generateBoxKeypair> },
  ): FederationRpcContext => ({
    db: ctxDb,
    consentTimeoutMs: 1000,
    notify: () => {},
    discovery: new InMemoryDiscoveryProvider(),
    pairing: new PeerPairing(ctxIndex),
    ...(asker === undefined ? {} : { index: asker.index, selfIdentity: asker.selfIdentity }),
  });

  // --- Responder B ---
  const bDb = new Database(":memory:");
  runIndexedSchemaMigrations(bDb, 33);
  const bIndex = new LocalIndex(bDb);
  bDb.run(`INSERT INTO item (id,service,type,external_id,title,body_preview,modified_at,synced_at,metadata)
           VALUES ('github:pr1','github','pull_request','pr1','Fix auth','body1',10,1,'{}')`);
  const bIdentity = generateBoxKeypair();
  const askerKp = generateBoxKeypair();
  // B knows the asker as an inbound peer (so the hello handshake authenticates A):
  bIndex.addLanPeer({
    peerId: peerIdFor(askerKp.publicKey),
    peerPubkey: askerKp.publicKey,
    direction: "inbound",
    hostIp: "127.0.0.1",
  });
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
    consentTimeoutMs: 1000,
    notify: () => {},
  });
  await bBuilt.lanServer.start();
  const bPort = bBuilt.lanServer.listenAddr()?.port as number;

  // On B: publish a namespace and grant the AUTHENTICATED asker peerId a STANDING viewer grant.
  const bCtx = makeCtx(bDb, bIndex);
  await dispatchFederationRpc(
    "federation.namespace.publish",
    { name: "ns-ask", filters: [{ kind: "type", value: "pull_request" }] },
    bCtx,
  );
  await dispatchFederationRpc(
    "federation.namespace.grant",
    {
      namespace: "ns-ask",
      peerId: peerIdFor(askerKp.publicKey),
      role: "viewer",
      standingConsent: true,
    },
    bCtx,
  );

  // --- Asker A ---
  const aDb = new Database(":memory:");
  runIndexedSchemaMigrations(aDb, 33);
  const aIndex = new LocalIndex(aDb);
  // A knows B as an outbound peer (host/port/pubkey):
  aIndex.addLanPeer({
    peerId: peerIdFor(bIdentity.publicKey),
    peerPubkey: bIdentity.publicKey,
    direction: "outbound",
    hostIp: "127.0.0.1",
    hostPort: bPort,
  });
  const aCtx = makeCtx(aDb, aIndex, { index: aIndex, selfIdentity: askerKp });

  try {
    const res = await dispatchFederationRpc(
      "federation.ask",
      { peerId: peerIdFor(bIdentity.publicKey), namespace: "ns-ask", purpose: "review" },
      aCtx,
    );
    expect(res.kind).toBe("hit");
    const answer = (res as { value: { kind: string; response?: { items: unknown[] } } }).value;
    expect(answer.kind).toBe("ok");
    expect((answer.response?.items.length ?? 0) >= 1).toBe(true);
  } finally {
    await bBuilt.lanServer.stop();
    bIndex.close();
    aIndex.close();
  }
});

test("federation.policy returns the persisted bundle and null when none is stored", async () => {
  const policyDb = new Database(":memory:");
  runIndexedSchemaMigrations(policyDb, 36);
  const policyIndex = new LocalIndex(policyDb);
  const policyCtx: FederationRpcContext = {
    db: policyDb,
    consentTimeoutMs: 1000,
    notify: () => {},
    discovery: new InMemoryDiscoveryProvider(),
    pairing: new PeerPairing(policyIndex),
  };

  // No policy persisted yet → null.
  const emptyRes = await dispatchFederationRpc("federation.policy", {}, policyCtx);
  expect(emptyRes.kind).toBe("hit");
  expect((emptyRes as { kind: "hit"; value: unknown }).value).toBeNull();

  // Persist a signed bundle via PolicyStore.
  const kp = generateEd25519Keypair();
  const toml = `[policy]\nversion=1\norg="acme"\n[policy.connectors]\nallow=["github"]\n`;
  const sig = signPolicy(toml, encodeBase64(kp.privkey));
  const store = new PolicyStore(policyDb);
  store.persist({ toml, sig, org: "acme", version: 1, fetchedAt: 1, source: "peer" });

  // Now federation.policy should return {toml, sig}.
  const bundleRes = await dispatchFederationRpc("federation.policy", {}, policyCtx);
  expect(bundleRes.kind).toBe("hit");
  const bundle = (bundleRes as { kind: "hit"; value: { toml: string; sig: string } }).value;
  expect(bundle.toml).toBe(toml);
  expect(bundle.sig).toBe(sig);

  policyIndex.close();
});

// ---------------------------------------------------------------------------
// federation.purge — HITL gate (Slice 4, spec D11). HITL is STRUCTURAL: the
// consent broker must approve BEFORE any deletion, and a signer must be present
// BEFORE any deletion (fail-closed — no delete without a signed receipt).
// ---------------------------------------------------------------------------

/** A ctx wired with a delete-spy and (optionally) a purge signer. */
function purgeCtx(
  deleteSpy: (externalId: string, peerId: string) => number,
  signer?: { privkeyB64: string; selfPeerId: string },
): FederationRpcContext {
  return {
    db,
    consentTimeoutMs: 1000,
    notify: (method, params) => notes.push({ method, params }),
    discovery: new InMemoryDiscoveryProvider(),
    pairing: new PeerPairing(index),
    deletePurgeContributions: deleteSpy,
    ...(signer === undefined ? {} : { purgeSign: signer }),
  };
}

test("federation.purge DENY: consent denied → purge_denied and NEVER deletes (HITL fires first)", async () => {
  // Broker denies the consent request as soon as it is broadcast.
  federationConsent.setBroadcast((_m, params) => {
    const rid = (params as { requestId: string }).requestId;
    queueMicrotask(() => federationConsent.respond(rid, false));
  });
  let deleteCalls = 0;
  const spy = () => {
    deleteCalls++;
    return 5;
  };
  const kp = generateEd25519Keypair();
  const res = await dispatchFederationRpc(
    "federation.purge",
    { peerId: "peer:home", externalId: "user-42" },
    purgeCtx(spy, { privkeyB64: encodeBase64(kp.privkey), selfPeerId: "peer:self" }),
  );
  expect(res.kind).toBe("hit");
  if (res.kind === "hit") {
    expect((res.value as { kind: string; error?: string }).error).toBe("purge_denied");
  }
  // The HITL gate fired BEFORE deletion: the delete accessor was never called.
  expect(deleteCalls).toBe(0);
});

test("federation.purge APPROVE: deletes, returns a verifiable signed record with selfPeerId", async () => {
  federationConsent.setBroadcast((_m, params) => {
    const rid = (params as { requestId: string }).requestId;
    queueMicrotask(() => federationConsent.respond(rid, true));
  });
  let deleteCalls = 0;
  const spy = (externalId: string, peerId: string) => {
    expect(externalId).toBe("user-42");
    expect(peerId).toBe("peer:home"); // the delete is keyed by the REQUESTING peer
    deleteCalls++;
    return 2;
  };
  const kp = generateEd25519Keypair();
  const selfPeerId = "peer:answerer";
  const res = await dispatchFederationRpc(
    "federation.purge",
    { peerId: "peer:home", externalId: "user-42" },
    purgeCtx(spy, { privkeyB64: encodeBase64(kp.privkey), selfPeerId }),
  );
  expect(res.kind).toBe("hit");
  if (res.kind === "hit") {
    const v = res.value as { kind: string; record: DeletionRecord; sig: string };
    expect(v.kind).toBe("ok");
    expect(v.record.deletedCount).toBe(2);
    // The record attests WHO deleted: this answering gateway's selfPeerId, not the requester's.
    expect(v.record.peerId).toBe(selfPeerId);
    expect(v.record.externalId).toBe("user-42");
    expect(verifyDeletionRecord(v.record, v.sig, encodeBase64(kp.pubkey))).toBe(true);
  }
  // Deletion happened only AFTER approval.
  expect(deleteCalls).toBe(1);
});

test("federation.purge APPROVE but NO signer → purge_signer_unavailable and NEVER deletes (fail-closed)", async () => {
  federationConsent.setBroadcast((_m, params) => {
    const rid = (params as { requestId: string }).requestId;
    queueMicrotask(() => federationConsent.respond(rid, true));
  });
  let deleteCalls = 0;
  const spy = () => {
    deleteCalls++;
    return 7;
  };
  // No `purgeSign` wired → the signer guard must fail closed BEFORE any deletion.
  const res = await dispatchFederationRpc(
    "federation.purge",
    { peerId: "peer:home", externalId: "user-42" },
    purgeCtx(spy),
  );
  expect(res.kind).toBe("hit");
  if (res.kind === "hit") {
    expect((res.value as { kind: string; error?: string }).error).toBe("purge_signer_unavailable");
  }
  // No signer ⇒ no signed receipt possible ⇒ nothing was deleted.
  expect(deleteCalls).toBe(0);
});

// ---------------------------------------------------------------------------
// team.auditMerged — the asker-side team-wide merged federation-audit timeline.
// Always includes THIS gateway's local federation-audit slice (tagged "local");
// fans out to paired peers only when asker-side transport (index + identity) is
// wired; an unreachable / malformed peer is SKIPPED (best-effort), never fatal.
// ---------------------------------------------------------------------------

/** Seed a federation.% audit row so exportFederationAudit returns at least one entry. */
function seedFederationAudit(at: number): void {
  appendAuditEntry(db, {
    actionType: "federation.query",
    hitlStatus: "approved",
    actionJson: JSON.stringify({ method: "federation.query" }),
    timestamp: at,
    federationJson: JSON.stringify({ peer_id: "peer:x", decision: "answered" }),
  });
}

test("team.auditMerged with NO peers returns the merged LOCAL stream", async () => {
  seedFederationAudit(100);
  seedFederationAudit(200);
  // ctx() has no index/selfIdentity wired → the fan-out loop is skipped entirely.
  const res = await dispatchFederationRpc("team.auditMerged", { namespace: "ns" }, ctx());
  expect(res.kind).toBe("hit");
  if (res.kind === "hit") {
    const v = res.value as { entries: Array<{ peerId: string; timestamp: number }> };
    expect(v.entries.length).toBe(2);
    // All entries are tagged "local" and sorted ascending by timestamp.
    expect(v.entries.every((e) => e.peerId === "local")).toBe(true);
    expect(v.entries[0]?.timestamp).toBe(100);
    expect(v.entries[1]?.timestamp).toBe(200);
  }
});

test("team.auditMerged sinceMs filters the local slice", async () => {
  seedFederationAudit(50);
  seedFederationAudit(500);
  const res = await dispatchFederationRpc(
    "team.auditMerged",
    { namespace: "ns", sinceMs: 100 },
    ctx(),
  );
  expect(res.kind).toBe("hit");
  if (res.kind === "hit") {
    const v = res.value as { entries: Array<{ timestamp: number }> };
    expect(v.entries.length).toBe(1);
    expect(v.entries[0]?.timestamp).toBe(500);
  }
});

test("team.auditMerged SKIPS a host-less peer and an unreachable peer (best-effort), keeps local", async () => {
  seedFederationAudit(300);
  // Asker-wired ctx (index + selfIdentity) so the fan-out loop runs.
  const selfKp = generateBoxKeypair();
  // Peer 1: no host address → the `continue` branch (host_ip null) skips it.
  index.addLanPeer({
    peerId: "peer:nohost",
    peerPubkey: new Uint8Array(32).fill(1),
    direction: "inbound",
    hostIp: "127.0.0.1", // hostPort omitted → host_port = null → continue
  });
  // Peer 2: a host address that nothing is listening on → sendFederatedOverWire throws → catch skips.
  index.addLanPeer({
    peerId: "peer:dead",
    peerPubkey: new Uint8Array(32).fill(2),
    direction: "outbound",
    hostIp: "127.0.0.1",
    hostPort: 1, // port 1 → connection refused
  });
  const askCtx: FederationRpcContext = {
    ...ctx(),
    index,
    selfIdentity: selfKp,
  };
  const res = await dispatchFederationRpc("team.auditMerged", { namespace: "ns" }, askCtx);
  expect(res.kind).toBe("hit");
  if (res.kind === "hit") {
    const v = res.value as { entries: Array<{ peerId: string }> };
    // Only the local slice survives — both peers were skipped, never fatal.
    expect(v.entries.length).toBe(1);
    expect(v.entries[0]?.peerId).toBe("local");
  }
});

test("team.auditMerged merges a reachable peer's slice OVER THE WIRE (extractAuditEntries happy path)", async () => {
  const peerIdFor = (pub: Uint8Array) => `peer:${bytesToHex(pub.subarray(0, 8))}`;
  const makeCtx = (
    ctxDb: Database,
    ctxIndex: LocalIndex,
    asker?: { index: LocalIndex; selfIdentity: ReturnType<typeof generateBoxKeypair> },
  ): FederationRpcContext => ({
    db: ctxDb,
    consentTimeoutMs: 1000,
    notify: () => {},
    discovery: new InMemoryDiscoveryProvider(),
    pairing: new PeerPairing(ctxIndex),
    ...(asker === undefined ? {} : { index: asker.index, selfIdentity: asker.selfIdentity }),
  });

  // --- Responder B: has a federation-audit slice + grants the asker on a published namespace ---
  const bDb = new Database(":memory:");
  runIndexedSchemaMigrations(bDb, 33);
  const bIndex = new LocalIndex(bDb);
  appendAuditEntry(bDb, {
    actionType: "federation.query",
    hitlStatus: "approved",
    actionJson: JSON.stringify({ method: "federation.query" }),
    timestamp: 999,
    federationJson: JSON.stringify({ peer_id: "peer:b", decision: "answered" }),
  });
  const bIdentity = generateBoxKeypair();
  const askerKp = generateBoxKeypair();
  bIndex.addLanPeer({
    peerId: peerIdFor(askerKp.publicKey),
    peerPubkey: askerKp.publicKey,
    direction: "inbound",
    hostIp: "127.0.0.1",
  });
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
    consentTimeoutMs: 1000,
    notify: () => {},
  });
  await bBuilt.lanServer.start();
  const bPort = bBuilt.lanServer.listenAddr()?.port as number;
  const bCtx = makeCtx(bDb, bIndex);
  await dispatchFederationRpc(
    "federation.namespace.publish",
    { name: "ns-audit", filters: [{ kind: "type", value: "pull_request" }] },
    bCtx,
  );
  await dispatchFederationRpc(
    "federation.namespace.grant",
    {
      namespace: "ns-audit",
      peerId: peerIdFor(askerKp.publicKey),
      role: "viewer",
      standingConsent: true,
    },
    bCtx,
  );

  // --- Asker A: a local federation-audit slice + B paired as an outbound peer ---
  const aDb = new Database(":memory:");
  runIndexedSchemaMigrations(aDb, 33);
  const aIndex = new LocalIndex(aDb);
  appendAuditEntry(aDb, {
    actionType: "federation.query",
    hitlStatus: "approved",
    actionJson: JSON.stringify({ method: "federation.query" }),
    timestamp: 1,
    federationJson: JSON.stringify({ peer_id: "peer:a", decision: "answered" }),
  });
  aIndex.addLanPeer({
    peerId: peerIdFor(bIdentity.publicKey),
    peerPubkey: bIdentity.publicKey,
    direction: "outbound",
    hostIp: "127.0.0.1",
    hostPort: bPort,
  });
  const aCtx = makeCtx(aDb, aIndex, { index: aIndex, selfIdentity: askerKp });

  try {
    const res = await dispatchFederationRpc(
      "team.auditMerged",
      { namespace: "ns-audit", purpose: "team-audit" },
      aCtx,
    );
    expect(res.kind).toBe("hit");
    if (res.kind === "hit") {
      const v = res.value as { entries: Array<{ peerId: string; timestamp: number }> };
      const bPeerId = peerIdFor(bIdentity.publicKey);
      // The merge includes A's local slice (ts 1, tagged "local") AND B's remote slice fetched over
      // the wire (the seeded ts-999 row, tagged with B's peerId). B may also surface its own freshly
      // written auditExport "answered" row, so assert presence + sort order, not an exact count.
      expect(v.entries.length).toBeGreaterThanOrEqual(2);
      expect(v.entries[0]?.peerId).toBe("local");
      expect(v.entries[0]?.timestamp).toBe(1);
      const remote = v.entries.filter((e) => e.peerId === bPeerId);
      expect(remote.length).toBeGreaterThanOrEqual(1);
      expect(remote.some((e) => e.timestamp === 999)).toBe(true);
      // Sorted ascending by timestamp across the whole merged stream.
      for (let i = 1; i < v.entries.length; i++) {
        expect((v.entries[i]?.timestamp ?? 0) >= (v.entries[i - 1]?.timestamp ?? 0)).toBe(true);
      }
    }
  } finally {
    await bBuilt.lanServer.stop();
    bIndex.close();
    aIndex.close();
  }
});

test("federation.auditExport over the wire is consent-gated (no_grant without a grant)", async () => {
  // Drives the federation.auditExport dispatch arm directly (local path) → no_grant gate.
  await dispatchFederationRpc(
    "federation.namespace.publish",
    { name: "ns-ax", filters: [{ kind: "type", value: "pull_request" }] },
    ctx(),
  );
  const res = await dispatchFederationRpc(
    "federation.auditExport",
    { peerId: "stranger", namespace: "ns-ax", purpose: "audit", sinceMs: 0 },
    ctx(),
  );
  expect(res.kind).toBe("hit");
  if (res.kind === "hit") {
    const v = res.value as { kind: string; error?: string };
    expect(v.kind).toBe("error");
    expect(v.error).toBe("no_grant");
  }
});

test("federation.auditExport returns the metadata-only slice for a standing grant", async () => {
  seedFederationAudit(700);
  const c = ctx();
  await dispatchFederationRpc(
    "federation.namespace.publish",
    { name: "ns-ax2", filters: [{ kind: "type", value: "pull_request" }] },
    c,
  );
  await dispatchFederationRpc(
    "federation.namespace.grant",
    { namespace: "ns-ax2", peerId: "peer:grantee", role: "viewer", standingConsent: true },
    c,
  );
  const res = await dispatchFederationRpc(
    "federation.auditExport",
    { peerId: "peer:grantee", namespace: "ns-ax2", purpose: "audit" },
    c,
  );
  expect(res.kind).toBe("hit");
  if (res.kind === "hit") {
    const v = res.value as { kind: string; entries: Array<{ actionType: string }> };
    expect(v.kind).toBe("ok");
    expect(v.entries.some((e) => e.actionType.startsWith("federation."))).toBe(true);
  }
});
