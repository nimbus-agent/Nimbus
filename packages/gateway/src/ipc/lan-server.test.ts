import { afterEach, describe, expect, test } from "bun:test";
import { processListeners } from "../locality/listener-registry.ts";
import { generateBoxKeypair } from "./lan-crypto.ts";
import { LanServer } from "./lan-server.ts";
import { fakePairing } from "./testing/pairing-fakes.ts";

let server: LanServer | undefined;

function makeServer(): LanServer {
  return new LanServer({
    bind: "127.0.0.1",
    port: 0,
    hostKeypair: generateBoxKeypair(),
    onMessage: async () => ({}),
    isKnownPeer: () => null,
    rateLimit: { checkAllowed: () => true, recordFailure: () => {}, recordSuccess: () => {} },
    pairing: fakePairing(),
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

  test("registers a 'lan' listener in the live registry while open, gone after stop", async () => {
    server = makeServer();
    await server.start();
    const addr = server.listenAddr();
    expect(addr).toBeTruthy();
    const address = `${addr?.host}:${String(addr?.port)}`;
    // Filtered by OUR OWN address, since processListeners is process-global.
    expect(processListeners.live().filter((l) => l.address === address)).toEqual([
      { name: "lan", address, loopback: true },
    ]);
    await server.stop();
    expect(processListeners.live().some((l) => l.address === address)).toBe(false);
    server = undefined;
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
    pairing: fakePairing(),
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

  test("permits a small declared length (an incomplete first frame) without closing", async () => {
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
