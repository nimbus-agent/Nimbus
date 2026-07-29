import { afterEach, describe, expect, test } from "bun:test";
import { generateBoxKeypair, openBoxFrame, sealBoxFrame } from "./lan-crypto.ts";
import { LanServer } from "./lan-server.ts";

let server: LanServer | undefined;

function makeServer(): LanServer {
  return new LanServer({
    bind: "127.0.0.1",
    port: 0,
    hostKeypair: generateBoxKeypair(),
    onMessage: async () => ({}),
    isKnownPeer: () => null,
    rateLimit: { checkAllowed: () => true, recordFailure: () => {}, recordSuccess: () => {} },
    pairing: {
      isOpen: () => false,
      consume: () => false,
      open: () => {},
      close: () => {},
      getExpiresAt: () => undefined,
    },
    registerPeer: () => "peer-id",
  });
}

describe("LanServer boot/stop", () => {
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  test("start exposes listenAddr on an available port", async () => {
    server = makeServer();
    await server.start();
    const addr = server.listenAddr();
    expect(addr).toBeTruthy();
    expect(addr?.port).toBeGreaterThan(0);
  });

  test("stop cleanly releases the port", async () => {
    server = makeServer();
    await server.start();
    await expect(server.stop()).resolves.toBeUndefined();
    server = undefined;
  });
});

async function sendEncryptedRpc(
  serverPubkey: Uint8Array,
  clientKeypair: ReturnType<typeof generateBoxKeypair>,
  serverPort: number,
  msg: { id: number; method: string; params?: unknown },
): Promise<{ result?: unknown; error?: { code: string; message: string } }> {
  const payload = new TextEncoder().encode(JSON.stringify(msg));
  const frame = sealBoxFrame(payload, serverPubkey, clientKeypair.secretKey);
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, frame.length, false);

  const helloMsg = JSON.stringify({
    kind: "hello",
    client_pubkey: Buffer.from(clientKeypair.publicKey).toString("base64"),
  });
  const helloBytes = new TextEncoder().encode(helloMsg);
  const helloHeader = new Uint8Array(4);
  new DataView(helloHeader.buffer).setUint32(0, helloBytes.length, false);

  let buffer = new Uint8Array(0);

  return new Promise((resolve, reject) => {
    const conn = Bun.connect({
      hostname: "127.0.0.1",
      port: serverPort,
      socket: {
        open(socket) {
          socket.write(helloHeader);
          socket.write(helloBytes);
        },
        data(socket, chunk) {
          try {
            const merged = new Uint8Array(buffer.length + chunk.length);
            merged.set(buffer, 0);
            merged.set(chunk, buffer.length);
            buffer = merged;

            while (buffer.length >= 4) {
              const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
              const len = view.getUint32(0, false);
              if (buffer.length < 4 + len) {
                return;
              }
              const body = buffer.slice(4, 4 + len);
              buffer = buffer.slice(4 + len);

              const text = new TextDecoder().decode(body);
              if (text.includes("hello_ok")) {
                socket.write(header);
                socket.write(frame);
              } else {
                const plain = openBoxFrame(body, serverPubkey, clientKeypair.secretKey);
                resolve(
                  JSON.parse(new TextDecoder().decode(plain)) as {
                    result?: unknown;
                    error?: { code: string; message: string };
                  },
                );
                socket.end();
                return;
              }
            }
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        },
        error(_, err) {
          reject(err);
        },
        close() {},
      },
    });
    setTimeout(() => {
      conn.then((s) => s.end());
      reject(new Error("timeout"));
    }, 3000);
  });
}

describe("LanServer gate (G4)", () => {
  let server: LanServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  async function makeGateServer(onMessageCalls: string[]): Promise<{
    hostKeypair: ReturnType<typeof generateBoxKeypair>;
    clientKeypair: ReturnType<typeof generateBoxKeypair>;
    port: number;
  }> {
    const hostKeypair = generateBoxKeypair();
    const clientKeypair = generateBoxKeypair();
    server = new LanServer({
      bind: "127.0.0.1",
      port: 0,
      hostKeypair,
      onMessage: async (method) => {
        onMessageCalls.push(method);
        return {};
      },
      isKnownPeer: () => ({ peerId: "test-peer", writeAllowed: false }),
      rateLimit: { checkAllowed: () => true, recordFailure: () => {}, recordSuccess: () => {} },
      pairing: {
        isOpen: () => false,
        consume: () => false,
        open: () => {},
        close: () => {},
        getExpiresAt: () => undefined,
      },
      registerPeer: () => "test-peer",
    });
    await server.start();
    return { hostKeypair, clientKeypair, port: server.listenAddr()!.port };
  }

  test("forbidden method (vault.list) is rejected with ERR_METHOD_NOT_ALLOWED", async () => {
    const calls: string[] = [];
    const { hostKeypair, clientKeypair, port } = await makeGateServer(calls);
    const resp = await sendEncryptedRpc(hostKeypair.publicKey, clientKeypair, port, {
      id: 1,
      method: "vault.list",
    });
    expect(resp.error?.message).toMatch(/ERR_METHOD_NOT_ALLOWED/);
    expect(calls).toHaveLength(0);
  });

  test("write method without write grant is rejected with ERR_LAN_WRITE_FORBIDDEN", async () => {
    const calls: string[] = [];
    const { hostKeypair, clientKeypair, port } = await makeGateServer(calls);
    const resp = await sendEncryptedRpc(hostKeypair.publicKey, clientKeypair, port, {
      id: 1,
      method: "engine.ask",
    });
    expect(resp.error?.message).toMatch(/ERR_LAN_WRITE_FORBIDDEN/);
    expect(calls).toHaveLength(0);
  });
});

async function probeClosedAfterHeader(port: number, declaredLength: number): Promise<boolean> {
  let closed = false;
  const conn = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      open(socket) {
        const buf = new Uint8Array(4);
        new DataView(buf.buffer).setUint32(0, declaredLength, false);
        socket.write(buf);
      },
      data() {},
      close() {
        closed = true;
      },
      error() {
        closed = true;
      },
    },
  });
  await new Promise((r) => setTimeout(r, 200));
  const result = closed;
  conn.end();
  return result;
}

async function buildBareLanServer(
  rateLimit?: Partial<{ recordFailure: (ip: string) => void }>,
): Promise<LanServer> {
  const { LanServer: Cls } = await import("./lan-server.ts");
  return new Cls({
    bind: "127.0.0.1",
    port: 0,
    hostKeypair: generateBoxKeypair(),
    onMessage: async () => ({}),
    isKnownPeer: () => null,
    rateLimit: {
      checkAllowed: () => true,
      recordFailure: rateLimit?.recordFailure ?? (() => {}),
      recordSuccess: () => {},
    },
    pairing: {
      isOpen: () => false,
      consume: () => false,
      open: () => {},
      close: () => {},
      getExpiresAt: () => undefined,
    },
    registerPeer: () => "p",
  });
}

describe("LanServer frame-size caps (S3-F3)", () => {
  let svr: LanServer | undefined;

  afterEach(async () => {
    await svr?.stop();
    svr = undefined;
  });

  async function startBareServer(
    rateLimit?: Partial<{ recordFailure: (ip: string) => void }>,
  ): Promise<{ port: number }> {
    svr = await buildBareLanServer(rateLimit);
    await svr.start();
    return { port: svr.listenAddr()!.port };
  }

  test("rejects pre-handshake frame whose declared length exceeds MAX_HANDSHAKE_FRAME", async () => {
    const { MAX_HANDSHAKE_FRAME } = await import("./lan-server.ts");
    const recordedFailures: string[] = [];
    const { port } = await startBareServer({
      recordFailure: (ip) => recordedFailures.push(ip),
    });
    const closed = await probeClosedAfterHeader(port, MAX_HANDSHAKE_FRAME + 1);
    expect(closed).toBe(true);
    expect(recordedFailures.length).toBeGreaterThan(0);
  });

  test("permits a small declared length (e.g. tiny JSON handshake) without closing", async () => {
    const { port } = await startBareServer();
    const closed = await probeClosedAfterHeader(port, 100);
    expect(closed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listenAddr() before start — line=78 block=0 branch=0
// ---------------------------------------------------------------------------

describe("LanServer.listenAddr before start", () => {
  test("returns undefined when the server has not been started yet", () => {
    const s = makeServer();
    expect(s.listenAddr()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// D-CANDIDATE: line=84 block=1 branch=0 — MAX_PENDING_BYTES accumulation guard.
//
// MAX_PENDING_BYTES = MAX_ENCRYPTED_FRAME + 65_536 = 4_259_840.
// The guard fires when prev.length + chunk.length > 4_259_840 in a single
// handleChunk call.  In practice, a 4.25 MB socket.write() is split by the
// OS TCP stack into many segments, each individually well below the threshold,
// so the guard never fires through the loopback interface — the data arrives
// as multiple callbacks, each of which passes the check.
//
// Reaching this branch deterministically would require either:
//   (a) an OS-level mechanism to deliver all bytes in a single read(), or
//   (b) a mock/seam for the Bun TCP layer (banned by rules).
// Listed as Sub-project D candidate.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Oversized encrypted frame (post-handshake, no rate-limit hit)
// Covers line=102 block=4 branch=1: !socket.data.peerPubkey is FALSE
// ---------------------------------------------------------------------------

describe("LanServer oversized frame post-handshake", () => {
  let svr: LanServer | undefined;

  afterEach(async () => {
    await svr?.stop();
    svr = undefined;
  });

  test("closes connection when an oversized frame arrives after handshake (no rate-limit failure)", async () => {
    const { MAX_ENCRYPTED_FRAME } = await import("./lan-server.ts");
    const hostKeypair = generateBoxKeypair();
    const clientKeypair = generateBoxKeypair();
    const recordedFailures: string[] = [];

    svr = new LanServer({
      bind: "127.0.0.1",
      port: 0,
      hostKeypair,
      onMessage: async () => ({}),
      isKnownPeer: () => ({ peerId: "post-hs-peer", writeAllowed: false }),
      rateLimit: {
        checkAllowed: () => true,
        recordFailure: (ip) => recordedFailures.push(ip),
        recordSuccess: () => {},
      },
      pairing: {
        isOpen: () => false,
        consume: () => false,
        open: () => {},
        close: () => {},
        getExpiresAt: () => undefined,
      },
      registerPeer: () => "post-hs-peer",
    });
    await svr.start();
    const port = svr.listenAddr()!.port;

    let closed = false;
    await new Promise<void>((resolve) => {
      const helloMsg = JSON.stringify({
        kind: "hello",
        client_pubkey: Buffer.from(clientKeypair.publicKey).toString("base64"),
      });
      const helloBytes = new TextEncoder().encode(helloMsg);
      const helloHeader = new Uint8Array(4);
      new DataView(helloHeader.buffer).setUint32(0, helloBytes.length, false);

      let phase: "hello" | "done" = "hello";
      Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open(socket) {
            socket.write(helloHeader);
            socket.write(helloBytes);
          },
          data(socket, chunk) {
            if (phase !== "hello") return;
            const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            if (chunk.length < 4) return;
            const len = view.getUint32(0, false);
            const body = chunk.slice(4, 4 + len);
            const text = new TextDecoder().decode(body);
            if (text.includes("hello_ok")) {
              phase = "done";
              // Send a frame header claiming MAX_ENCRYPTED_FRAME + 1 bytes (oversized)
              const oversizedHeader = new Uint8Array(4);
              new DataView(oversizedHeader.buffer).setUint32(0, MAX_ENCRYPTED_FRAME + 1, false);
              socket.write(oversizedHeader);
            }
          },
          close() {
            closed = true;
            resolve();
          },
          error() {
            closed = true;
            resolve();
          },
        },
      }).catch(() => {
        resolve();
      });
      setTimeout(resolve, 2000);
    });

    expect(closed).toBe(true);
    // Rate-limit failure must NOT have been recorded (peerPubkey was set)
    expect(recordedFailures).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleHandshake guard branches
// ---------------------------------------------------------------------------

/**
 * Sends a raw framed JSON payload to the server and collects either the reply
 * (if the server sends one before closing) or null (if the server just closes).
 */
function sendRawHandshakePayload(port: number, payload: string): Promise<{ kind?: string } | null> {
  const bytes = new TextEncoder().encode(payload);
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, bytes.length, false);

  return new Promise((resolve) => {
    let received: Uint8Array = new Uint8Array(0);
    const conn = Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(header);
          socket.write(bytes);
        },
        data(_socket, chunk) {
          const merged = new Uint8Array(received.length + chunk.length);
          merged.set(received, 0);
          merged.set(chunk, received.length);
          received = merged;
        },
        close() {
          if (received.length < 4) {
            resolve(null);
            return;
          }
          const view = new DataView(received.buffer, received.byteOffset, received.byteLength);
          const len = view.getUint32(0, false);
          const body = received.slice(4, 4 + len);
          try {
            const parsed = JSON.parse(new TextDecoder().decode(body)) as { kind?: string };
            resolve(parsed);
          } catch {
            resolve(null);
          }
        },
        error() {
          resolve(null);
        },
      },
    });
    setTimeout(() => {
      conn.then((s) => s.end()).catch(() => {});
      resolve(null);
    }, 2_000);
  });
}

describe("LanServer.handleHandshake — additional guard branches", () => {
  let svr: LanServer | undefined;

  afterEach(async () => {
    await svr?.stop();
    svr = undefined;
  });

  async function startHandshakeServer(): Promise<number> {
    svr = new LanServer({
      bind: "127.0.0.1",
      port: 0,
      hostKeypair: generateBoxKeypair(),
      onMessage: async () => ({}),
      isKnownPeer: () => null,
      rateLimit: { checkAllowed: () => true, recordFailure: () => {}, recordSuccess: () => {} },
      pairing: {
        isOpen: () => false,
        consume: () => false,
        open: () => {},
        close: () => {},
        getExpiresAt: () => undefined,
      },
      registerPeer: () => "p",
    });
    await svr.start();
    return svr.listenAddr()!.port;
  }

  // line=132 block=7 branch=0: msg.kind is neither "pair" nor "hello"
  test("closes without reply when handshake kind is unknown (line=132 branch=0)", async () => {
    const port = await startHandshakeServer();
    const reply = await sendRawHandshakePayload(
      port,
      JSON.stringify({
        kind: "unknown_kind",
        client_pubkey: Buffer.from(new Uint8Array(32).fill(1)).toString("base64"),
      }),
    );
    expect(reply).toBeNull();
  });

  // line=136 block=9 branch=0: client_pubkey is not a string
  test("closes without reply when client_pubkey is missing (line=136 branch=0)", async () => {
    const port = await startHandshakeServer();
    const reply = await sendRawHandshakePayload(port, JSON.stringify({ kind: "hello" }));
    expect(reply).toBeNull();
  });

  // line=141 block=10 branch=0: clientPubkey decoded to non-32-byte value
  test("closes without reply when client_pubkey decodes to wrong length (line=141 branch=0)", async () => {
    const port = await startHandshakeServer();
    // base64-encode 16 bytes — decodes to 16, not 32
    const shortPub = Buffer.from(new Uint8Array(16).fill(2)).toString("base64");
    const reply = await sendRawHandshakePayload(
      port,
      JSON.stringify({ kind: "hello", client_pubkey: shortPub }),
    );
    expect(reply).toBeNull();
  });

  // line=164 block=16 branch=0: pairing window open, code present, but consume() returns false
  test("replies pair_err and records failure when consume() returns false (line=164 branch=0)", async () => {
    const failures: string[] = [];
    svr = new LanServer({
      bind: "127.0.0.1",
      port: 0,
      hostKeypair: generateBoxKeypair(),
      onMessage: async () => ({}),
      isKnownPeer: () => null,
      rateLimit: {
        checkAllowed: () => true,
        recordFailure: (ip) => failures.push(ip),
        recordSuccess: () => {},
      },
      pairing: {
        isOpen: () => true, // window IS open
        consume: () => false, // but code is wrong — consume returns false
        open: () => {},
        close: () => {},
        getExpiresAt: () => undefined,
      },
      registerPeer: () => "p",
    });
    await svr.start();
    const port = svr.listenAddr()!.port;

    const validPub = Buffer.from(new Uint8Array(32).fill(5)).toString("base64");
    const reply = await sendRawHandshakePayload(
      port,
      JSON.stringify({ kind: "pair", client_pubkey: validPub, pairing_code: "wrong-code" }),
    );
    expect(reply?.kind).toBe("pair_err");
    expect(failures).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// handleEncryptedMessage — method-absent and generic-error branches
// ---------------------------------------------------------------------------

/**
 * Performs a full hello handshake and then sends an encrypted frame, returning
 * the decrypted response. Uses the same protocol as the existing sendEncryptedRpc
 * helper but accepts arbitrary plaintext so we can test missing-method and
 * error-shape paths.
 */
async function sendEncryptedPayload(
  hostPubkey: Uint8Array,
  clientKeypair: ReturnType<typeof generateBoxKeypair>,
  serverPort: number,
  plaintext: string,
): Promise<{ result?: unknown; error?: { code: string; message: string } } | null> {
  const payload = new TextEncoder().encode(plaintext);
  const frame = sealBoxFrame(payload, hostPubkey, clientKeypair.secretKey);
  const frameHeader = new Uint8Array(4);
  new DataView(frameHeader.buffer).setUint32(0, frame.length, false);

  const helloMsg = JSON.stringify({
    kind: "hello",
    client_pubkey: Buffer.from(clientKeypair.publicKey).toString("base64"),
  });
  const helloBytes = new TextEncoder().encode(helloMsg);
  const helloHeader = new Uint8Array(4);
  new DataView(helloHeader.buffer).setUint32(0, helloBytes.length, false);

  return new Promise((resolve) => {
    let phase: "hello" | "rpc" = "hello";
    // Reassemble length-prefixed frames: the server writes the 4-byte header and
    // the payload as two separate socket.write() calls, which TCP may deliver split
    // across data callbacks (or coalesced). Buffer bytes and only act on complete frames.
    let buf = new Uint8Array(0);
    const conn = Bun.connect({
      hostname: "127.0.0.1",
      port: serverPort,
      socket: {
        open(socket) {
          socket.write(helloHeader);
          socket.write(helloBytes);
        },
        data(socket, chunk) {
          const merged = new Uint8Array(buf.length + chunk.length);
          merged.set(buf, 0);
          merged.set(chunk, buf.length);
          buf = merged;
          while (buf.length >= 4) {
            const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(
              0,
              false,
            );
            if (buf.length < 4 + len) break; // wait for the rest of the frame
            const body = buf.slice(4, 4 + len);
            buf = buf.slice(4 + len);
            if (phase === "hello") {
              if (new TextDecoder().decode(body).includes("hello_ok")) {
                phase = "rpc";
                socket.write(frameHeader);
                socket.write(frame);
              }
            } else {
              try {
                const plain = openBoxFrame(body, hostPubkey, clientKeypair.secretKey);
                const parsed = JSON.parse(new TextDecoder().decode(plain)) as {
                  result?: unknown;
                  error?: { code: string; message: string };
                };
                resolve(parsed);
              } catch {
                resolve(null);
              }
              socket.end();
              return;
            }
          }
        },
        error() {
          resolve(null);
        },
        close() {
          resolve(null);
        },
      },
    });
    setTimeout(() => {
      conn.then((s) => s.end()).catch(() => {});
      resolve(null);
    }, 3_000);
  });
}

describe("LanServer.handleEncryptedMessage — method and error branches", () => {
  let svr: LanServer | undefined;

  afterEach(async () => {
    await svr?.stop();
    svr = undefined;
  });

  async function startKnownPeerServer(
    onMsg: (method: string) => Promise<unknown>,
  ): Promise<{ hostKeypair: ReturnType<typeof generateBoxKeypair>; port: number }> {
    const hostKeypair = generateBoxKeypair();
    svr = new LanServer({
      bind: "127.0.0.1",
      port: 0,
      hostKeypair,
      onMessage: async (method) => onMsg(method),
      isKnownPeer: () => ({ peerId: "enc-peer", writeAllowed: true }),
      rateLimit: { checkAllowed: () => true, recordFailure: () => {}, recordSuccess: () => {} },
      pairing: {
        isOpen: () => false,
        consume: () => false,
        open: () => {},
        close: () => {},
        getExpiresAt: () => undefined,
      },
      registerPeer: () => "enc-peer",
    });
    await svr.start();
    return { hostKeypair, port: svr.listenAddr()!.port };
  }

  // line=229 block=20 branch=0: typeof msg.method !== "string" — method field absent
  test("closes without encrypted reply when decrypted message has no method field (line=229 branch=0)", async () => {
    const { hostKeypair, port } = await startKnownPeerServer(async () => ({}));
    const clientKeypair = generateBoxKeypair();
    // Send a valid encrypted frame but with no "method" key
    const result = await sendEncryptedPayload(
      hostKeypair.publicKey,
      clientKeypair,
      port,
      JSON.stringify({ id: 1, params: {} }),
    );
    // Server closes without replying — helper returns null
    expect(result).toBeNull();
  });

  // line=239 block=21 branch=1 + line=243 block=22 branch=0 + line=243 block=23 branch=0:
  // onMessage throws a generic Error (not LanError) WITH both code and message fields.
  test("returns generic error envelope with code+message when onMessage throws a coded Error (lines 239+243)", async () => {
    const hostKeypair = generateBoxKeypair();
    const err = Object.assign(new Error("something broke"), { code: "ERR_CUSTOM" });
    svr = new LanServer({
      bind: "127.0.0.1",
      port: 0,
      hostKeypair,
      onMessage: async () => {
        throw err;
      },
      isKnownPeer: () => ({ peerId: "enc-peer2", writeAllowed: true }),
      rateLimit: { checkAllowed: () => true, recordFailure: () => {}, recordSuccess: () => {} },
      pairing: {
        isOpen: () => false,
        consume: () => false,
        open: () => {},
        close: () => {},
        getExpiresAt: () => undefined,
      },
      registerPeer: () => "enc-peer2",
    });
    await svr.start();
    const port = svr.listenAddr()!.port;
    const clientKeypair = generateBoxKeypair();

    const reply = await sendEncryptedPayload(
      hostKeypair.publicKey,
      clientKeypair,
      port,
      JSON.stringify({ id: 1, method: "status.list", params: {} }),
    );
    expect(reply).not.toBeNull();
    expect(reply?.error?.code).toBe("ERR_CUSTOM");
    expect(reply?.error?.message).toBe("something broke");
  });

  // line=243 block=22 branch=1 + line=243 block=23 branch=1:
  // onMessage throws a generic Error (not LanError) WITHOUT code or message fields.
  // e.code ?? "ERR_INTERNAL" takes the right arm; e.message ?? String(err) takes the right arm.
  test("returns ERR_INTERNAL when onMessage throws an object without code or message (line=243 branches 1)", async () => {
    const hostKeypair = generateBoxKeypair();
    svr = new LanServer({
      bind: "127.0.0.1",
      port: 0,
      hostKeypair,
      onMessage: async () => {
        // throw a plain object: no .code, no .message
        throw {} as never;
      },
      isKnownPeer: () => ({ peerId: "enc-peer3", writeAllowed: true }),
      rateLimit: { checkAllowed: () => true, recordFailure: () => {}, recordSuccess: () => {} },
      pairing: {
        isOpen: () => false,
        consume: () => false,
        open: () => {},
        close: () => {},
        getExpiresAt: () => undefined,
      },
      registerPeer: () => "enc-peer3",
    });
    await svr.start();
    const port = svr.listenAddr()!.port;
    const clientKeypair = generateBoxKeypair();

    const reply = await sendEncryptedPayload(
      hostKeypair.publicKey,
      clientKeypair,
      port,
      JSON.stringify({ id: 2, method: "status.list", params: {} }),
    );
    expect(reply).not.toBeNull();
    expect(reply?.error?.code).toBe("ERR_INTERNAL");
    // e.message is undefined → String({}) = "[object Object]"
    expect(reply?.error?.message).toBe("[object Object]");
  });
});

// ---------------------------------------------------------------------------
// D-CANDIDATES (defensively-unreachable branches — Sub-project D)
// ---------------------------------------------------------------------------
//
// D1. line=207 block=18 branch=0 — handleEncryptedMessage guard
//     (!socket.data.peerPubkey || !socket.data.peerMatch) TRUE path.
//     The while-loop at line=112 only dispatches to handleEncryptedMessage when
//     socket.data.peerPubkey is truthy. Both peerPubkey and peerMatch are always
//     set together (lines 171-172 and 192-193), so this guard is structurally
//     unreachable without corrupting internal state.
//
