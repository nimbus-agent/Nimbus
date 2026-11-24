import { describe, expect, test } from "bun:test";
import { generateBoxKeypair } from "./lan-crypto.ts";
import { LanServer, MAX_HANDSHAKE_FRAME, MAX_PENDING_BYTES } from "./lan-server.ts";
import {
  createQueuedSocketWriter,
  type QueuedSocketWriter,
} from "./server/queued-socket-writer.ts";
import { fakePairing } from "./testing/pairing-fakes.ts";

/**
 * Guards below the socket protocol, driven through the private per-connection methods with a
 * recording fake socket, because a real socket cannot reach them on demand: the pending-bytes bound
 * fires only when ONE read overshoots a nearly-complete frame by more than 64 KiB, and how the OS
 * splits a stream into reads is not something a test controls; and a refused connection must parse
 * nothing more even when more bytes are already queued behind the refusal. The server is never
 * started: no port is bound, and nothing here touches the network.
 */

const NO_PAIRING = fakePairing();

function frame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

/** A frame of the removed v1 wire: JSON, so its first byte is `{`. */
function oldWireFrame(): Uint8Array {
  return frame(new TextEncoder().encode(JSON.stringify({ kind: "hello", client_pubkey: "AAAA" })));
}

type SessionData = {
  mode?: "unknown";
  peerIp: string;
  buffer: Uint8Array;
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
/** The private per-connection entry point, reached past `private`. */
type Internals = { handleChunk(socket: FakeSocket, chunk: Uint8Array): Promise<void> };

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

function unstartedServer() {
  const failures: string[] = [];
  const refused: string[] = [];
  const server = new LanServer({
    bind: "127.0.0.1",
    port: 0,
    hostKeypair: generateBoxKeypair(),
    onMessage: async () => ({ ok: true }),
    isKnownPeer: () => null,
    registerPeer: () => "guard-peer",
    rateLimit: {
      checkAllowed: () => true,
      recordFailure: (ip) => failures.push(ip),
      recordSuccess: () => {},
    },
    pairing: NO_PAIRING,
    onOldWireRefused: (ip) => refused.push(ip),
  });
  return { internals: server as unknown as Internals, failures, refused };
}

/** A header advertising `length` body bytes, followed by `bodyBytes` zero bytes. */
function partialFrame(length: number, bodyBytes: number): Uint8Array {
  const out = new Uint8Array(4 + bodyBytes);
  new DataView(out.buffer).setUint32(0, length, false);
  return out;
}

describe("LanServer - guards below the socket protocol", () => {
  // A refusal ends the socket only once its reply has drained, so input can still arrive in
  // between. A refused connection must parse nothing more: a second old-wire frame behind the
  // refused one must never be counted, whether it sits in the same chunk or arrives in a later one.
  test.each([
    ["the same chunk", true],
    ["a later chunk", false],
  ] as const)(
    "after a terminal refusal, another frame in %s is never parsed",
    async (_label, sameChunk) => {
      const { internals, failures, refused } = unstartedServer();
      // 3 bytes per write and a pending end: the socket stays in its ending state.
      const sock = fakeSocket(
        { mode: "unknown", peerIp: "10.0.0.9", buffer: new Uint8Array(0) },
        3,
      );
      const first = oldWireFrame();
      const second = oldWireFrame();

      if (sameChunk) {
        const both = new Uint8Array(first.length + second.length);
        both.set(first, 0);
        both.set(second, first.length);
        await internals.handleChunk(sock, both);
      } else {
        await internals.handleChunk(sock, first);
        await internals.handleChunk(sock, second);
      }

      // The first frame was counted and named (positive control: the refusal path really ran) ...
      expect(failures).toEqual(["10.0.0.9"]);
      expect(refused).toEqual(["10.0.0.9"]);
      expect(sock.data.writer?.isEnding()).toBe(true);
      // ... and the frame behind it was never parsed (a second parse would count it again).
    },
  );

  test("a chunk past MAX_PENDING_BYTES is refused before ANY frame in it is parsed", async () => {
    const { internals, failures, refused } = unstartedServer();
    // An old-wire frame at the head of the burst: under the bound it would be refused and named. The
    // 0xFF filler reads as an over-cap length header straight after it, so a parse that DID start
    // stops at the second frame rather than walking four megabytes of zero-length frames.
    const burst = new Uint8Array(MAX_PENDING_BYTES + 1).fill(0xff);
    burst.set(oldWireFrame(), 0);
    const sock = fakeSocket({ mode: "unknown", peerIp: "10.0.0.9", buffer: new Uint8Array(0) });

    await internals.handleChunk(sock, burst);

    expect(sock.ended).toBe(1);
    expect(sock.written).toEqual([]);
    expect(refused).toEqual([]); // the first frame was never even read
    expect(sock.data.buffer).toHaveLength(0); // and nothing was buffered
    // Not a handshake failure: nothing was parsed, so the peer is not rate-limited for it.
    expect(failures).toEqual([]);
  });

  test("the bound counts the bytes ALREADY pending, not only the new chunk", async () => {
    const { internals } = unstartedServer();
    // Mid-way through a large frame, one byte short of complete...
    const pending = partialFrame(4 * 1024 * 1024, 4 * 1024 * 1024 - 1);
    const sock = fakeSocket({ mode: "unknown", peerIp: "10.0.0.9", buffer: pending });
    // ...a read that overshoots the bound by one byte, though it is small on its own (~64 KiB).
    const chunk = new Uint8Array(MAX_PENDING_BYTES - pending.length + 1);
    expect(chunk.length).toBeLessThan(MAX_PENDING_BYTES / 64); // premise: the chunk ALONE is far under

    await internals.handleChunk(sock, chunk);

    expect(sock.ended).toBe(1);
    expect(sock.data.buffer).toBe(pending); // the same buffer, untouched, not merged
    expect(sock.written).toEqual([]);
  });

  test("a chunk exactly AT the bound is parsed: an over-cap handshake frame is then a counted failure", async () => {
    const { internals, failures } = unstartedServer();
    // Same size class as the refused burst, one byte smaller (so the bound is `>`, not `>=`), and
    // the frame it carries is over the pre-handshake cap, which IS a rate-limited failure.
    const burst = new Uint8Array(MAX_PENDING_BYTES);
    burst.set(partialFrame(MAX_HANDSHAKE_FRAME + 1, 0), 0);
    const sock = fakeSocket({ mode: "unknown", peerIp: "10.0.0.9", buffer: new Uint8Array(0) });

    await internals.handleChunk(sock, burst);

    expect(failures).toEqual(["10.0.0.9"]);
    expect(sock.ended).toBe(1);
    expect(sock.written).toEqual([]);
  });
});
