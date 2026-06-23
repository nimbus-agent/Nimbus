/**
 * Phase 6 Slice 6b — cloud-janitor recency probe over-the-wire acceptance.
 *
 * Two in-process gateways over a REAL loopback NaCl-box socket: pair → the downstream B has an
 * indexed item mentioning a cloud resource → the janitor upstream A runs fanOutProbe across its
 * paired peers → B answers content-free { touched, lastSeenDaysAgo }. We assert a touched resource
 * reports recency, and that a downstream that has gone offline becomes a GAP (never "idle").
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { buildFederationRuntime } from "../../../src/federation/federation-runtime.ts";
import { buildFederationLanServer } from "../../../src/federation/federation-server.ts";
import { fanOutProbe } from "../../../src/federation/peer-fanout.ts";
import { KnownNamespaceStore } from "../../../src/index/known-namespace-store.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { generateBoxKeypair } from "../../../src/ipc/lan-crypto.ts";
import { generatePairingCode } from "../../../src/ipc/lan-pairing.ts";

test("payoff: janitor probes a downstream over the wire — touched reports recency; offline → gap", async () => {
  const dayMs = 86_400_000;
  // Recency is computed on the ANSWERER (B) with its real clock, so anchor the item to the real
  // now — not an epoch-relative value. Exact day arithmetic is unit-tested in resource-probe.test.ts.
  const base = Date.now();
  // --- Downstream B: real LanServer; its index mentions the resource ~3 days ago. ---
  const bDb = new Database(":memory:");
  runIndexedSchemaMigrations(bDb, 38);
  const bIndex = new LocalIndex(bDb);
  const bIdentity = generateBoxKeypair();
  bDb.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
     VALUES ('x', 'aws', 'note', 'ext-x', 'restart i-deadbeef', null, ?, ?)`,
    [base - 3 * dayMs, base - 3 * dayMs],
  );

  const askerKp = generateBoxKeypair();
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

  // --- Upstream A (janitor): pairs with B, registers B as a reachable peer, fans out the probe. ---
  const aDb = new Database(":memory:");
  runIndexedSchemaMigrations(aDb, 38);
  const aIndex = new LocalIndex(aDb);
  const aRuntime = buildFederationRuntime(
    { enabled: true, consentTimeoutSeconds: 30, mdnsEnabled: false, mdnsBind: "127.0.0.1" },
    aIndex,
    askerKp,
  );
  if (aRuntime === undefined) throw new Error("federation runtime should be enabled");

  try {
    const code = generatePairingCode();
    bBuilt.pairingWindow.open(code);
    await aRuntime.pairing.initiatePair("127.0.0.1", bPort, code);

    aIndex.addLanPeer({
      peerId: "peer:b",
      peerPubkey: bIdentity.publicKey,
      direction: "outbound",
      hostIp: "127.0.0.1",
      hostPort: bPort,
      displayName: "Bob",
    });
    const deps = {
      index: aIndex,
      selfIdentity: askerKp,
      store: new KnownNamespaceStore(aDb),
    };

    // touched: B mentions the resource → content-free recency, ~3 days ago (computed on B's clock).
    const touched = await fanOutProbe(deps, { resourceRef: "i-deadbeef", purpose: "janitor" });
    expect(touched.gaps).toEqual([]);
    expect(touched.perPeer[0]?.touched).toBe(true);
    expect(touched.perPeer[0]?.lastSeenDaysAgo).toBeGreaterThanOrEqual(2);
    expect(touched.perPeer[0]?.lastSeenDaysAgo).toBeLessThanOrEqual(4);

    // untouched resource → answered, not touched.
    const clear = await fanOutProbe(deps, { resourceRef: "i-99999999", purpose: "janitor" });
    expect(clear.perPeer[0]?.touched).toBe(false);

    // offline downstream → GAP (never silently "idle").
    await bBuilt.lanServer.stop();
    const offline = await fanOutProbe(deps, { resourceRef: "i-deadbeef", purpose: "janitor" });
    expect(offline.perPeer).toEqual([]);
    expect(offline.gaps).toHaveLength(1);
  } finally {
    await bBuilt.lanServer.stop();
    bIndex.close();
    aIndex.close();
    bDb.close();
    aDb.close();
  }
});
