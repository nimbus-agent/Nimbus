import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Socket } from "bun";
import { type BoxKeypair, generateBoxKeypair, sealBoxFrame } from "../../../src/ipc/lan-crypto.ts";
import { generatePairingCode, PairingWindow } from "../../../src/ipc/lan-pairing.ts";
import { LanRateLimiter } from "../../../src/ipc/lan-rate-limit.ts";
import { checkLanMethodAllowed } from "../../../src/ipc/lan-rpc.ts";
import { LanServer } from "../../../src/ipc/lan-server.ts";

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

function writeFrame(socket: Socket<undefined>, payload: Uint8Array): void {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, payload.length, false);
  socket.write(header);
  socket.write(payload);
}

describe("LAN end-to-end pair → read → write → tamper", () => {
  let host: TestHost;
  beforeEach(async () => {
    host = await spinUpHost(0);
  });
  afterEach(async () => {
    await host.server.stop();
  });

  test("full 9-step flow", async () => {
    const listen = host.server.listenAddr();
    if (!listen) throw new Error("no listen addr");

    const clientKp = generateBoxKeypair();

    const code = generatePairingCode();
    host.pairing.open(code);

    const sock = await Bun.connect<undefined>({
      hostname: "127.0.0.1",
      port: listen.port,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    writeFrame(
      sock,
      new TextEncoder().encode(
        JSON.stringify({
          kind: "pair",
          client_pubkey: Buffer.from(clientKp.publicKey).toString("base64"),
          pairing_code: code,
        }),
      ),
    );

    await Bun.sleep(50);
    expect(host.peers.size).toBe(1);

    const [peerId] = [...host.peers.keys()];
    const readReq = sealBoxFrame(
      new TextEncoder().encode(
        JSON.stringify({ id: 1, method: "index.search", params: { q: "x" } }),
      ),
      host.hostKp.publicKey,
      clientKp.secretKey,
    );
    writeFrame(sock, readReq);
    await Bun.sleep(50);

    expect(peerId).toBeDefined();
    if (!peerId) throw new Error("no peerId");
    const peer = host.peers.get(peerId);
    if (!peer) throw new Error("peer not registered");
    peer.writeAllowed = true;

    const writeReq = sealBoxFrame(
      new TextEncoder().encode(JSON.stringify({ id: 2, method: "engine.ask", params: {} })),
      host.hostKp.publicKey,
      clientKp.secretKey,
    );
    writeFrame(sock, writeReq);
    await Bun.sleep(50);

    const tampered = sealBoxFrame(
      new TextEncoder().encode(JSON.stringify({ id: 3, method: "index.search", params: {} })),
      host.hostKp.publicKey,
      clientKp.secretKey,
    );
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;
    writeFrame(sock, tampered);
    await Bun.sleep(50);
    sock.end();

    await Bun.sleep(2100);
    expect(host.pairing.isOpen()).toBe(false);

    for (let i = 0; i < 4; i++) {
      host.rateLimit.recordFailure("192.0.2.3");
    }
    expect(host.rateLimit.checkAllowed("192.0.2.3")).toBe(false);
  });
});
