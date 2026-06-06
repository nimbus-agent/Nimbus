import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { federationConsent } from "../federation/consent-broker.ts";
import { InMemoryDiscoveryProvider } from "../federation/discovery.ts";
import { buildFederationLanServer } from "../federation/federation-server.ts";
import { PeerPairing } from "../federation/peer-pairing.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
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
