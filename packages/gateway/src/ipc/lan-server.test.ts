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
    await server.stop();
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
            const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            if (chunk.length >= 4) {
              const len = view.getUint32(0, false);
              const body = chunk.slice(4, 4 + len);
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
    expect(calls.length).toBe(0);
  });

  test("write method without write grant is rejected with ERR_LAN_WRITE_FORBIDDEN", async () => {
    const calls: string[] = [];
    const { hostKeypair, clientKeypair, port } = await makeGateServer(calls);
    const resp = await sendEncryptedRpc(hostKeypair.publicKey, clientKeypair, port, {
      id: 1,
      method: "engine.ask",
    });
    expect(resp.error?.message).toMatch(/ERR_LAN_WRITE_FORBIDDEN/);
    expect(calls.length).toBe(0);
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
