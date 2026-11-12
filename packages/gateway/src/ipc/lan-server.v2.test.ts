import { afterEach, describe, expect, test } from "bun:test";
import { type BoxKeypair, generateBoxKeypair } from "./lan-crypto.ts";
import { LanServer, type LanServerOptions } from "./lan-server.ts";
import {
  createInitiatorHandshake,
  encodeFirstFrame,
  MAX_RECORD_FRAME,
  REKEY_EVERY_RECORDS,
} from "./lan-session.ts";
import type { LanPeerMatch } from "./lan-wire.ts";
import {
  connectRaw,
  connectV2,
  readV2Reply,
  sendV2Request,
} from "./testing/lan-v2.test-helpers.ts";

interface Harness {
  server: LanServer;
  port: number;
  host: BoxKeypair;
  client: BoxKeypair;
  failures: string[];
  messages: Array<{ method: string; params: unknown; peer: LanPeerMatch }>;
  negotiated: Uint8Array[];
  lookups: Uint8Array[];
  consumed: string[];
}

let current: LanServer | undefined;
afterEach(async () => {
  await current?.stop();
  current = undefined;
});

async function start(
  over: Partial<LanServerOptions> & {
    protoVersion?: 1 | 2;
    allowed?: boolean;
    known?: boolean;
    pairingOpen?: boolean;
    reply?: unknown;
  } = {},
): Promise<Harness> {
  const host = generateBoxKeypair();
  const client = generateBoxKeypair();
  const failures: string[] = [];
  const messages: Harness["messages"] = [];
  const negotiated: Uint8Array[] = [];
  const lookups: Uint8Array[] = [];
  const consumed: string[] = [];
  const { protoVersion, allowed, known, pairingOpen, reply, ...opts } = over;
  const server = new LanServer({
    bind: "127.0.0.1",
    port: 0,
    hostKeypair: host,
    onMessage: async (method, params, peer) => {
      messages.push({ method, params, peer });
      return reply ?? { echoed: method };
    },
    isKnownPeer: (pubkey) => {
      lookups.push(pubkey);
      if (known === false) return null;
      return Buffer.compare(Buffer.from(pubkey), Buffer.from(client.publicKey)) === 0
        ? { peerId: "peer:test", writeAllowed: false, protoVersion: protoVersion ?? 1 }
        : null;
    },
    onPeerNegotiated: (pubkey) => {
      negotiated.push(pubkey);
    },
    registerPeer: () => "peer:paired",
    rateLimit: {
      checkAllowed: () => allowed !== false,
      recordFailure: (ip) => failures.push(ip),
      recordSuccess: () => {},
    },
    pairing: {
      isOpen: () => pairingOpen === true,
      consume: (code) => {
        consumed.push(code);
        return true;
      },
      open: () => {},
      close: () => {},
      getExpiresAt: () => undefined,
    },
    ...opts,
  });
  await server.start();
  current = server;
  const addr = server.listenAddr();
  if (!addr) throw new Error("no listen address");
  return {
    server,
    port: addr.port,
    host,
    client,
    failures,
    messages,
    negotiated,
    lookups,
    consumed,
  };
}

const legacyFrame = (obj: object): Uint8Array => new TextEncoder().encode(JSON.stringify(obj));
const b64 = (k: Uint8Array): string => Buffer.from(k).toString("base64");

describe("LanServer v2 - the handshake", () => {
  test("a known peer completes IK, sends a request and gets the reply; the ratchet is written once", async () => {
    const h = await start();
    const x = await connectV2(h.port, h.client, h.host.publicKey);
    sendV2Request(x, { id: 7, method: "federation.ping", params: { a: 1 } });
    const reply = await readV2Reply(x);
    expect(reply).toEqual({ id: 7, result: { echoed: "federation.ping" } });
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]?.params).toEqual({ a: 1 });
    // The store said 1; after the handshake the session's match says 2 and the ratchet was written.
    expect(h.messages[0]?.peer).toEqual({
      peerId: "peer:test",
      writeAllowed: false,
      protoVersion: 2,
    });
    expect(h.negotiated).toHaveLength(1);
    expect(h.negotiated[0]).toEqual(h.client.publicKey);
    expect(h.failures).toEqual([]);
    x.conn.close();
  });

  test("a peer already at protocol 2 is not written again, and the match is passed as the store gave it", async () => {
    const h = await start({ protoVersion: 2 });
    const x = await connectV2(h.port, h.client, h.host.publicKey);
    sendV2Request(x, { id: 1, method: "federation.ping" });
    await readV2Reply(x);
    expect(h.negotiated).toEqual([]);
    expect(h.messages[0]?.peer.protoVersion).toBe(2);
    x.conn.close();
  });

  test("several requests on one session, and a request larger than one record, round-trip", async () => {
    const big = "x".repeat(200_000);
    const h = await start({ reply: { big } });
    const x = await connectV2(h.port, h.client, h.host.publicKey);
    sendV2Request(x, { id: 1, method: "federation.ping", params: { big } });
    expect((await readV2Reply(x)).result).toEqual({ big });
    sendV2Request(x, { id: 2, method: "federation.ping", params: {} });
    expect((await readV2Reply(x)).id).toBe(2);
    expect((h.messages[0]?.params as { big: string } | undefined)?.big).toHaveLength(200_000);
    x.conn.close();
  });

  test("a locked-out address gets no bytes, no lookup and no failure count", async () => {
    const h = await start({ allowed: false });
    // A perfectly valid first frame: the limiter says no before it is even opened.
    const x = await connectV2(h.port, h.client, h.host.publicKey).catch(() => undefined);
    expect(x).toBeUndefined();
    expect(h.lookups).toEqual([]);
    expect(h.failures).toEqual([]);
  });

  test("a message 1 that does not open: closed, no reply, one failure", async () => {
    const h = await start();
    const conn = await connectRaw(h.port);
    const hs = createInitiatorHandshake({
      s: h.client,
      rs: h.host.publicKey,
    });
    const bad = hs.firstFrameBody.slice();
    bad[60] = (bad[60] as number) ^ 1;
    conn.writeFrame(bad);
    expect(await conn.closed()).toBe(true);
    expect(conn.received()).toHaveLength(0);
    expect(h.failures).toHaveLength(1);
    expect(h.lookups).toEqual([]);
  });

  test("a message 1 encrypted to a stale pinned key looks the same: closed, no reply, counted", async () => {
    const h = await start();
    const conn = await connectRaw(h.port);
    const hs = createInitiatorHandshake({ s: h.client, rs: generateBoxKeypair().publicKey });
    conn.writeFrame(hs.firstFrameBody);
    expect(await conn.closed()).toBe(true);
    expect(conn.received()).toHaveLength(0);
    expect(h.failures).toHaveLength(1);
  });

  test("an unknown initiator: closed, no reply, counted, and no ratchet write", async () => {
    const h = await start({ known: false });
    const conn = await connectRaw(h.port);
    const hs = createInitiatorHandshake({ s: generateBoxKeypair(), rs: h.host.publicKey });
    conn.writeFrame(hs.firstFrameBody);
    expect(await conn.closed()).toBe(true);
    expect(conn.received()).toHaveLength(0);
    expect(h.failures).toHaveLength(1);
    expect(h.lookups).toHaveLength(1);
    expect(h.negotiated).toEqual([]);
  });

  test("a ratchet write that fails refuses the session before message 2", async () => {
    const h = await start({
      onPeerNegotiated: () => {
        throw new Error("disk full");
      },
    });
    const conn = await connectRaw(h.port);
    conn.writeFrame(createInitiatorHandshake({ s: h.client, rs: h.host.publicKey }).firstFrameBody);
    expect(await conn.closed()).toBe(true);
    expect(conn.received()).toHaveLength(0);
  });
});

describe("LanServer v2 - replay (FS-A2, server half)", () => {
  test("a replayed message 1 draws a fresh message 2; the replayed request record never executes", async () => {
    const h = await start();
    // Record a whole session.
    const first = await connectV2(h.port, h.client, h.host.publicKey);
    const recordedRecords = sendV2Request(first, { id: 1, method: "federation.ping" });
    await readV2Reply(first);
    first.conn.close();
    expect(h.messages).toHaveLength(1);
    const failuresBefore = h.failures.length;

    // Replay message 1 and then the recorded request record on a new connection.
    const conn = await connectRaw(h.port);
    conn.writeFrame(first.firstFrameBody);
    const message2 = await conn.nextFrame();
    expect(message2).toBeDefined(); // the server CAN open message 1 and answers
    expect(Buffer.from(message2 as Uint8Array).equals(Buffer.from(first.message2))).toBe(false);
    for (const r of recordedRecords) conn.writeFrame(r);
    expect(await conn.closed()).toBe(true);
    expect(conn.received().length).toBe(4 + (message2 as Uint8Array).length); // zero further bytes
    expect(h.messages).toHaveLength(1); // onMessage NOT called again
    expect(h.failures.length).toBe(failuresBefore + 1); // D-FS-14
  });
});

describe("LanServer v2 - the method denylist still runs before onMessage", () => {
  test("a forbidden method and an ungranted write are refused with the v1 error codes", async () => {
    const h = await start();
    const x = await connectV2(h.port, h.client, h.host.publicKey);
    sendV2Request(x, { id: 1, method: "vault.list" });
    expect((await readV2Reply(x)).error?.message).toMatch(/ERR_METHOD_NOT_ALLOWED/);
    sendV2Request(x, { id: 2, method: "engine.ask" });
    expect((await readV2Reply(x)).error?.message).toMatch(/ERR_LAN_WRITE_FORBIDDEN/);
    expect(h.messages).toHaveLength(0);
    x.conn.close();
  });

  test("an onMessage that throws a plain error is reported with its code, one that throws a string as ERR_INTERNAL", async () => {
    let n = 0;
    const h = await start({
      onMessage: async () => {
        n += 1;
        if (n === 1) throw Object.assign(new Error("nope"), { code: "ERR_X" });
        throw "plain";
      },
    });
    const x = await connectV2(h.port, h.client, h.host.publicKey);
    sendV2Request(x, { id: 1, method: "federation.ping" });
    expect((await readV2Reply(x)).error).toEqual({ code: "ERR_X", message: "nope" });
    sendV2Request(x, { id: 2, method: "federation.ping" });
    expect((await readV2Reply(x)).error).toEqual({ code: "ERR_INTERNAL", message: "plain" });
    x.conn.close();
  });

  test("a reply over 4 MiB becomes a fixed error reply instead of killing the session", async () => {
    const h = await start({ reply: { blob: "y".repeat(5 * 1024 * 1024) } });
    const x = await connectV2(h.port, h.client, h.host.publicKey);
    sendV2Request(x, { id: 9, method: "federation.ping" });
    const reply = await readV2Reply(x);
    expect(reply.id).toBe(9);
    expect(reply.error?.code).toBe("ERR_REPLY_TOO_LARGE");
    sendV2Request(x, { id: 10, method: "federation.ping" });
    // The next reply is over the cap too, but the session is alive.
    expect((await readV2Reply(x)).id).toBe(10);
    x.conn.close();
  });

  test("a request that is not JSON, or has no method, ends the session", async () => {
    const h = await start();
    const a = await connectV2(h.port, h.client, h.host.publicKey);
    for (const r of a.session.sealMessage(new TextEncoder().encode("not json")))
      a.conn.writeFrame(r);
    expect(await a.conn.closed()).toBe(true);
    const b = await connectV2(h.port, h.client, h.host.publicKey);
    sendV2Request(b, { id: 1 });
    expect(await b.conn.closed()).toBe(true);
    expect(h.messages).toHaveLength(0);
  });
});

describe("LanServer - first byte picks the wire (D-FS-9)", () => {
  test("0x7B still runs the legacy hello", async () => {
    const h = await start();
    const conn = await connectRaw(h.port);
    conn.writeFrame(legacyFrame({ kind: "hello", client_pubkey: b64(h.client.publicKey) }));
    const reply = await conn.nextFrame();
    expect(JSON.parse(new TextDecoder().decode(reply))).toMatchObject({ kind: "hello_ok" });
    conn.close();
  });

  test("a first byte that is neither { nor N closes with no reply and counts a failure", async () => {
    const h = await start();
    const conn = await connectRaw(h.port);
    conn.writeFrame(new Uint8Array([0x00, 1, 2, 3]));
    expect(await conn.closed()).toBe(true);
    expect(conn.received()).toHaveLength(0);
    expect(h.failures).toHaveLength(1);
  });

  test("an empty first frame closes and counts", async () => {
    const h = await start();
    const conn = await connectRaw(h.port);
    conn.writeFrame(new Uint8Array(0));
    expect(await conn.closed()).toBe(true);
    expect(h.failures).toHaveLength(1);
  });

  test("an unknown version byte or pattern byte closes and counts", async () => {
    const h = await start();
    const body = createInitiatorHandshake({ s: h.client, rs: h.host.publicKey }).firstFrameBody;
    for (const [i, v] of [
      [2, 0x03],
      [3, 0x07],
    ] as const) {
      const conn = await connectRaw(h.port);
      const bad = body.slice();
      bad[i] = v;
      conn.writeFrame(bad);
      expect(await conn.closed()).toBe(true);
      expect(conn.received()).toHaveLength(0);
    }
    expect(h.failures).toHaveLength(2);
  });
});

describe("LanServer - min_protocol and the downgrade ratchet (FS-A3)", () => {
  test("min_protocol = 2 closes a legacy hello and a legacy pair with no reply, counted; v2 still works", async () => {
    const h = await start({ minProtocol: 2, pairingOpen: true });
    const hello = await connectRaw(h.port);
    hello.writeFrame(legacyFrame({ kind: "hello", client_pubkey: b64(h.client.publicKey) }));
    expect(await hello.closed()).toBe(true);
    expect(hello.received()).toHaveLength(0);
    const pair = await connectRaw(h.port);
    pair.writeFrame(
      legacyFrame({ kind: "pair", client_pubkey: b64(h.client.publicKey), pairing_code: "C" }),
    );
    expect(await pair.closed()).toBe(true);
    expect(pair.received()).toHaveLength(0);
    expect(h.failures).toHaveLength(2);
    expect(h.consumed).toEqual([]);
    const x = await connectV2(h.port, h.client, h.host.publicKey);
    sendV2Request(x, { id: 1, method: "federation.ping" });
    expect((await readV2Reply(x)).result).toBeDefined();
    x.conn.close();
  });

  test("a legacy hello from a pubkey recorded at protocol 2 gets no hello_ok, even under min_protocol = 1", async () => {
    const h = await start({ protoVersion: 2, minProtocol: 1 });
    const conn = await connectRaw(h.port);
    conn.writeFrame(legacyFrame({ kind: "hello", client_pubkey: b64(h.client.publicKey) }));
    expect(await conn.closed()).toBe(true);
    expect(conn.received()).toHaveLength(0);
    expect(h.failures).toHaveLength(1);
  });

  test("a legacy hello from a pubkey at protocol 1 still works under the default min_protocol", async () => {
    const h = await start({ protoVersion: 1 });
    const conn = await connectRaw(h.port);
    conn.writeFrame(legacyFrame({ kind: "hello", client_pubkey: b64(h.client.publicKey) }));
    const reply = await conn.nextFrame();
    expect(JSON.parse(new TextDecoder().decode(reply)).kind).toBe("hello_ok");
    expect(h.failures).toEqual([]);
    conn.close();
  });

  test("a legacy pair for a key recorded at protocol 2 is refused before the code is consumed", async () => {
    const h = await start({ protoVersion: 2, pairingOpen: true });
    const conn = await connectRaw(h.port);
    conn.writeFrame(
      legacyFrame({ kind: "pair", client_pubkey: b64(h.client.publicKey), pairing_code: "C" }),
    );
    expect(await conn.closed()).toBe(true);
    expect(conn.received()).toHaveLength(0);
    expect(h.consumed).toEqual([]);
    expect(h.failures).toHaveLength(1);
  });

  test("a legacy pair for a key at protocol 1 (or unknown) proceeds to the code check", async () => {
    const h = await start({ protoVersion: 1, pairingOpen: true });
    const conn = await connectRaw(h.port);
    conn.writeFrame(
      legacyFrame({ kind: "pair", client_pubkey: b64(h.client.publicKey), pairing_code: "C" }),
    );
    const reply = await conn.nextFrame();
    expect(JSON.parse(new TextDecoder().decode(reply)).kind).toBe("pair_ok");
    expect(h.consumed).toEqual(["C"]);
    conn.close();
  });
});

describe("LanServer - the handshake deadline (D-FS-11)", () => {
  test("a socket that connects and sends nothing is closed at the deadline and counted once", async () => {
    const h = await start({ handshakeDeadlineMs: 80 });
    const conn = await connectRaw(h.port);
    expect(await conn.closed(2000)).toBe(true);
    expect(h.failures).toHaveLength(1);
  });

  test("half of message 1 is closed at the deadline too", async () => {
    const h = await start({ handshakeDeadlineMs: 80 });
    const conn = await connectRaw(h.port);
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, 100, false);
    conn.write(header);
    conn.write(new Uint8Array([0x4e, 0x4c, 0x02]));
    expect(await conn.closed(2000)).toBe(true);
    expect(h.failures).toHaveLength(1);
  });

  test("a completed v2 session and a completed legacy session are not closed by the timer", async () => {
    const h = await start({ handshakeDeadlineMs: 80 });
    const x = await connectV2(h.port, h.client, h.host.publicKey);
    const legacy = await connectRaw(h.port);
    legacy.writeFrame(legacyFrame({ kind: "hello", client_pubkey: b64(h.client.publicKey) }));
    await legacy.nextFrame();
    await new Promise((r) => setTimeout(r, 300));
    expect(await x.conn.closed(50)).toBe(false);
    expect(await legacy.closed(50)).toBe(false);
    sendV2Request(x, { id: 1, method: "federation.ping" });
    expect((await readV2Reply(x)).id).toBe(1);
    expect(h.failures).toEqual([]);
    x.conn.close();
    legacy.close();
  });

  test("a socket already refused is not counted a second time by the timer", async () => {
    const h = await start({ handshakeDeadlineMs: 150 });
    const conn = await connectRaw(h.port);
    conn.writeFrame(new Uint8Array([0x00]));
    expect(await conn.closed()).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.failures).toHaveLength(1);
  });
});

describe("LanServer - frame caps by wire mode", () => {
  test("a v2 record header over 65,535 bytes closes the session without a failure count", async () => {
    const h = await start();
    const x = await connectV2(h.port, h.client, h.host.publicKey);
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, MAX_RECORD_FRAME + 1, false);
    x.conn.write(header);
    expect(await x.conn.closed()).toBe(true);
    expect(h.failures).toEqual([]);
  });

  test("a first-frame header over 4,096 bytes closes and counts, on either wire", async () => {
    const h = await start();
    const conn = await connectRaw(h.port);
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, 4097, false);
    conn.write(header);
    expect(await conn.closed()).toBe(true);
    expect(h.failures).toHaveLength(1);
  });

  test("a v2 handshake frame is limited to the first-frame cap before it is complete", async () => {
    const h = await start();
    const conn = await connectRaw(h.port);
    conn.writeFrame(encodeFirstFrame(new Uint8Array(5000)));
    expect(await conn.closed()).toBe(true);
    expect(h.failures).toHaveLength(1);
  });
});

describe("LanServer v2 - rekey on the server side", () => {
  test("more than 1,024 requests on one session keep working", async () => {
    const h = await start();
    const x = await connectV2(h.port, h.client, h.host.publicKey);
    for (let i = 1; i <= REKEY_EVERY_RECORDS + 20; i++) {
      sendV2Request(x, { id: i, method: "federation.ping" });
      expect((await readV2Reply(x)).id).toBe(i);
    }
    x.conn.close();
  }, 30_000);
});
