import { afterEach, describe, expect, test } from "bun:test";
import type { Socket, TCPSocketListener } from "bun";
import { exchangeOneFrame, sendFederatedOverWire } from "./lan-client.ts";
import { generateBoxKeypair } from "./lan-crypto.ts";
import { MAX_HANDSHAKE_FRAME } from "./lan-server.ts";

/**
 * Two client-side frame paths `lan-client.test.ts` does not reach: a reply frame that is still
 * incomplete when the peer closes (the reader yields nothing, and the close — not a timeout —
 * settles the exchange), and a hello reply that is not JSON at all.
 */

let server: TCPSocketListener<undefined> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function frame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

/**
 * A loopback listener that reassembles the client's length-prefixed frames and calls `onFrame`
 * once per COMPLETE frame, with its 1-based ordinal — so a frame split across TCP chunks is still
 * counted once.
 */
function listen(onFrame: (socket: Socket<undefined>, ordinal: number) => void): number {
  let buf = new Uint8Array(0);
  let ordinal = 0;
  server = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, chunk) {
        const merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf, 0);
        merged.set(chunk, buf.length);
        buf = merged;
        while (buf.length >= 4) {
          const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, false);
          if (buf.length < 4 + len) return;
          buf = buf.slice(4 + len);
          ordinal++;
          onFrame(socket, ordinal);
        }
      },
      open() {},
      close() {},
      error() {},
    },
  });
  return server.port;
}

describe("exchangeOneFrame", () => {
  test("a reply still incomplete when the peer closes is 'closed without reply', not a timeout", async () => {
    const port = listen((socket) => {
      // Advertise 10 body bytes, deliver 3, then close: the reader has a partial frame and
      // yields nothing, so only the close can settle the exchange.
      const partial = frame(new Uint8Array(10)).slice(0, 4 + 3);
      socket.write(partial);
      socket.end();
    });
    const started = performance.now();
    await expect(
      exchangeOneFrame(
        "127.0.0.1",
        port,
        (s) => {
          s.write(frame(new TextEncoder().encode("{}")));
        },
        MAX_HANDSHAKE_FRAME,
        5_000,
      ),
    ).rejects.toThrow("lan-client: connection closed without reply");
    // Settled by the close, well inside the 5 s timeout it would otherwise have hit.
    expect(performance.now() - started).toBeLessThan(4_000);
  });
});

describe("sendFederatedOverWire — the hello reply", () => {
  test("a hello reply that is not JSON ends the exchange instead of reaching the RPC phase", async () => {
    let frames = 0;
    const port = listen((socket, ordinal) => {
      frames = ordinal;
      if (ordinal > 1) return; // an RPC frame must never arrive
      socket.write(frame(new TextEncoder().encode("<<not json>>")));
    });
    const kp = generateBoxKeypair();
    const peer = generateBoxKeypair();
    const err: unknown = await sendFederatedOverWire(
      "127.0.0.1",
      port,
      kp,
      peer.publicKey,
      "federation.query",
      {},
      5_000,
    ).then(
      (v) => new Error(`resolved: ${JSON.stringify(v)}`),
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    // The bad reply's own error, not the generic close: the client settles BEFORE ending the
    // socket, because Bun fires close() synchronously inside end(). Not the 5 s timeout either.
    expect((err as Error).message).toBe("lan-client: bad hello reply");
    expect(frames).toBe(1);
  });
});
