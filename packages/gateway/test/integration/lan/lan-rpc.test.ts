import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sendFederatedOverWire } from "../../../src/ipc/lan-client.ts";
import { type BoxKeypair, generateBoxKeypair } from "../../../src/ipc/lan-crypto.ts";
import { outboundPairHandshake } from "../../../src/ipc/lan-pair-client.ts";
import { generatePairingCode, PairingWindow } from "../../../src/ipc/lan-pairing.ts";
import { LanRateLimiter } from "../../../src/ipc/lan-rate-limit.ts";
import { checkLanMethodAllowed } from "../../../src/ipc/lan-rpc.ts";
import { LanServer } from "../../../src/ipc/lan-server.ts";
import { connectV2 } from "../../../src/ipc/testing/lan-v2.test-helpers.ts";

interface TestHost {
  server: LanServer;
  pairing: PairingWindow;
  rateLimit: LanRateLimiter;
  hostKp: BoxKeypair;
  peers: Map<string, { pubkey: Uint8Array; writeAllowed: boolean }>;
}

async function spinUpHost(port: number): Promise<TestHost> {
  const hostKp = generateBoxKeypair();
  const pairing = new PairingWindow(2000);
  const rateLimit = new LanRateLimiter({ maxFailures: 3, windowMs: 2000, lockoutMs: 2000 });
  const peers = new Map<string, { pubkey: Uint8Array; writeAllowed: boolean }>();
  const server = new LanServer({
    bind: "127.0.0.1",
    port,
    hostKeypair: hostKp,
    pairing,
    rateLimit,
    isKnownPeer: (pubkey) => {
      for (const [id, p] of peers) {
        if (Buffer.compare(Buffer.from(p.pubkey), Buffer.from(pubkey)) === 0) {
          return { peerId: id, writeAllowed: p.writeAllowed, protoVersion: 2 };
        }
      }
      return null;
    },
    registerPeer: (pubkey) => {
      const id = createHash("sha256").update(pubkey).digest("base64url").slice(0, 16);
      peers.set(id, { pubkey, writeAllowed: false });
      return id;
    },
    onMessage: async (method, _params, peer) => {
      checkLanMethodAllowed(method, peer);
      return { ok: true, echo: method };
    },
  });
  await server.start();
  return { server, pairing, rateLimit, hostKp, peers };
}

describe("LAN end-to-end pair -> read -> write -> tamper (v2)", () => {
  let host: TestHost;
  beforeEach(async () => {
    host = await spinUpHost(0);
  });
  afterEach(async () => {
    await host.server.stop();
  });

  test("full flow", async () => {
    const listen = host.server.listenAddr();
    if (!listen) throw new Error("no listen addr");
    const clientKp = generateBoxKeypair();

    // 1. Pair: Noise XXpsk0 keyed by the code; the window is consumed once message 3 opened.
    const code = generatePairingCode();
    host.pairing.open(code);
    const hostPub = await outboundPairHandshake("127.0.0.1", listen.port, code, clientKp);
    expect(Buffer.from(hostPub).equals(Buffer.from(host.hostKp.publicKey))).toBe(true);
    expect(host.peers.size).toBe(1);
    expect(host.pairing.isOpen()).toBe(false);

    const call = (method: string) =>
      sendFederatedOverWire("127.0.0.1", listen.port, clientKp, hostPub, method, {}, 5000, {
        known: 2,
      });

    // 2. A read method is served.
    expect(await call("index.search")).toEqual({ ok: true, echo: "index.search" });

    // 3. A write method is refused without the grant, and served with it.
    await expect(call("engine.ask")).rejects.toThrow("ERR_LAN_WRITE_FORBIDDEN");
    const [peerId] = [...host.peers.keys()];
    const peer = peerId === undefined ? undefined : host.peers.get(peerId);
    if (!peer) throw new Error("peer not registered");
    peer.writeAllowed = true;
    expect(await call("engine.ask")).toEqual({ ok: true, echo: "engine.ask" });

    // 4. A tampered record ends the session and is a counted failure; nothing is dispatched for it.
    const x = await connectV2(listen.port, clientKp, hostPub);
    const [record] = x.session.sealMessage(
      new TextEncoder().encode(JSON.stringify({ id: 3, method: "index.search", params: {} })),
    );
    const tampered = (record as Uint8Array).slice();
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;
    x.conn.writeFrame(tampered);
    expect(await x.conn.closed()).toBe(true);

    // 5. The rate limiter locks out an address after repeated failures.
    for (let i = 0; i < 4; i++) host.rateLimit.recordFailure("192.0.2.3");
    expect(host.rateLimit.checkAllowed("192.0.2.3")).toBe(false);
  });
});
