import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type BoxKeypair,
  generateBoxKeypair,
  pairingProof,
  pairingProofMatches,
} from "../../../src/ipc/lan-crypto.ts";
import { generatePairingCode, PairingWindow } from "../../../src/ipc/lan-pairing.ts";
import { LanRateLimiter } from "../../../src/ipc/lan-rate-limit.ts";
import { checkLanMethodAllowed } from "../../../src/ipc/lan-rpc.ts";
import { LanServer } from "../../../src/ipc/lan-server.ts";
import {
  connectLan,
  framed,
  openV2Session,
  v2PairRequest,
} from "../../helpers/lan-v2-test-client.ts";

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
          return { peerId: id, writeAllowed: p.writeAllowed };
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

describe("LAN end-to-end pair → read → write → tamper", () => {
  let host: TestHost;
  beforeEach(async () => {
    host = await spinUpHost(0);
  });
  afterEach(async () => {
    await host.server.stop();
  });

  test("full flow: pair, open a session, read, write, tamper", async () => {
    const listen = host.server.listenAddr();
    if (!listen) throw new Error("no listen addr");

    const clientKp = generateBoxKeypair();

    const code = generatePairingCode();
    host.pairing.open(code);

    // 1. Pair on its own connection. The host answers with its key and a proof bound to it.
    const pairConn = await connectLan(listen.port);
    pairConn.send(framed(v2PairRequest(clientKp, code)));
    const pairOk = await pairConn.nextJson<Record<string, unknown>>();
    expect(pairOk?.["kind"]).toBe("pair_ok");
    expect(
      pairingProofMatches(
        pairingProof(code, "host", clientKp.publicKey, host.hostKp.publicKey),
        new Uint8Array(Buffer.from(String(pairOk?.["host_proof"]), "base64")),
      ),
    ).toBe(true);
    expect(await pairConn.closed()).toBe(true);
    expect(host.peers.size).toBe(1);
    expect(host.pairing.isOpen()).toBe(false); // single use

    // 2. Open a session and read.
    const { conn, session } = await openV2Session(listen.port, clientKp, host.hostKp.publicKey);
    if (session === null) throw new Error("hello refused");
    conn.send(framed(session.seal({ id: 1, method: "index.search", params: { q: "x" } })));
    expect(
      session.open<Record<string, unknown>>((await conn.nextFrame()) ?? new Uint8Array()),
    ).toEqual({
      id: 1,
      result: { ok: true, echo: "index.search" },
    });

    // 3. A write is refused until the owner grants it, then allowed on the same session.
    conn.send(framed(session.seal({ id: 2, method: "engine.ask", params: {} })));
    const refused = session.open((await conn.nextFrame()) ?? new Uint8Array());
    expect(refused.id).toBe(2);
    expect(refused.error?.message).toContain("ERR_LAN_WRITE_FORBIDDEN");
    const [peerId] = [...host.peers.keys()];
    if (!peerId) throw new Error("no peerId");
    const peer = host.peers.get(peerId);
    if (!peer) throw new Error("peer not registered");
    peer.writeAllowed = true;
    // The grant is read when a session opens, so the open session keeps its read-only grant ...
    conn.send(framed(session.seal({ id: 3, method: "engine.ask", params: {} })));
    expect(session.open((await conn.nextFrame()) ?? new Uint8Array()).error?.message).toContain(
      "ERR_LAN_WRITE_FORBIDDEN",
    );
    conn.end();
    // ... and the next session gets the write.
    const next = await openV2Session(listen.port, clientKp, host.hostKp.publicKey);
    if (next.session === null) throw new Error("hello refused");
    next.conn.send(framed(next.session.seal({ id: 4, method: "engine.ask", params: {} })));
    expect(
      next.session.open<Record<string, unknown>>((await next.conn.nextFrame()) ?? new Uint8Array()),
    ).toEqual({
      id: 4,
      result: { ok: true, echo: "engine.ask" },
    });

    // 4. A tampered frame ends the session.
    const tampered = next.session.seal({ id: 5, method: "index.search", params: {} });
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;
    next.conn.send(framed(tampered));
    expect(await next.conn.closed()).toBe(true);

    // 5. Repeated handshake failures lock an address out.
    for (let i = 0; i < 4; i++) {
      host.rateLimit.recordFailure("192.0.2.3");
    }
    expect(host.rateLimit.checkAllowed("192.0.2.3")).toBe(false);
  });
});
