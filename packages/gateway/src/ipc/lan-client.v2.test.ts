import { afterEach, describe, expect, test } from "bun:test";
import { type LanLink, NO_REPLY_HINT, sendFederatedOverWire } from "./lan-client.ts";
import { type BoxKeypair, generateBoxKeypair } from "./lan-crypto.ts";
import type { LegacyServerContext } from "./lan-legacy.ts";
import { NOISE_OPEN_FAILED } from "./lan-noise.ts";
import { LanServer } from "./lan-server.ts";
import { openResponderHandshake } from "./lan-session.ts";
import {
  type StubServer,
  startLegacyOnlyServer,
  startStub,
} from "./testing/lan-v2.test-helpers.ts";

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
const noopPairing = {
  isOpen: () => false,
  consume: () => false,
  open: () => {},
  close: () => {},
  getExpiresAt: () => undefined,
};

function peers(): Peer {
  return { host: generateBoxKeypair(), client: generateBoxKeypair(), calls: [] };
}

function isClient(p: Peer, pubkey: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(pubkey), Buffer.from(p.client.publicKey)) === 0;
}

/** A current gateway: both wires. */
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

/** An old gateway: only the v1 handlers. */
function oldServer(p: Peer): StubServer {
  const ctx: LegacyServerContext = {
    hostKeypair: p.host,
    onMessage: async (method) => {
      p.calls.push(method);
      return { legacy: method };
    },
    isKnownPeer: (pk) =>
      isClient(p, pk) ? { peerId: "peer:c", writeAllowed: false, protoVersion: 1 } : null,
    registerPeer: () => "peer:c",
    rateLimit: noopRate,
    pairing: noopPairing,
    minProtocol: 1,
  };
  const s = startLegacyOnlyServer(ctx);
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
      minProtocol: 1,
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
      minProtocol: 1,
      onNegotiated: (v) => negotiated.push(v),
    });
    expect(out).toEqual({ ok: "federation.ping" });
    expect(negotiated).toEqual([2]);
  });

  test("known 1 without an onNegotiated callback still works", async () => {
    const p = peers();
    const port = await newServer(p);
    expect(await call(p, port, { known: 1, minProtocol: 1 })).toEqual({ ok: "federation.ping" });
  });

  test("known 1, min 1 against an OLD server: v2 sees the close, one legacy retry succeeds, no ratchet", async () => {
    const p = peers();
    const old = oldServer(p);
    const negotiated: number[] = [];
    const out = await call(p, old.port, {
      known: 1,
      minProtocol: 1,
      onNegotiated: (v) => negotiated.push(v),
    });
    expect(out).toEqual({ legacy: "federation.ping" });
    expect(negotiated).toEqual([]);
    expect(old.connections()).toBe(2); // the v2 attempt, then exactly one legacy connection
  });

  test("known 1, min 2 against an OLD server fails with the fixed hint and makes no legacy connection", async () => {
    const p = peers();
    const old = oldServer(p);
    await expect(call(p, old.port, { known: 1, minProtocol: 2 })).rejects.toThrow(NO_REPLY_HINT);
    expect(old.connections()).toBe(1);
    expect(p.calls).toEqual([]);
  });

  test("known 2 against an OLD server never falls back (FS-A3)", async () => {
    const p = peers();
    const old = oldServer(p);
    await expect(call(p, old.port, { known: 2, minProtocol: 1 })).rejects.toThrow(NO_REPLY_HINT);
    expect(old.connections()).toBe(1);
    expect(p.calls).toEqual([]);
  });

  test("known 2 against a server that kills the v2 attempt mid-handshake does not fall back", async () => {
    const p = peers();
    const killer = stub((_f, socket) => socket.end());
    await expect(call(p, killer.port, { known: 2, minProtocol: 1 })).rejects.toThrow(NO_REPLY_HINT);
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
        { known: 2, minProtocol: 1 },
      ),
    ).rejects.toThrow("run `nimbus team pair` again");
  });

  test("a message 2 that does not open is not a no-reply: no fallback, fixed error", async () => {
    const p = peers();
    const garbage = stub((_f, socket) => socket.write(new Uint8Array(48).fill(7)));
    await expect(call(p, garbage.port, { known: 1, minProtocol: 1 })).rejects.toThrow(
      NOISE_OPEN_FAILED,
    );
    expect(garbage.connections()).toBe(1);
  });

  test("a bad record after the handshake never falls back", async () => {
    const p = peers();
    const rogue = stub((frame, socket) => {
      const hs = openResponderHandshake(frame, { s: p.host });
      const { message2 } = hs.accept();
      socket.write(message2);
      socket.write(new Uint8Array(64).fill(1)); // not a record of this session
    });
    await expect(call(p, rogue.port, { known: 1, minProtocol: 1 })).rejects.toThrow(
      NOISE_OPEN_FAILED,
    );
    expect(rogue.connections()).toBe(1);
  });

  test("a peer that closes after the handshake is a mid-exchange close, not a fallback", async () => {
    const p = peers();
    const rude = stub((frame, socket) => {
      socket.write(openResponderHandshake(frame, { s: p.host }).accept().message2);
      socket.end();
    });
    await expect(call(p, rude.port, { known: 1, minProtocol: 1 })).rejects.toThrow(
      "lan-client: connection closed mid-exchange",
    );
    expect(rude.connections()).toBe(1);
  });

  test("a silent peer: known 2 times out in the handshake; known 1 retries v1 once and times out again", async () => {
    const p = peers();
    const silent = stub(() => {});
    await expect(call(p, silent.port, { known: 2, minProtocol: 1 }, "m", 150)).rejects.toThrow(
      "lan-client: handshake timeout",
    );
    expect(silent.connections()).toBe(1);
    await expect(call(p, silent.port, { known: 1, minProtocol: 1 }, "m", 150)).rejects.toThrow(
      "lan-client: rpc timeout",
    );
    expect(silent.connections()).toBe(3); // 1 earlier + the v2 attempt + one legacy retry
  });

  test("a peer that answers the handshake and then never replies: rpc timeout, no fallback", async () => {
    const p = peers();
    const slow = stub((frame, socket) => {
      socket.write(openResponderHandshake(frame, { s: p.host }).accept().message2);
    });
    await expect(call(p, slow.port, { known: 1, minProtocol: 1 }, "m", 200)).rejects.toThrow(
      "lan-client: rpc timeout",
    );
    expect(slow.connections()).toBe(1);
  });

  test("a peer error reply is thrown with its code and message", async () => {
    const p = peers();
    const port = await newServer(p);
    await expect(call(p, port, { known: 2, minProtocol: 1 }, "federation.boom")).rejects.toThrow(
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
    await expect(call(p, hs.port, { known: 2, minProtocol: 1 })).rejects.toThrow(
      "lan-client: peer error",
    );
  });

  test("a failing onNegotiated (the ratchet could not be saved) fails the call", async () => {
    const p = peers();
    const port = await newServer(p);
    await expect(
      call(p, port, {
        known: 1,
        minProtocol: 1,
        onNegotiated: () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");
  });

  test("a refused connection rejects without a fallback attempt", async () => {
    const p = peers();
    const s = stub(() => {});
    const { port } = s;
    s.stop();
    await expect(call(p, port, { known: 1, minProtocol: 1 })).rejects.toThrow();
  });

  test("a declared frame over the record cap from the server rejects", async () => {
    const p = peers();
    const s = stub((_f, socket) => {
      socket.write(new Uint8Array(70_000));
    });
    await expect(call(p, s.port, { known: 2, minProtocol: 1 })).rejects.toThrow(
      "lan-client: oversized frame",
    );
  });

  test("an invalid pinned key (all zero) rejects before any connection", async () => {
    const p = peers();
    const s = stub(() => {});
    await expect(
      sendFederatedOverWire("127.0.0.1", s.port, p.client, new Uint8Array(32), "m", {}, 500, {
        known: 2,
        minProtocol: 1,
      }),
    ).rejects.toThrow();
    expect(s.connections()).toBe(0);
  });
});
