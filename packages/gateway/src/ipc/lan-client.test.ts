import { afterEach, describe, expect, test } from "bun:test";
import type { Socket, TCPSocketListener } from "bun";
import {
  buildFrame,
  exchangeOneFrame,
  MAX_HANDSHAKE_FRAME,
  makeFrameReader,
  outboundPairHandshake,
  sendFederatedOverWire,
} from "./lan-client.ts";
import { generateBoxKeypair, sealBoxFrame } from "./lan-crypto.ts";
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
 * Start a raw TCP listener that fires `onOpen` the moment a client connects
 * (before any data is exchanged).  Use for tests where the server should
 * close / send garbage BEFORE the client sends anything (e.g. testing the
 * "closed without reply" path, or the send-callback-throws path).
 */
function startOpenServer(onOpen: (socket: Socket<undefined>) => void): Promise<number> {
  return new Promise((resolve) => {
    rawServer = Bun.listen<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          onOpen(socket);
        },
        data() {},
        close() {},
        error() {},
      },
    });
    resolve(rawServer.port);
  });
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
// exchangeOneFrame — uncovered branches
// ---------------------------------------------------------------------------

describe("exchangeOneFrame", () => {
  // BRDA line=56 block=3 branch=0: timeoutMs DEFAULT_TIMEOUT_MS arm.
  // Covered by calling exchangeOneFrame without the 5th argument. The server
  // closes immediately so the promise rejects before the 5-second default fires.
  test("uses default timeoutMs — rejects when server closes without sending data", async () => {
    const port = await startOpenServer((socket) => {
      socket.end();
    });
    await expect(
      // No 5th arg → uses DEFAULT_TIMEOUT_MS (5000 ms); server closes first.
      exchangeOneFrame("127.0.0.1", port, (_s) => {}, MAX_HANDSHAKE_FRAME),
    ).rejects.toThrow("lan-client: connection closed without reply");
  });

  // BRDA line=70 block=6 branch=1: finish() called with body=undefined and no error
  // → rejects with "connection closed without reply".
  test("rejects with 'connection closed without reply' when server closes without sending data", async () => {
    const port = await startOpenServer((socket) => {
      socket.end();
    });
    await expect(
      exchangeOneFrame("127.0.0.1", port, (_s) => {}, MAX_HANDSHAKE_FRAME, 500),
    ).rejects.toThrow("lan-client: connection closed without reply");
  });

  // BRDA line=81 block=7 branch=0: send callback throws an Error instance.
  test("rejects with the Error thrown by the send callback (Error instance)", async () => {
    // Server holds the connection open — the send callback fires on open.
    const port = await startOpenServer((_socket) => {
      /* hold open; do not write or close */
    });
    const boom = new Error("send exploded");
    await expect(
      exchangeOneFrame(
        "127.0.0.1",
        port,
        (_s) => {
          throw boom;
        },
        MAX_HANDSHAKE_FRAME,
        500,
      ),
    ).rejects.toThrow("send exploded");
  });

  // BRDA line=81 block=7 branch=1: send callback throws a non-Error value.
  test("wraps a non-Error thrown by the send callback into an Error", async () => {
    const port = await startOpenServer((_socket) => {
      /* hold open */
    });
    await expect(
      exchangeOneFrame(
        "127.0.0.1",
        port,
        (_s) => {
          // Intentionally throwing a plain string (non-Error) to cover the ternary branch.
          // biome-ignore lint/complexity/noUselessThrow: testing non-Error throw path
          throw "plain string throw" as unknown as Error;
        },
        MAX_HANDSHAKE_FRAME,
        500,
      ),
    ).rejects.toThrow("plain string throw");
  });

  // BRDA line=90 block=8 branch=1: body === undefined after push (partial frame arrives).
  // Server sends only the 4-byte length header with no body bytes — data handler runs,
  // reader.next() returns undefined, handler returns without settling the promise.
  // The exchange eventually times out.
  test("times out when server sends only a partial frame (header only, no body)", async () => {
    // Server responds to the client's opening write with a partial frame.
    const port = await startDataServer((socket, _chunk) => {
      // Send header claiming 5 bytes of body, but write no body.
      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint32(0, 5, false);
      socket.write(header);
      // Intentionally no body — let the timeout fire.
    });
    await expect(
      exchangeOneFrame("127.0.0.1", port, (_s) => {}, MAX_HANDSHAKE_FRAME, 150),
    ).rejects.toThrow("lan-client: handshake timeout");
  });

  // BRDA line=99 block=9 branch=0: data handler catch — reader.next() throws an Error.
  // Server sends a length-prefix exceeding maxFrameBytes so reader.next() throws.
  // Note: socket.end() is called BEFORE finish() in the catch (lines 98–99), so Bun's
  // synchronous close() fires first and settles the promise with "connection closed
  // without reply". The branch is taken (the Error path of the ternary runs), but the
  // final rejection comes from close() winning the race.
  test("rejects when server sends an oversized frame (data handler catch branch taken)", async () => {
    const port = await startDataServer((socket, _chunk) => {
      // Claim MAX_HANDSHAKE_FRAME+1 bytes — triggers "lan-client: oversized frame" in reader.
      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint32(0, MAX_HANDSHAKE_FRAME + 1, false);
      socket.write(header);
      // Do NOT call socket.end() — the client ends it.
    });
    // The client must send something so the server's onData fires; pass a no-op frame.
    const dummyPayload = new Uint8Array(1);
    await expect(
      exchangeOneFrame(
        "127.0.0.1",
        port,
        (s) => {
          writeRawFrame(s, dummyPayload);
        },
        MAX_HANDSHAKE_FRAME,
        500,
      ),
    ).rejects.toThrow();
  });

  // BRDA line=106 block=10 branch=0: socket error handler fires with an Error instance.
  // socket.terminate() causes an abortive RST which Bun surfaces as a socket error.
  test("rejects via the error handler when the socket is abortively closed (terminate)", async () => {
    const port = await startOpenServer((socket) => {
      socket.terminate();
    });
    // On some platforms this surfaces as "closed without reply" via the close handler
    // rather than the error handler, but it always rejects — the important thing is
    // that the finish() path is exercised.
    await expect(
      exchangeOneFrame("127.0.0.1", port, (_s) => {}, MAX_HANDSHAKE_FRAME, 500),
    ).rejects.toThrow();
  });
});

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

// ---------------------------------------------------------------------------
// Original integration tests (preserved unchanged)
// ---------------------------------------------------------------------------

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
  let silent: TCPSocketListener | undefined;
  silent = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { open() {}, data() {}, close() {}, error() {} },
  });
  try {
    const selfKp = generateBoxKeypair();
    await expect(
      outboundPairHandshake("127.0.0.1", silent.port, "unused-code", selfKp, 200),
    ).rejects.toThrow("lan-client: handshake timeout");
  } finally {
    silent.stop(true);
  }
});

test("sendFederatedOverWire performs hello + encrypted RPC against a known peer", async () => {
  const hostKp = generateBoxKeypair();
  const selfKp = generateBoxKeypair();
  server = new LanServer({
    bind: "127.0.0.1",
    port: 0,
    hostKeypair: hostKp,
    pairing: {
      isOpen: () => false,
      consume: () => false,
      open: () => {},
      close: () => {},
      getExpiresAt: () => undefined,
    },
    rateLimit: new LanRateLimiter({ maxFailures: 3, windowMs: 2000, lockoutMs: 2000 }),
    isKnownPeer: (pub) =>
      Buffer.compare(Buffer.from(pub), Buffer.from(selfKp.publicKey)) === 0
        ? { peerId: "peer-known", writeAllowed: false }
        : null,
    registerPeer: () => "peer-known",
    onMessage: async (method, params, peer) => ({ method, params, peerId: peer.peerId }),
  });
  await server.start();
  const port = server.listenAddr()?.port as number;
  const res = (await sendFederatedOverWire(
    "127.0.0.1",
    port,
    selfKp,
    hostKp.publicKey,
    "federation.query",
    { namespace: "n", purpose: "p" },
  )) as { method: string; peerId: string };
  expect(res.method).toBe("federation.query");
  expect(res.peerId).toBe("peer-known");
});

// ---------------------------------------------------------------------------
// exchangeHelloThenRpc branches — driven through sendFederatedOverWire via
// stateful raw servers that respond AFTER the client sends its hello frame.
// ---------------------------------------------------------------------------

/**
 * Creates a stateful two-phase raw server.
 *
 *   Phase "hello": server receives the client's hello frame, then calls
 *                  `onHello(socket, helloPayload)`.
 *   Phase "rpc":   server receives the client's RPC frame, then calls
 *                  `onRpc(socket, rpcPayload)`.
 *
 * Both callbacks are optional — if omitted the server does nothing for that
 * phase, which lets the exchange time out (useful for testing partial-frame
 * and timeout branches).
 */
function startHelloRpcServer(opts: {
  onHello?: (socket: Socket<undefined>, payload: Uint8Array) => void;
  onRpc?: (socket: Socket<undefined>, payload: Uint8Array) => void;
}): Promise<number> {
  // Accumulate incoming bytes and process complete frames one at a time.
  let buf = new Uint8Array(0);
  let phase: "hello" | "rpc" = "hello";

  return new Promise((resolve) => {
    rawServer = Bun.listen<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() {},
        data(socket, chunk) {
          // append chunk
          const merged = new Uint8Array(buf.length + chunk.length);
          merged.set(buf, 0);
          merged.set(chunk, buf.length);
          buf = merged;

          // consume all complete frames
          while (buf.length >= 4) {
            const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
            const len = view.getUint32(0, false);
            if (buf.length < 4 + len) break;
            const payload = buf.slice(4, 4 + len);
            buf = buf.slice(4 + len);

            if (phase === "hello") {
              phase = "rpc";
              opts.onHello?.(socket, payload);
            } else {
              opts.onRpc?.(socket, payload);
            }
          }
        },
        close() {},
        error() {},
      },
    });
    resolve(rawServer.port);
  });
}

describe("exchangeHelloThenRpc (via sendFederatedOverWire)", () => {
  // BRDA line=138 block=15 branch=1: finish(undefined) → "connection closed mid-exchange"
  // Server closes immediately on connect without sending any reply.
  test("rejects with 'connection closed mid-exchange' when server closes without replying", async () => {
    const port = await startOpenServer((socket) => {
      socket.end();
    });
    const selfKp = generateBoxKeypair();
    const hostKp = generateBoxKeypair();
    await expect(
      sendFederatedOverWire(
        "127.0.0.1",
        port,
        selfKp,
        hostKp.publicKey,
        "federation.query",
        {},
        500,
      ),
    ).rejects.toThrow("lan-client: connection closed mid-exchange");
  });

  // BRDA line=155 block=16 branch=0: reader.next() throws an Error in the data handler.
  // Server sends an oversized length-prefix (> MAX_ENCRYPTED_FRAME = 4 MiB).
  // Note: the production code at lines 154–156 calls socket.end() BEFORE finish(), so
  // Bun fires close() synchronously and the promise is settled as "connection closed
  // mid-exchange". The catch branch IS taken (branch arm covered), but the close handler
  // wins the settlement race.
  test("rejects when server sends an oversized frame (helloThenRpc reader-catch branch taken)", async () => {
    const port = await startHelloRpcServer({
      onHello(socket) {
        // Respond with a length prefix that exceeds MAX_ENCRYPTED_FRAME.
        const header = new Uint8Array(4);
        new DataView(header.buffer).setUint32(0, 4 * 1024 * 1024 + 1, false);
        socket.write(header);
        // No body bytes — the reader throws as soon as it sees the length.
      },
    });
    const selfKp = generateBoxKeypair();
    const hostKp = generateBoxKeypair();
    await expect(
      sendFederatedOverWire(
        "127.0.0.1",
        port,
        selfKp,
        hostKp.publicKey,
        "federation.query",
        {},
        500,
      ),
    ).rejects.toThrow("lan-client: connection closed mid-exchange");
  });

  // BRDA line=158 block=17 branch=0: body === undefined (partial hello frame received).
  // Server sends only a 4-byte header with no body — data handler returns early.
  test("times out when server sends only a partial hello frame (header with no body)", async () => {
    const port = await startHelloRpcServer({
      onHello(socket) {
        const header = new Uint8Array(4);
        new DataView(header.buffer).setUint32(0, 5, false);
        socket.write(header);
        // No body follows — reader.next() returns undefined, handler returns early.
      },
    });
    const selfKp = generateBoxKeypair();
    const hostKp = generateBoxKeypair();
    await expect(
      sendFederatedOverWire(
        "127.0.0.1",
        port,
        selfKp,
        hostKp.publicKey,
        "federation.query",
        {},
        150,
      ),
    ).rejects.toThrow("lan-client: rpc timeout");
  });

  // BRDA line=168 block=19 branch=0 AND line=172 block=20 branch=0:
  // reply.kind !== "hello_ok" (true) AND kind is a non-null string.
  // Note: production code calls socket.end() BEFORE finish(undefined, error) at lines 169–173,
  // so Bun fires close() synchronously and the promise settles as "connection closed
  // mid-exchange". The branch arms ARE taken (block=19 br=0 and block=20 br=0 are covered),
  // but the close handler wins the settlement race.
  test("covers hello-rejected branch (kind=hello_err → socket.end() race → closed mid-exchange)", async () => {
    const port = await startHelloRpcServer({
      onHello(socket) {
        const msg = JSON.stringify({ kind: "hello_err" });
        writeRawFrame(socket, new TextEncoder().encode(msg));
      },
    });
    const selfKp = generateBoxKeypair();
    const hostKp = generateBoxKeypair();
    await expect(
      sendFederatedOverWire(
        "127.0.0.1",
        port,
        selfKp,
        hostKp.publicKey,
        "federation.query",
        {},
        500,
      ),
    ).rejects.toThrow("lan-client: connection closed mid-exchange");
  });

  // BRDA line=172 block=20 branch=1: reply.kind ?? "unknown" — kind field is absent.
  // Same socket.end()-before-finish() race; outcome is "connection closed mid-exchange".
  test("covers hello-rejected (unknown) branch (kind absent → socket.end() race → closed mid-exchange)", async () => {
    const port = await startHelloRpcServer({
      onHello(socket) {
        const msg = JSON.stringify({}); // no kind field
        writeRawFrame(socket, new TextEncoder().encode(msg));
      },
    });
    const selfKp = generateBoxKeypair();
    const hostKp = generateBoxKeypair();
    await expect(
      sendFederatedOverWire(
        "127.0.0.1",
        port,
        selfKp,
        hostKp.publicKey,
        "federation.query",
        {},
        500,
      ),
    ).rejects.toThrow("lan-client: connection closed mid-exchange");
  });

  // BRDA line=181 block=21 branch=0: buildRpc callback throws an Error (invalid pubkey length).
  // line=224 block=26 branch=0: hostPub.length !== 32 → true.
  // Same socket.end()-before-finish() race; outcome is "connection closed mid-exchange".
  test("covers buildRpc-throws branch (short host_pubkey → socket.end() race → closed mid-exchange)", async () => {
    const port = await startHelloRpcServer({
      onHello(socket) {
        // 16-byte pubkey — hostPub.length !== 32 triggers the Error in buildRpc.
        const shortPub = Buffer.from(new Uint8Array(16)).toString("base64");
        const msg = JSON.stringify({ kind: "hello_ok", host_pubkey: shortPub });
        writeRawFrame(socket, new TextEncoder().encode(msg));
      },
    });
    const selfKp = generateBoxKeypair();
    const hostKp = generateBoxKeypair();
    await expect(
      sendFederatedOverWire(
        "127.0.0.1",
        port,
        selfKp,
        hostKp.publicKey,
        "federation.query",
        {},
        500,
      ),
    ).rejects.toThrow("lan-client: connection closed mid-exchange");
  });

  // BRDA line=195 block=22 branch=0: error handler fires during hello exchange.
  test("rejects via the error handler when socket is terminated during hello exchange", async () => {
    const port = await startOpenServer((socket) => {
      socket.terminate();
    });
    const selfKp = generateBoxKeypair();
    const hostKp = generateBoxKeypair();
    await expect(
      sendFederatedOverWire(
        "127.0.0.1",
        port,
        selfKp,
        hostKp.publicKey,
        "federation.query",
        {},
        500,
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// sendFederatedOverWire — uncovered branches in the buildRpc callback
// ---------------------------------------------------------------------------

describe("sendFederatedOverWire — buildRpc guard branches", () => {
  // BRDA line=223 block=25 branch=1: reply.host_pubkey ?? "" — host_pubkey absent.
  // Empty base64 decodes to 0 bytes → hostPub.length !== 32 triggers the guard inside
  // buildRpc. Production code at lines 179-182 calls socket.end() before finish(), so
  // Bun fires close() synchronously — "connection closed mid-exchange" wins the race.
  // The ?? "" null-coalescing branch IS evaluated (covered), but finish() is already settled.
  test("covers host_pubkey-absent branch (nullish-coalescing taken, socket.end() race)", async () => {
    const port = await startHelloRpcServer({
      onHello(socket) {
        const msg = JSON.stringify({ kind: "hello_ok" }); // host_pubkey absent
        writeRawFrame(socket, new TextEncoder().encode(msg));
      },
    });
    const selfKp = generateBoxKeypair();
    const hostKp = generateBoxKeypair();
    await expect(
      sendFederatedOverWire(
        "127.0.0.1",
        port,
        selfKp,
        hostKp.publicKey,
        "federation.query",
        {},
        500,
      ),
    ).rejects.toThrow("lan-client: connection closed mid-exchange");
  });

  // BRDA line=227 block=27 branch=0: Buffer.compare !== 0 → pubkey mismatch.
  // Same socket.end()-before-finish() race — outcome is "connection closed mid-exchange".
  test("covers pubkey-mismatch branch (wrong 32-byte pubkey, socket.end() race)", async () => {
    const port = await startHelloRpcServer({
      onHello(socket) {
        // Valid 32-byte pubkey that is NOT the pinned one.
        const wrongPub = Buffer.from(new Uint8Array(32).fill(0xde)).toString("base64");
        const msg = JSON.stringify({ kind: "hello_ok", host_pubkey: wrongPub });
        writeRawFrame(socket, new TextEncoder().encode(msg));
      },
    });
    const selfKp = generateBoxKeypair();
    const hostKp = generateBoxKeypair();
    await expect(
      sendFederatedOverWire(
        "127.0.0.1",
        port,
        selfKp,
        hostKp.publicKey,
        "federation.query",
        {},
        500,
      ),
    ).rejects.toThrow("lan-client: connection closed mid-exchange");
  });

  // BRDA line=245 block=29 branch=1 (error.code ?? "") and block=30 branch=1 (error.message ?? ""):
  // Peer returns an error response with neither code nor message fields.
  // We use a raw server that forges an encrypted error reply.
  test("rejects with trimmed 'lan-client: peer error' when error has no code or message", async () => {
    const rawHostKp = generateBoxKeypair();
    const selfKp = generateBoxKeypair();
    let clientPub: Uint8Array | null = null;

    const port = await startHelloRpcServer({
      onHello(socket, helloPayload) {
        // Parse the hello to capture the client's public key.
        let msg: { kind?: string; client_pubkey?: string };
        try {
          msg = JSON.parse(new TextDecoder().decode(helloPayload)) as typeof msg;
        } catch {
          socket.end();
          return;
        }
        clientPub = msg.client_pubkey
          ? new Uint8Array(Buffer.from(msg.client_pubkey, "base64"))
          : new Uint8Array(32);

        // Reply with a valid hello_ok so the client advances to the RPC phase.
        const helloOk = JSON.stringify({
          kind: "hello_ok",
          host_pubkey: Buffer.from(rawHostKp.publicKey).toString("base64"),
        });
        writeRawFrame(socket, new TextEncoder().encode(helloOk));
      },
      onRpc(socket) {
        // Return a forged encrypted reply: { id: 1, error: {} } — no code/message.
        const cp = clientPub ?? new Uint8Array(32);
        const forgedResp = new TextEncoder().encode(JSON.stringify({ id: 1, error: {} }));
        const sealed = sealBoxFrame(forgedResp, cp, rawHostKp.secretKey);
        writeRawFrame(socket, sealed);
      },
    });

    await expect(
      sendFederatedOverWire(
        "127.0.0.1",
        port,
        selfKp,
        rawHostKp.publicKey,
        "federation.query",
        {},
        1000,
      ),
    ).rejects.toThrow("lan-client: peer error");
  });
});

// ---------------------------------------------------------------------------
// outboundPairHandshake — uncovered branches
// ---------------------------------------------------------------------------

describe("outboundPairHandshake — guard branches", () => {
  // BRDA line=278 block=34 branch=1: msg.kind ?? "unknown" — kind field absent.
  test("rejects with 'pairing rejected (unknown)' when response has no kind field", async () => {
    // Server sends a frame with no kind field after the client's pair request.
    const port = await startDataServer((socket, _chunk) => {
      const msg = JSON.stringify({ host_pubkey: "somevalue" }); // no kind
      writeRawFrame(socket, new TextEncoder().encode(msg));
    });
    const selfKp = generateBoxKeypair();
    await expect(outboundPairHandshake("127.0.0.1", port, "any-code", selfKp, 500)).rejects.toThrow(
      "lan-client: pairing rejected (unknown)",
    );
  });

  // BRDA line=278 block=34 branch=0 (kind present but wrong) is already covered by the
  // "throws on pair_err (window closed)" test above.

  // BRDA line=281 block=35 branch=0: hostPub.length !== 32 → true (bad host pubkey length).
  test("rejects with 'bad host pubkey length' when server returns a short pubkey in pair_ok", async () => {
    const port = await startDataServer((socket, _chunk) => {
      const shortPub = Buffer.from(new Uint8Array(16)).toString("base64"); // 16 bytes
      const msg = JSON.stringify({ kind: "pair_ok", host_pubkey: shortPub });
      writeRawFrame(socket, new TextEncoder().encode(msg));
    });
    const selfKp = generateBoxKeypair();
    await expect(outboundPairHandshake("127.0.0.1", port, "any-code", selfKp, 500)).rejects.toThrow(
      "lan-client: bad host pubkey length",
    );
  });
});

// ---------------------------------------------------------------------------
// D-CANDIDATES (defensively-unreachable branches — Sub-project D)
// ---------------------------------------------------------------------------
//
// The following BRDA arms cannot be covered without modifying production source:
//
// D1. line=99 block=9 branch=1 — data handler catch (exchangeOneFrame) with a non-Error.
//     makeFrameReader.next() only throws `new Error(...)` literals, so the
//     `e instanceof Error` false arm is structurally unreachable.
//
// D2. line=106 block=10 branch=1 — error handler (exchangeOneFrame) with non-Error.
//     Bun's TCP socket error callback always passes a proper Error object.
//
// D3. line=109 block=11 branch=1 — Bun.connect().catch with non-Error rejection.
//     Bun.connect only ever rejects with Error instances.
//
// D4. line=123 block=12 branch=0 — exchangeHelloThenRpc default timeoutMs arm.
//     This internal (non-exported) function is only called from sendFederatedOverWire
//     which ALWAYS passes timeoutMs explicitly (line 236), so the default is never
//     taken through the public API.
//
// D5. line=155 block=16 branch=1 — exchangeHelloThenRpc data catch with non-Error.
//     Same reasoning as D1: makeFrameReader only throws Error instances.
//
// D6. line=181 block=21 branch=1 — buildRpc throws a non-Error.
//     sendFederatedOverWire's buildRpc only throws `new Error(...)` (lines 225, 228).
//
// D7. line=195 block=22 branch=1 — exchangeHelloThenRpc error handler non-Error.
//     Same as D2.
//
// D8. line=198 block=23 branch=1 — exchangeHelloThenRpc .catch non-Error.
//     Same as D3.
