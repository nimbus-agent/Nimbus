import { afterEach, describe, expect, test } from "bun:test";
import { type LanLink, NO_REPLY_HINT, sendFederatedOverWire } from "./lan-client.ts";
import { type BoxKeypair, generateBoxKeypair } from "./lan-crypto.ts";
import { NOISE_OPEN_FAILED } from "./lan-noise.ts";
import { LanServer } from "./lan-server.ts";
import { openResponderHandshake } from "./lan-session.ts";
import { type StubServer, startOldWireServer, startStub } from "./testing/lan-v2.test-helpers.ts";
import { fakePairing } from "./testing/pairing-fakes.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Peer {
  host: BoxKeypair;
  client: BoxKeypair;
  calls: string[];
}

const noopRate = { checkAllowed: () => true, recordFailure: () => {}, recordSuccess: () => {} };
const noopPairing = fakePairing();

function peers(): Peer {
  return { host: generateBoxKeypair(), client: generateBoxKeypair(), calls: [] };
}

function isClient(p: Peer, pubkey: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(pubkey), Buffer.from(p.client.publicKey)) === 0;
}

/** A current gateway. */
async function newServer(p: Peer) {
  const server = new LanServer({
    bind: "127.0.0.1",
    port: 0,
    hostKeypair: p.host,
    onMessage: async (method) => {
      p.calls.push(method);
      if (method === "federation.boom") {
        throw Object.assign(new Error("nope"), { code: "ERR_X" });
      }
      return { ok: method };
    },
    isKnownPeer: (pk) =>
      isClient(p, pk) ? { peerId: "peer:c", writeAllowed: false, protoVersion: 1 } : null,
    registerPeer: () => "peer:c",
    rateLimit: noopRate,
    pairing: noopPairing,
  });
  await server.start();
  cleanups.push(() => server.stop());
  return (server.listenAddr() as { port: number }).port;
}

/** A gateway from before LAN forward secrecy: it speaks only the removed JSON wire. */
function oldServer(): StubServer {
  const s = startOldWireServer();
  cleanups.push(() => s.stop());
  return s;
}

function stub(...args: Parameters<typeof startStub>): StubServer {
  const s = startStub(...args);
  cleanups.push(() => s.stop());
  return s;
}

function call(p: Peer, port: number, link: LanLink, method = "federation.ping", timeoutMs = 2000) {
  return sendFederatedOverWire(
    "127.0.0.1",
    port,
    p.client,
    p.host.publicKey,
    method,
    { a: 1 },
    timeoutMs,
    link,
  );
}

describe("sendFederatedOverWire - the v2 front", () => {
  test("known 2 completes an IK session and returns the result; onNegotiated is not called for a known-2 peer", async () => {
    const p = peers();
    const port = await newServer(p);
    const negotiated: number[] = [];
    const out = await call(p, port, {
      known: 2,
      onNegotiated: (v) => negotiated.push(v),
    });
    expect(out).toEqual({ ok: "federation.ping" });
    expect(negotiated).toEqual([]);
  });

  test("known 1 against a current server negotiates v2 and calls onNegotiated(2) once", async () => {
    const p = peers();
    const port = await newServer(p);
    const negotiated: number[] = [];
    const out = await call(p, port, {
      known: 1,
      onNegotiated: (v) => negotiated.push(v),
    });
    expect(out).toEqual({ ok: "federation.ping" });
    expect(negotiated).toEqual([2]);
  });

  test("known 1 without an onNegotiated callback still works", async () => {
    const p = peers();
    const port = await newServer(p);
    expect(await call(p, port, { known: 1 })).toEqual({ ok: "federation.ping" });
  });

  test("known 1 against an OLD server fails with the upgrade hint and makes no second connection", async () => {
    const p = peers();
    const old = oldServer();
    const negotiated: number[] = [];
    await expect(
      call(p, old.port, { known: 1, onNegotiated: (v) => negotiated.push(v) }),
    ).rejects.toThrow(NO_REPLY_HINT);
    expect(negotiated).toEqual([]);
    expect(old.connections()).toBe(1);
    expect(p.calls).toEqual([]);
  });

  test("known 2 against an OLD server fails the same way (FS3: no wire to fall back to)", async () => {
    const p = peers();
    const old = oldServer();
    await expect(call(p, old.port, { known: 2 })).rejects.toThrow(NO_REPLY_HINT);
    expect(old.connections()).toBe(1);
    expect(p.calls).toEqual([]);
  });

  test("the no-reply error tells the owner to upgrade the peer", () => {
    expect(NO_REPLY_HINT).toContain("upgrade that peer");
    expect(NO_REPLY_HINT).toContain("nimbus team pair");
  });

  test("known 2 against a server that kills the v2 attempt mid-handshake does not retry", async () => {
    const p = peers();
    const killer = stub((_f, socket) => socket.end());
    await expect(call(p, killer.port, { known: 2 })).rejects.toThrow(NO_REPLY_HINT);
    expect(killer.connections()).toBe(1);
  });

  test("a wrong pin makes message 1 unreadable: the call fails with the re-pair hint", async () => {
    const p = peers();
    const port = await newServer(p);
    await expect(
      sendFederatedOverWire(
        "127.0.0.1",
        port,
        p.client,
        generateBoxKeypair().publicKey,
        "federation.ping",
        {},
        2000,
        { known: 2 },
      ),
    ).rejects.toThrow("run `nimbus team pair` again");
  });

  test("a message 2 that does not open is not a no-reply: fixed error", async () => {
    const p = peers();
    const garbage = stub((_f, socket) => socket.write(new Uint8Array(48).fill(7)));
    await expect(call(p, garbage.port, { known: 1 })).rejects.toThrow(NOISE_OPEN_FAILED);
    expect(garbage.connections()).toBe(1);
  });

  test("a bad record after the handshake is a plain failure", async () => {
    const p = peers();
    const rogue = stub((frame, socket) => {
      const hs = openResponderHandshake(frame, { s: p.host });
      const { message2 } = hs.accept();
      socket.write(message2);
      socket.write(new Uint8Array(64).fill(1)); // not a record of this session
    });
    await expect(call(p, rogue.port, { known: 1 })).rejects.toThrow(NOISE_OPEN_FAILED);
    expect(rogue.connections()).toBe(1);
  });

  test("a peer that closes after the handshake is a mid-exchange close, not a retry", async () => {
    const p = peers();
    const rude = stub((frame, socket) => {
      socket.write(openResponderHandshake(frame, { s: p.host }).accept().message2);
      socket.end();
    });
    await expect(call(p, rude.port, { known: 1 })).rejects.toThrow(
      "lan-client: connection closed mid-exchange",
    );
    expect(rude.connections()).toBe(1);
  });

  test("a silent peer times out in the handshake, whatever it is recorded at, with one connection each", async () => {
    const p = peers();
    const silent = stub(() => {});
    for (const known of [2, 1] as const) {
      await expect(call(p, silent.port, { known }, "m", 150)).rejects.toThrow(
        "lan-client: handshake timeout",
      );
    }
    expect(silent.connections()).toBe(2);
  });

  test("on timeout the client closes its socket instead of leaving it open", async () => {
    const p = peers();
    const slow = stub((frame, socket) => {
      socket.write(openResponderHandshake(frame, { s: p.host }).accept().message2);
    });
    await expect(call(p, slow.port, { known: 2 }, "m", 150)).rejects.toThrow(
      "lan-client: rpc timeout",
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(slow.closedByClient()).toBe(1);
  });

  test("a message 2 that arrives after the timeout does not make the client send its request", async () => {
    const p = peers();
    const frames: number[] = [];
    const late = stub((frame, socket) => {
      frames.push(frame.length);
      if (frames.length > 1) return; // anything after the first frame is the request: must not come
      const accepted = openResponderHandshake(frame, { s: p.host }).accept();
      setTimeout(() => socket.write(accepted.message2), 300);
    });
    await expect(call(p, late.port, { known: 2 }, "m", 100)).rejects.toThrow(
      "lan-client: handshake timeout",
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(frames).toHaveLength(1);
  });

  test("a peer that answers the handshake and then never replies: rpc timeout", async () => {
    const p = peers();
    const slow = stub((frame, socket) => {
      socket.write(openResponderHandshake(frame, { s: p.host }).accept().message2);
    });
    await expect(call(p, slow.port, { known: 1 }, "m", 200)).rejects.toThrow(
      "lan-client: rpc timeout",
    );
    expect(slow.connections()).toBe(1);
  });

  // Regression (carried from the old exchangeOneFrame suite): Bun's raw socket write sends only what the
  // kernel accepts and drops the rest, so a request larger than the free send buffer reached the peer
  // truncated and never parsed. 3 MiB is far past any loopback buffer and under the 4 MiB message cap.
  test("a request far larger than the send buffer reaches the peer whole", async () => {
    const p = peers();
    let seen = 0;
    const server = new LanServer({
      bind: "127.0.0.1",
      port: 0,
      hostKeypair: p.host,
      onMessage: async (_m, params) => {
        seen = (params as { blob: string }).blob.length;
        return { ok: true };
      },
      isKnownPeer: (pk) =>
        isClient(p, pk) ? { peerId: "peer:c", writeAllowed: false, protoVersion: 2 } : null,
      registerPeer: () => "peer:c",
      rateLimit: noopRate,
      pairing: noopPairing,
    });
    await server.start();
    cleanups.push(() => server.stop());
    const port = (server.listenAddr() as { port: number }).port;
    const blob = "x".repeat(3 * 1024 * 1024);
    const out = await sendFederatedOverWire(
      "127.0.0.1",
      port,
      p.client,
      p.host.publicKey,
      "federation.ping",
      { blob },
      20_000,
      { known: 2 },
    );
    expect(out).toEqual({ ok: true });
    expect(seen).toBe(blob.length);
  }, 30_000);

  test("a peer error reply is thrown with its code and message", async () => {
    const p = peers();
    const port = await newServer(p);
    await expect(call(p, port, { known: 2 }, "federation.boom")).rejects.toThrow(
      "lan-client: peer error ERR_X nope",
    );
  });

  test("an error reply with no code or message still throws", async () => {
    const p = peers();
    const hs = stub((frame, socket) => {
      const accepted = openResponderHandshake(frame, { s: p.host }).accept();
      socket.write(accepted.message2);
      for (const r of accepted.session.sealMessage(
        new TextEncoder().encode(JSON.stringify({ id: 1, error: {} })),
      )) {
        socket.write(r);
      }
    });
    await expect(call(p, hs.port, { known: 2 })).rejects.toThrow("lan-client: peer error");
  });

  test("a failing onNegotiated (the ratchet could not be saved) fails the call", async () => {
    const p = peers();
    const port = await newServer(p);
    await expect(
      call(p, port, {
        known: 1,
        onNegotiated: () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");
  });

  test("a refused connection rejects without a second attempt", async () => {
    const p = peers();
    const s = stub(() => {});
    const { port } = s;
    s.stop();
    await expect(call(p, port, { known: 1 })).rejects.toThrow();
  });

  test("a declared frame over the record cap from the server rejects", async () => {
    const p = peers();
    const s = stub((_f, socket) => {
      socket.write(new Uint8Array(70_000));
    });
    await expect(call(p, s.port, { known: 2 })).rejects.toThrow("lan-client: oversized frame");
  });

  test("an invalid pinned key (all zero) rejects before any connection", async () => {
    const p = peers();
    const s = stub(() => {});
    await expect(
      sendFederatedOverWire("127.0.0.1", s.port, p.client, new Uint8Array(32), "m", {}, 500, {
        known: 2,
      }),
    ).rejects.toThrow();
    expect(s.connections()).toBe(0);
  });
});
