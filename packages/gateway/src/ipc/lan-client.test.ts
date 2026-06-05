import { afterEach, expect, test } from "bun:test";
import type { TCPSocketListener } from "bun";
import { outboundPairHandshake } from "./lan-client.ts";
import { generateBoxKeypair } from "./lan-crypto.ts";
import { generatePairingCode, PairingWindow } from "./lan-pairing.ts";
import { LanRateLimiter } from "./lan-rate-limit.ts";
import { LanServer } from "./lan-server.ts";

let server: LanServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function startResponder(open: boolean) {
  const hostKp = generateBoxKeypair();
  const pairingWindow = new PairingWindow(5000);
  const code = generatePairingCode();
  if (open) pairingWindow.open(code);
  // PairingWindow.getExpiresAt() returns number|null but PairingService wants number|undefined
  const pairing = {
    isOpen: () => pairingWindow.isOpen(),
    consume: (c: string) => pairingWindow.consume(c),
    open: (c: string) => pairingWindow.open(c),
    close: () => pairingWindow.close(),
    getExpiresAt: () => pairingWindow.getExpiresAt() ?? undefined,
  };
  server = new LanServer({
    bind: "127.0.0.1",
    port: 0,
    hostKeypair: hostKp,
    pairing,
    rateLimit: new LanRateLimiter({ maxFailures: 3, windowMs: 2000, lockoutMs: 2000 }),
    isKnownPeer: () => null,
    registerPeer: () => "peer-x",
    onMessage: async () => ({}),
  });
  await server.start();
  const addr = server.listenAddr();
  if (!addr) throw new Error("no addr");
  return { hostKp, code, port: addr.port };
}

test("outboundPairHandshake returns the responder host pubkey on pair_ok", async () => {
  const { hostKp, code, port } = await startResponder(true);
  const selfKp = generateBoxKeypair();
  const hostPub = await outboundPairHandshake("127.0.0.1", port, code, selfKp);
  expect(Buffer.from(hostPub).toString("hex")).toBe(Buffer.from(hostKp.publicKey).toString("hex"));
});

test("outboundPairHandshake throws on pair_err (window closed)", async () => {
  const { code, port } = await startResponder(false);
  const selfKp = generateBoxKeypair();
  await expect(outboundPairHandshake("127.0.0.1", port, code, selfKp)).rejects.toThrow();
});

test("outboundPairHandshake rejects on timeout when peer never replies", async () => {
  // Start a bare TCP server that accepts connections and holds them open without writing.
  let silent: TCPSocketListener | undefined;
  silent = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { open() {}, data() {}, close() {}, error() {} },
  });
  try {
    const selfKp = generateBoxKeypair();
    // Pass a short timeoutMs (200 ms) so the test completes quickly.
    await expect(
      outboundPairHandshake("127.0.0.1", silent.port, "unused-code", selfKp, 200),
    ).rejects.toThrow("lan-client: handshake timeout");
  } finally {
    silent.stop(true);
  }
});
