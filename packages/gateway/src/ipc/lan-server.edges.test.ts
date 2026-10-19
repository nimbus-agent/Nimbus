import { afterEach, describe, expect, test } from "bun:test";
import {
  fakePairing,
  V2ClientSession,
  v2Hello,
  v2PairRequest,
} from "../../test/helpers/lan-v2-test-client.ts";
import {
  type BoxKeypair,
  generateBoxKeypair,
  openSessionFrame,
  sealSessionFrame,
} from "./lan-crypto.ts";
import {
  type LanPeerMatch,
  LanServer,
  MAX_ENCRYPTED_FRAME,
  MAX_HANDSHAKE_FRAME,
  MAX_PENDING_BYTES,
} from "./lan-server.ts";
import {
  createQueuedSocketWriter,
  type QueuedSocketWriter,
} from "./server/queued-socket-writer.ts";

/**
 * Three refusals `lan-server.test.ts` does not reach, each asserted as "the server CLOSED the
 * connection, sent nothing beyond what the protocol had already answered, and never dispatched" —
 * not merely "no reply arrived", which a timeout would also satisfy:
 *   - a handshake frame that is not JSON,
 *   - after a good hello, a frame that does not decrypt under the session keys,
 *   - after a good hello, a frame that decrypts to something that is not JSON.
 * Plus the two guards no real socket can reach on demand (see the last describe block): the
 * pending-bytes bound and the no-session refusal of an encrypted frame.
 */

let svr: LanServer | undefined;
afterEach(async () => {
  await svr?.stop();
  svr = undefined;
});

function frame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

const NO_PAIRING = fakePairing(null);

async function startServer(): Promise<{
  port: number;
  hostKeypair: BoxKeypair;
  dispatched: string[];
  failures: string[];
}> {
  const hostKeypair = generateBoxKeypair();
  const dispatched: string[] = [];
  const failures: string[] = [];
  svr = new LanServer({
    bind: "127.0.0.1",
    port: 0,
    hostKeypair,
    onMessage: async (method) => {
      dispatched.push(method);
      return {};
    },
    // Every client is a known peer, so a hello always succeeds.
    isKnownPeer: () => ({ peerId: "edge-peer", writeAllowed: false }),
    registerPeer: () => "edge-peer",
    rateLimit: {
      checkAllowed: () => true,
      recordFailure: (ip) => failures.push(ip),
      recordSuccess: () => {},
    },
    pairing: NO_PAIRING,
  });
  await svr.start();
  const addr = svr.listenAddr();
  if (addr === undefined) throw new Error("server did not start");
  return { port: addr.port, hostKeypair, dispatched, failures };
}

type Outcome = { closedByServer: boolean; frames: string[] };

/**
 * Connect, send `first`, and — when `afterHello` is given — send its frame once the server's
 * `hello_ok` arrives. Resolves on close with every complete frame received (as text):
 * `closedByServer` is true only when the SERVER closed — false when this client ended the socket
 * itself after `endAfterFrames` frames, or when nothing closed within 3 s.
 */
function converse(
  port: number,
  first: Uint8Array,
  afterHello?: (hostPub: Uint8Array, helloOk: { server_eph?: string }) => Uint8Array,
  endAfterFrames?: number,
): Promise<Outcome> {
  return new Promise((resolve) => {
    const frames: string[] = [];
    let buf = new Uint8Array(0);
    let settled = false;
    let endedByClient = false;
    const settle = (o: Outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(o);
    };
    const timer = setTimeout(() => settle({ closedByServer: false, frames }), 3_000);
    void Bun.connect<undefined>({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(first);
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
            if (buf.length < 4 + len) return;
            const body = buf.slice(4, 4 + len);
            buf = buf.slice(4 + len);
            const text = new TextDecoder().decode(body);
            frames.push(text);
            if (afterHello !== undefined && frames.length === 1) {
              const reply = JSON.parse(text) as {
                kind?: string;
                host_pubkey?: string;
                server_eph?: string;
              };
              if (reply.kind === "hello_ok" && reply.host_pubkey !== undefined) {
                const hostPub = new Uint8Array(Buffer.from(reply.host_pubkey, "base64"));
                socket.write(frame(afterHello(hostPub, reply)));
              }
            }
            if (endAfterFrames !== undefined && frames.length >= endAfterFrames) {
              endedByClient = true;
              socket.end();
              return;
            }
          }
        },
        close() {
          settle({ closedByServer: !endedByClient, frames });
        },
        error() {
          settle({ closedByServer: !endedByClient, frames });
        },
      },
    });
  });
}

/** A v2 hello frame, plus a function that derives the client's session from the host's reply. */
function hello(client: BoxKeypair): {
  frame: Uint8Array;
  session: (
    hostPub: Uint8Array,
    helloOk: { server_eph?: string },
    as?: BoxKeypair,
  ) => V2ClientSession;
} {
  const { json, ephemeral } = v2Hello(client);
  return {
    frame: frame(new TextEncoder().encode(json)),
    session: (hostPub, helloOk, as = client) =>
      V2ClientSession.fromHelloOk(as, ephemeral, hostPub, helloOk),
  };
}

function helloFrame(client: BoxKeypair): Uint8Array {
  return hello(client).frame;
}

describe("LanServer — malformed frames are closed on, never dispatched", () => {
  test("a handshake frame that is not JSON: closed with no reply, nothing recorded", async () => {
    const { port, dispatched, failures } = await startServer();
    const out = await converse(port, frame(new TextEncoder().encode("{ not json")));
    expect(out).toEqual({ closedByServer: true, frames: [] });
    expect(dispatched).toEqual([]);
    expect(failures).toEqual([]);
  });

  test("after a good hello, a frame that does not decrypt is closed on", async () => {
    const { port, dispatched } = await startServer();
    const client = generateBoxKeypair();
    const stranger = generateBoxKeypair();
    const h = hello(client);
    const out = await converse(port, h.frame, (hostPub, helloOk) =>
      // Sealed under a session derived from a static key the host does not know the client by,
      // so `openSessionFrame` rejects it.
      h.session(hostPub, helloOk, stranger).seal({ id: 1, method: "index.search", params: {} }),
    );
    expect(out.closedByServer).toBe(true);
    expect(out.frames).toHaveLength(1);
    expect((JSON.parse(out.frames[0] ?? "{}") as { kind: string }).kind).toBe("hello_ok");
    expect(dispatched).toEqual([]);
  });

  test("after a good hello, a frame that decrypts to non-JSON is closed on", async () => {
    const { port, dispatched } = await startServer();
    const client = generateBoxKeypair();
    const h = hello(client);
    const out = await converse(port, h.frame, (hostPub, helloOk) =>
      sealSessionFrame(
        h.session(hostPub, helloOk).key,
        "client_to_host",
        0,
        new TextEncoder().encode("method=index.search"),
      ),
    );
    expect(out.closedByServer).toBe(true);
    expect(out.frames).toHaveLength(1);
    expect(dispatched).toEqual([]);
  });

  test("control: the same session with a well-formed frame IS dispatched and answered", async () => {
    // Without this, the two refusals above could pass because the session never worked at all.
    const { port, dispatched } = await startServer();
    const client = generateBoxKeypair();
    const h = hello(client);
    const out = await converse(
      port,
      h.frame,
      (hostPub, helloOk) =>
        h.session(hostPub, helloOk).seal({ id: 7, method: "index.search", params: {} }),
      2,
    );
    expect(dispatched).toEqual(["index.search"]);
    // hello_ok plus one encrypted reply (binary, so only its presence is checked here) — and the
    // server kept the session open: this client ended it.
    expect(out).toMatchObject({ closedByServer: false });
    expect(out.frames).toHaveLength(2);
  });
});

/**
 * Two guards driven through the private per-connection methods with a recording fake socket,
 * because a real socket cannot reach either on demand:
 *   - the pending-bytes bound fires only when ONE read overshoots a nearly-complete frame by more
 *     than 64 KiB, and how the OS splits a stream into reads is not something a test controls;
 *   - an encrypted frame with no authenticated session is impossible by construction (the
 *     handshake sets `peerPubkey` and `peerMatch` together), so the refusal is defence in depth —
 *     the one thing standing between such a frame and `checkLanMethodAllowed` (I5).
 * The server is never started: no port is bound, and nothing here touches the network.
 */
describe("LanServer — guards below the socket protocol", () => {
  type SessionData = {
    peerIp: string;
    buffer: Uint8Array;
    peerPubkey?: Uint8Array;
    peerMatch?: LanPeerMatch;
    session?: { key: Uint8Array; rxSeq: number; txSeq: number };
    /** Attached by `fakeSocket`, as the server's own `open` handler attaches one. */
    writer?: QueuedSocketWriter;
  };
  type FakeSocket = {
    data: SessionData;
    ended: number;
    written: Uint8Array[];
    end(): void;
    write(bytes: Uint8Array): number;
  };
  /** The private per-connection entry points, reached past `private` the way `cu-session.test.ts` does. */
  type Internals = {
    handleChunk(socket: FakeSocket, chunk: Uint8Array): Promise<void>;
    handleEncryptedMessage(socket: FakeSocket, frame: Uint8Array): Promise<void>;
  };

  /** `capacity` caps the bytes one `write` accepts, like a full kernel send buffer. */
  function fakeSocket(data: SessionData, capacity = Number.POSITIVE_INFINITY): FakeSocket {
    const s: FakeSocket = {
      data,
      ended: 0,
      written: [],
      end() {
        s.ended++;
      },
      write(bytes) {
        const n = Math.min(capacity, bytes.length);
        s.written.push(bytes.slice(0, n));
        return n;
      },
    };
    s.data.writer = createQueuedSocketWriter(s);
    return s;
  }

  const PEER: LanPeerMatch = { peerId: "guard-peer", writeAllowed: false };

  function unstartedServer() {
    const hostKeypair = generateBoxKeypair();
    const dispatched: string[] = [];
    const lookups: number[] = [];
    const failures: string[] = [];
    const server = new LanServer({
      bind: "127.0.0.1",
      port: 0,
      hostKeypair,
      onMessage: async (method) => {
        dispatched.push(method);
        return { ok: true };
      },
      isKnownPeer: (pub) => {
        lookups.push(pub.length);
        return PEER;
      },
      registerPeer: () => "guard-peer",
      rateLimit: {
        checkAllowed: () => true,
        recordFailure: (ip) => failures.push(ip),
        recordSuccess: () => {},
      },
      pairing: NO_PAIRING,
    });
    return {
      internals: server as unknown as Internals,
      hostKeypair,
      dispatched,
      lookups,
      failures,
    };
  }

  /** A header advertising `length` body bytes, followed by `bodyBytes` zero bytes. */
  function partialFrame(length: number, bodyBytes: number): Uint8Array {
    const out = new Uint8Array(4 + bodyBytes);
    new DataView(out.buffer).setUint32(0, length, false);
    return out;
  }

  // A rejection ends the socket only once its reply has drained, so input can still arrive in
  // between. A rejected session must parse nothing more: a hello that follows a refused pair must
  // never reach the peer lookup, whether it sits in the same chunk or arrives in a later one.
  test.each([
    ["the same chunk", true],
    ["a later chunk", false],
  ] as const)(
    "after a terminal rejection, a hello in %s is never parsed",
    async (_label, sameChunk) => {
      const { internals, lookups, failures } = unstartedServer();
      const client = generateBoxKeypair();
      // 3 bytes per write: the pair_err reply cannot drain, so the end stays pending.
      const sock = fakeSocket({ peerIp: "10.0.0.9", buffer: new Uint8Array(0) }, 3);
      // A v2 pair against a closed window: refused AND counted as a failure.
      const pair = frame(new TextEncoder().encode(v2PairRequest(client, "000000")));
      const hello = helloFrame(client);

      if (sameChunk) {
        const both = new Uint8Array(pair.length + hello.length);
        both.set(pair, 0);
        both.set(hello, pair.length);
        await internals.handleChunk(sock, both);
      } else {
        await internals.handleChunk(sock, pair);
        await internals.handleChunk(sock, hello);
      }

      // The refused pair was counted (positive control: the rejection path really ran) ...
      expect(failures).toEqual(["10.0.0.9"]);
      expect(sock.data.writer?.isEnding()).toBe(true);
      // ... and the hello behind it never reached the peer lookup.
      expect(lookups).toEqual([]);
    },
  );

  test("a chunk past MAX_PENDING_BYTES is refused before ANY frame in it is parsed", async () => {
    const { internals, lookups, failures } = unstartedServer();
    // A well-formed hello at the head of the burst: under the bound it would be answered. The
    // 0xFF filler reads as an over-cap length header straight after it, so a parse that DID start
    // stops at the second frame rather than walking four megabytes of zero-length frames.
    const burst = new Uint8Array(MAX_PENDING_BYTES + 1).fill(0xff);
    burst.set(helloFrame(generateBoxKeypair()), 0);
    const sock = fakeSocket({ peerIp: "10.0.0.9", buffer: new Uint8Array(0) });

    await internals.handleChunk(sock, burst);

    expect(sock.ended).toBe(1);
    expect(sock.written).toEqual([]);
    expect(lookups).toEqual([]); // the hello was never even read
    expect(sock.data.buffer).toHaveLength(0); // and nothing was buffered
    expect(sock.data.peerPubkey).toBeUndefined();
    // Not a handshake failure: nothing was parsed, so the peer is not rate-limited for it.
    expect(failures).toEqual([]);
  });

  test("the bound counts the bytes ALREADY pending, not only the new chunk", async () => {
    const { internals, dispatched } = unstartedServer();
    const client = generateBoxKeypair();
    // Mid-way through a maximum-size frame, one byte short of complete…
    const pending = partialFrame(MAX_ENCRYPTED_FRAME, MAX_ENCRYPTED_FRAME - 1);
    const sock = fakeSocket({
      peerIp: "10.0.0.9",
      buffer: pending,
      peerPubkey: client.publicKey,
      peerMatch: PEER,
      session: { key: new Uint8Array(32), rxSeq: 0, txSeq: 0 },
    });
    // …a read that overshoots the bound by one byte, though it is small on its own (~64 KiB).
    const chunk = new Uint8Array(MAX_PENDING_BYTES - pending.length + 1);
    expect(chunk.length).toBeLessThan(MAX_PENDING_BYTES / 64); // premise: the chunk ALONE is far under

    await internals.handleChunk(sock, chunk);

    expect(sock.ended).toBe(1);
    expect(sock.data.buffer).toBe(pending); // the same buffer, untouched — not merged
    expect(sock.written).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  test("a chunk exactly AT the bound is parsed: an over-cap handshake frame is then a counted failure", async () => {
    const { internals, lookups, failures } = unstartedServer();
    // Same size class as the refused burst, one byte smaller — so the bound is `>`, not `>=` —
    // and the frame it carries is over the pre-handshake cap, which IS a rate-limited failure.
    const burst = new Uint8Array(MAX_PENDING_BYTES);
    burst.set(partialFrame(MAX_HANDSHAKE_FRAME + 1, 0), 0);
    const sock = fakeSocket({ peerIp: "10.0.0.9", buffer: new Uint8Array(0) });

    await internals.handleChunk(sock, burst);

    expect(failures).toEqual(["10.0.0.9"]);
    expect(sock.ended).toBe(1);
    expect(sock.written).toEqual([]);
    expect(lookups).toEqual([]);
  });

  describe("an encrypted frame with no authenticated session is never dispatched", () => {
    const KEY = new Uint8Array(32).fill(9);
    const newSession = () => ({ key: KEY, rxSeq: 0, txSeq: 0 });
    function sealedRpc(): Uint8Array {
      return sealSessionFrame(
        KEY,
        "client_to_host",
        0,
        new TextEncoder().encode(JSON.stringify({ id: 1, method: "index.search", params: {} })),
      );
    }

    // Each row is missing exactly one of the three things a session needs, and every row's frame
    // WOULD open under the session key it does carry, so the refusal is the guard's alone.
    test.each([
      ["a peer key and session but no peer match", true, false, true],
      ["a peer match and session but no peer key", false, true, true],
      ["a peer key and match but no session key", true, true, false],
    ])(
      "%s: closed, nothing written, nothing dispatched",
      async (_label, withKey, withMatch, withSession) => {
        const { internals, dispatched } = unstartedServer();
        const client = generateBoxKeypair();
        const sock = fakeSocket({
          peerIp: "10.0.0.9",
          buffer: new Uint8Array(0),
          ...(withKey ? { peerPubkey: client.publicKey } : {}),
          ...(withMatch ? { peerMatch: PEER } : {}),
          ...(withSession ? { session: newSession() } : {}),
        });

        await internals.handleEncryptedMessage(sock, sealedRpc());

        expect(sock.ended).toBe(1);
        expect(sock.written).toEqual([]);
        expect(dispatched).toEqual([]);
      },
    );

    test("control: the same frame on a full session IS dispatched and answered", async () => {
      // Without this, the refusals above could pass because the frame itself never decrypted.
      const { internals, dispatched } = unstartedServer();
      const client = generateBoxKeypair();
      const sock = fakeSocket({
        peerIp: "10.0.0.9",
        buffer: new Uint8Array(0),
        peerPubkey: client.publicKey,
        peerMatch: PEER,
        session: newSession(),
      });

      await internals.handleEncryptedMessage(sock, sealedRpc());

      expect(dispatched).toEqual(["index.search"]);
      expect(sock.ended).toBe(0);
      // A 4-byte length header, then the sealed reply.
      expect(sock.written).toHaveLength(2);
      const reply = openSessionFrame(
        KEY,
        "host_to_client",
        0,
        sock.written[1] ?? new Uint8Array(0),
      );
      expect(JSON.parse(new TextDecoder().decode(reply))).toEqual({ id: 1, result: { ok: true } });
    });

    // Regression: Bun's raw socket write drops what the kernel does not accept. A reply larger than
    // the free send buffer used to lose its tail, so the peer's frame reader waited forever.
    test("a reply the socket cannot take in one write is finished on drain, never dropped", async () => {
      const { internals } = unstartedServer();
      const client = generateBoxKeypair();
      const sock = fakeSocket(
        {
          peerIp: "10.0.0.9",
          buffer: new Uint8Array(0),
          peerPubkey: client.publicKey,
          peerMatch: PEER,
          session: newSession(),
        },
        5,
      );

      await internals.handleEncryptedMessage(sock, sealedRpc());

      const writer = sock.data.writer;
      if (writer === undefined) throw new Error("fakeSocket attaches a writer");
      expect(writer.pendingBytes()).toBeGreaterThan(0);
      // What Bun's drain handler does each time the socket can take more.
      while (writer.pendingBytes() > 0) writer.flush();

      const all = new Uint8Array(sock.written.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of sock.written) {
        all.set(c, at);
        at += c.length;
      }
      const len = new DataView(all.buffer).getUint32(0, false);
      expect(all.length).toBe(4 + len);
      const reply = openSessionFrame(KEY, "host_to_client", 0, all.subarray(4));
      expect(JSON.parse(new TextDecoder().decode(reply))).toEqual({ id: 1, result: { ok: true } });
      expect(sock.ended).toBe(0);
    });
  });
});
