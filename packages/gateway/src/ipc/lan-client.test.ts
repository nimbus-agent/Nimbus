import { afterEach, describe, expect, test } from "bun:test";
import type { Socket, TCPSocketListener } from "bun";
import { buildFrame, makeFrameReader, outboundPairHandshake } from "./lan-client.ts";
import { generateBoxKeypair } from "./lan-crypto.ts";
import { PAIR_NO_REPLY_HINT } from "./lan-pair-client.ts";
import { generatePairingCode, PairingWindow } from "./lan-pairing.ts";
import { LanRateLimiter } from "./lan-rate-limit.ts";
import { LanServer } from "./lan-server.ts";

// ---------------------------------------------------------------------------
// Shared server lifecycle
// ---------------------------------------------------------------------------

let server: LanServer | undefined;
let rawServer: TCPSocketListener | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  rawServer?.stop(true);
  rawServer = undefined;
});

// ---------------------------------------------------------------------------
// makeFrameReader — unit tests for the three uncovered branch arms
// ---------------------------------------------------------------------------

describe("makeFrameReader", () => {
  // BRDA line=27 block=0 branch=0: buf.length < 4 → return undefined (too short for header)
  test("returns undefined when buffer has fewer than 4 bytes", () => {
    const reader = makeFrameReader(1024);
    // push only 3 bytes — not enough for the 4-byte length header
    reader.push(new Uint8Array([0x00, 0x00, 0x00]));
    expect(reader.next()).toBeUndefined();
  });

  // BRDA line=30 block=1 branch=0: len > maxFrameBytes → throw
  test("throws on an oversized frame length", () => {
    const reader = makeFrameReader(10); // max = 10 bytes
    // build a header claiming 11 bytes
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, 11, false);
    reader.push(header);
    expect(() => reader.next()).toThrow("lan-client: oversized frame");
  });

  // BRDA line=31 block=2 branch=0: buf.length < 4 + len → return undefined (partial body)
  test("returns undefined when body bytes have not all arrived yet", () => {
    const reader = makeFrameReader(1024);
    // header claims 10 bytes body but we only supply 5
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, 10, false);
    const partial = new Uint8Array(5).fill(0xab);
    reader.push(header);
    reader.push(partial);
    expect(reader.next()).toBeUndefined();
  });

  // Sanity: full frame is returned correctly
  test("returns the body once the full frame arrives", () => {
    const reader = makeFrameReader(1024);
    const body = new Uint8Array([0x01, 0x02, 0x03]);
    reader.push(buildFrame(body));
    const out = reader.next();
    expect(out).toEqual(body);
  });
});

// ---------------------------------------------------------------------------
// Low-level helpers for building raw TCP servers
// ---------------------------------------------------------------------------

/**
 * Write a 4-byte-length-prefixed frame to a raw Bun socket (mirrors writeFrame in lan-client.ts).
 */
function writeRawFrame(socket: Socket<undefined>, payload: Uint8Array): void {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, payload.length, false);
  socket.write(header);
  socket.write(payload);
}

/**
 * Start a raw TCP listener that fires `onData` when the first data chunk arrives
 * from the client (i.e. after the client has already sent its opening frame).
 * Do NOT call `socket.end()` in `onData` unless intentional — the client will
 * close on its own once it processes the response.
 */
function startDataServer(
  onData: (socket: Socket<undefined>, chunk: Uint8Array) => void,
): Promise<number> {
  return new Promise((resolve) => {
    rawServer = Bun.listen<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() {},
        data(socket, chunk) {
          onData(socket, chunk);
        },
        close() {},
        error() {},
      },
    });
    resolve(rawServer.port);
  });
}

// ---------------------------------------------------------------------------
// startResponder — shared helper from original test suite
// ---------------------------------------------------------------------------

async function startResponder(open: boolean) {
  const hostKp = generateBoxKeypair();
  const pairingWindow = new PairingWindow(5000);
  const code = generatePairingCode();
  if (open) pairingWindow.open(code);
  const pairing = {
    isOpen: () => pairingWindow.isOpen(),
    open: (c: string) => pairingWindow.open(c),
    close: () => pairingWindow.close(),
    getExpiresAt: () => pairingWindow.getExpiresAt() ?? undefined,
    currentPsk: () => pairingWindow.currentPsk(),
    consumeOpen: () => pairingWindow.consumeOpen(),
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

// ---------------------------------------------------------------------------
// Original integration tests (preserved unchanged)
// ---------------------------------------------------------------------------

test("outboundPairHandshake returns the responder host pubkey on pair_ok", async () => {
  const { hostKp, code, port } = await startResponder(true);
  const selfKp = generateBoxKeypair();
  const hostPub = await outboundPairHandshake("127.0.0.1", port, code, selfKp);
  expect(Buffer.from(hostPub).toString("hex")).toBe(Buffer.from(hostKp.publicKey).toString("hex"));
});

test("outboundPairHandshake fails with no reply when the window is closed (v2: the host stays silent)", async () => {
  const { code, port } = await startResponder(false);
  await expect(
    outboundPairHandshake("127.0.0.1", port, code, generateBoxKeypair()),
  ).rejects.toThrow(PAIR_NO_REPLY_HINT);
});

test("outboundPairHandshake rejects on timeout when peer never replies", async () => {
  const silent = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { open() {}, data() {}, close() {}, error() {} },
  });
  try {
    await expect(
      outboundPairHandshake(
        "127.0.0.1",
        silent.port,
        generatePairingCode(),
        generateBoxKeypair(),
        200,
      ),
    ).rejects.toThrow("lan-client: pairing timeout");
  } finally {
    silent.stop(true);
  }
});

test("outboundPairHandshake: a plaintext reply is not a Noise message 2 and is never echoed", async () => {
  // Whoever answers controls the reply: it must fail on the AEAD, with a fixed error.
  const responder = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {},
      data(socket) {
        writeRawFrame(socket, new TextEncoder().encode(JSON.stringify({ kind: "pair_err\n## X" })));
      },
      close() {},
      error() {},
    },
  });
  try {
    const err = await outboundPairHandshake(
      "127.0.0.1",
      responder.port,
      generatePairingCode(),
      generateBoxKeypair(),
      500,
    ).catch((e: unknown) => e);
    expect((err as Error).message).toBe("lan-noise: message failed to open");
  } finally {
    responder.stop(true);
  }
});
// ---------------------------------------------------------------------------
// outboundPairHandshake — uncovered branches
// ---------------------------------------------------------------------------

describe("outboundPairHandshake — guard branches", () => {
  test("a code that is not 20 base58 characters is refused before any connection (D-FS-16)", async () => {
    let connections = 0;
    const port = await startDataServer(() => {
      connections += 1;
    });
    for (const bad of ["any-code", "", "0".repeat(20), generatePairingCode().slice(1)]) {
      await expect(
        outboundPairHandshake("127.0.0.1", port, bad, generateBoxKeypair()),
      ).rejects.toThrow("20 base58 characters");
    }
    expect(connections).toBe(0);
  });
});
