/**
 * FS2: the `Noise_XXpsk0` pairing, end to end over loopback: a real `LanServer` with a real
 * `PairingWindow`, the real initiator, a recording proxy and raw frames for the attacker cases.
 * Wrong code, no window, replay, truncation, a rogue host, a v1 `pair` under `min_protocol = 2`, a
 * race for one window, and a recorded pairing that its static keys and its PSK cannot open.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { generateBoxKeypair } from "./lan-crypto.ts";
import { outboundPairHandshake, PAIR_NO_REPLY_HINT } from "./lan-pair-client.ts";
import {
  createPairInitiator,
  encodePairFirstFrame,
  isPairFirstFrame,
  openPairResponder,
  PAIR_PROLOGUE,
} from "./lan-pair-session.ts";
import { derivePairingPsk, generatePairingCode, PairingWindow } from "./lan-pairing.ts";
import type { LanServerOptions } from "./lan-server.ts";
import { startRecordingProxy } from "./testing/lan-forward-secrecy.test-helpers.ts";
import {
  type PairingHarness,
  recordPairingScenario,
  startPairingHarness,
} from "./testing/lan-pairing.test-helpers.ts";
import { connectRaw } from "./testing/lan-v2.test-helpers.ts";
import { fakePairing } from "./testing/pairing-fakes.ts";

const stoppers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const stop of stoppers.splice(0)) await stop();
});

async function startHarness(opts: Partial<LanServerOptions> = {}): Promise<PairingHarness> {
  const h = await startPairingHarness(opts);
  stoppers.push(() => h.stop());
  return h;
}

/** The message a promise rejects with (`.rejects` on a fast socket rejection crashes Bun 1.3 on Windows now and then). */
const failureOf = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "resolved",
    (e: unknown) => (e as Error).message,
  );
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const contains = (haystack: Uint8Array, needle: Uint8Array): boolean =>
  Buffer.from(haystack).includes(Buffer.from(needle));
const concat = (frames: Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(frames));

describe("XXpsk0 pairing: the happy path", () => {
  test("pairs, registers the initiator at protocol 2 and closes the window (D-FS-15, D-FS-17)", async () => {
    const h = await startHarness();
    const code = generatePairingCode();
    h.window.open(code);
    const initiator = generateBoxKeypair();
    const hostKey = await outboundPairHandshake("127.0.0.1", h.port, code, initiator);
    expect(hex(hostKey)).toBe(hex(h.host.publicKey));
    expect(h.registered).toHaveLength(1);
    expect(hex(h.registered[0]?.pubkey as Uint8Array)).toBe(hex(initiator.publicKey));
    expect(h.registered[0]?.protoVersion).toBe(2);
    expect(h.window.isOpen()).toBe(false);
    expect(h.failures).toHaveLength(0);
    expect(h.successes).toHaveLength(1);
  });

  test("the same code cannot pair twice: the window closed on the first success", async () => {
    const h = await startHarness();
    const code = generatePairingCode();
    h.window.open(code);
    await outboundPairHandshake("127.0.0.1", h.port, code, generateBoxKeypair());
    expect(
      await failureOf(
        outboundPairHandshake("127.0.0.1", h.port, code, generateBoxKeypair(), 1_000),
      ),
    ).toContain(PAIR_NO_REPLY_HINT);
    expect(h.registered).toHaveLength(1);
    expect(h.failures).toHaveLength(1);
  });
});

describe("XXpsk0 pairing: a wrong or absent code", () => {
  test("a wrong code closes with no reply at message 1: one failure, the window stays open", async () => {
    const h = await startHarness();
    const code = generatePairingCode();
    h.window.open(code);
    const raw = await connectRaw(h.port);
    const wrong = createPairInitiator({
      s: generateBoxKeypair(),
      psk: derivePairingPsk(generatePairingCode()),
    });
    raw.writeFrame(wrong.firstFrameBody);
    expect(await raw.nextFrame(500)).toBeUndefined();
    expect(await raw.closed(500)).toBe(true);
    expect(raw.received().length).toBe(0);
    expect(h.failures).toHaveLength(1);
    expect(h.window.isOpen()).toBe(true);
    // the right code still works afterwards
    await outboundPairHandshake("127.0.0.1", h.port, code, generateBoxKeypair());
    expect(h.registered).toHaveLength(1);
  });

  test("with no window open there is no PSK: no reply, one failure", async () => {
    const h = await startHarness();
    const raw = await connectRaw(h.port);
    const i = createPairInitiator({
      s: generateBoxKeypair(),
      psk: derivePairingPsk(generatePairingCode()),
    });
    raw.writeFrame(i.firstFrameBody);
    expect(await raw.closed(500)).toBe(true);
    expect(raw.received().length).toBe(0);
    expect(h.failures).toHaveLength(1);
  });

  test("an expired window answers nothing", async () => {
    let now = 1_000;
    const window = new PairingWindow(5_000, () => now);
    const h = await startHarness({
      pairing: fakePairing({
        currentPsk: () => window.currentPsk(),
        isOpen: () => window.isOpen(),
      }),
    });
    const code = generatePairingCode();
    window.open(code);
    now += 5_001;
    expect(
      await failureOf(
        outboundPairHandshake("127.0.0.1", h.port, code, generateBoxKeypair(), 1_000),
      ),
    ).toContain(PAIR_NO_REPLY_HINT);
    expect(h.registered).toHaveLength(0);
  });

  test("a locked-out address gets no bytes and no DH work", async () => {
    const h = await startHarness({
      rateLimit: {
        checkAllowed: () => false,
        recordFailure: () => {},
        recordSuccess: () => {},
      },
    });
    const code = generatePairingCode();
    h.window.open(code);
    expect(
      await failureOf(
        outboundPairHandshake("127.0.0.1", h.port, code, generateBoxKeypair(), 1_000),
      ),
    ).toContain(PAIR_NO_REPLY_HINT);
    expect(h.window.isOpen()).toBe(true);
  });
});

describe("XXpsk0 pairing: malformed and truncated input", () => {
  test("a truncated message 1 closes with no reply", async () => {
    const h = await startHarness();
    const code = generatePairingCode();
    h.window.open(code);
    const i = createPairInitiator({ s: generateBoxKeypair(), psk: derivePairingPsk(code) });
    const raw = await connectRaw(h.port);
    raw.writeFrame(i.firstFrameBody.slice(0, i.firstFrameBody.length - 1));
    expect(await raw.closed(500)).toBe(true);
    expect(raw.received().length).toBe(0);
    expect(h.failures).toHaveLength(1);
    expect(h.window.isOpen()).toBe(true);
  });

  test("a header that names a different version or pattern is not a pairing and never pairs", async () => {
    const h = await startHarness();
    const code = generatePairingCode();
    h.window.open(code);
    const i = createPairInitiator({ s: generateBoxKeypair(), psk: derivePairingPsk(code) });
    for (const [index, byte] of [
      [2, 0x03],
      [3, 0x09],
    ] as const) {
      const bad = i.firstFrameBody.slice();
      bad[index] = byte;
      const raw = await connectRaw(h.port);
      raw.writeFrame(bad);
      expect(await raw.closed(500)).toBe(true);
      expect(raw.received().length).toBe(0);
    }
    expect(h.registered).toHaveLength(0);
    expect(h.window.isOpen()).toBe(true);
  });

  test("a truncated or flipped message 3 is a counted failure, registers nothing and keeps the window", async () => {
    const h = await startHarness();
    const code = generatePairingCode();
    h.window.open(code);
    const psk = derivePairingPsk(code);
    for (const mutate of [
      (m: Uint8Array) => m.slice(0, m.length - 1),
      (m: Uint8Array) => {
        const c = m.slice();
        c[c.length - 1] = (c[c.length - 1] ?? 0) ^ 1;
        return c;
      },
    ]) {
      const i = createPairInitiator({ s: generateBoxKeypair(), psk });
      const raw = await connectRaw(h.port);
      raw.writeFrame(i.firstFrameBody);
      const message2 = await raw.nextFrame(1_000);
      expect(message2).toBeDefined();
      const done = i.finish(message2 as Uint8Array);
      raw.writeFrame(mutate(done.message3));
      expect(await raw.closed(500)).toBe(true);
    }
    expect(h.registered).toHaveLength(0);
    expect(h.failures).toHaveLength(2);
    expect(h.window.isOpen()).toBe(true);
  });

  test("a client that stops after message 2 is closed at the handshake deadline and counted", async () => {
    const h = await startHarness({ handshakeDeadlineMs: 150 });
    const code = generatePairingCode();
    h.window.open(code);
    const i = createPairInitiator({ s: generateBoxKeypair(), psk: derivePairingPsk(code) });
    const raw = await connectRaw(h.port);
    raw.writeFrame(i.firstFrameBody);
    expect(await raw.nextFrame(1_000)).toBeDefined();
    expect(await raw.closed(2_000)).toBe(true);
    expect(h.failures).toHaveLength(1);
    expect(h.window.isOpen()).toBe(true);
  });

  test("message 3 sent before any message 1 is not a pairing", async () => {
    const h = await startHarness();
    h.window.open(generatePairingCode());
    const raw = await connectRaw(h.port);
    raw.writeFrame(new Uint8Array(96).fill(7));
    expect(await raw.closed(500)).toBe(true);
    expect(h.registered).toHaveLength(0);
  });
});

describe("XXpsk0 pairing: races and replays", () => {
  test("two initiators with the right code racing: exactly one pairs", async () => {
    const h = await startHarness();
    const code = generatePairingCode();
    h.window.open(code);
    const results = await Promise.allSettled([
      outboundPairHandshake("127.0.0.1", h.port, code, generateBoxKeypair(), 2_000),
      outboundPairHandshake("127.0.0.1", h.port, code, generateBoxKeypair(), 2_000),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(h.registered).toHaveLength(1);
  });

  test("a recorded pairing replayed against a fresh window with the same code pairs nothing", async () => {
    const h = await startHarness();
    const proxy = startRecordingProxy(h.port);
    stoppers.push(() => proxy.stop());
    const code = generatePairingCode();
    h.window.open(code);
    await outboundPairHandshake("127.0.0.1", proxy.port, code, generateBoxKeypair());
    const recorded = proxy.connections[0];
    expect(recorded?.c2s).toHaveLength(2);
    expect(h.registered).toHaveLength(1);

    // The worst case for the replayer: the owner opened another window with the SAME code.
    h.window.open(code);
    const raw = await connectRaw(h.port);
    raw.writeFrame(recorded?.c2s[0] as Uint8Array); // message 1 opens: it is keyed by the code
    const message2 = await raw.nextFrame(1_000);
    expect(message2).toBeDefined();
    expect(hex(message2 as Uint8Array)).not.toBe(hex(recorded?.s2c[0] as Uint8Array)); // fresh e
    raw.writeFrame(recorded?.c2s[1] as Uint8Array); // message 3 does not: it depends on the fresh e
    expect(await raw.closed(500)).toBe(true);
    expect(h.registered).toHaveLength(1);
    expect(h.failures).toHaveLength(1);
    expect(h.window.isOpen()).toBe(true);
  });

  test("a recorded host reply replayed to a new initiator does not open", async () => {
    const h = await startHarness();
    const proxy = startRecordingProxy(h.port);
    stoppers.push(() => proxy.stop());
    const code = generatePairingCode();
    h.window.open(code);
    await outboundPairHandshake("127.0.0.1", proxy.port, code, generateBoxKeypair());
    const recordedMessage2 = proxy.connections[0]?.s2c[0] as Uint8Array;

    const replay = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() {},
        data(socket) {
          const header = new Uint8Array(4);
          new DataView(header.buffer).setUint32(0, recordedMessage2.length, false);
          socket.write(concat([header, recordedMessage2]));
        },
        close() {},
        error() {},
      },
    });
    stoppers.push(() => replay.stop(true));
    const err = await outboundPairHandshake(
      "127.0.0.1",
      replay.port,
      code,
      generateBoxKeypair(),
      1_000,
    ).catch((e: unknown) => e);
    expect((err as Error).message).toBe("lan-noise: message failed to open");
  });
});

describe("XXpsk0 pairing: the initiator side", () => {
  test("a rogue host that does not know the code cannot get message 3, and learns no key of ours", async () => {
    const rogueSeen: Uint8Array[] = [];
    const roguePsk = derivePairingPsk(generatePairingCode());
    const rogue = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() {},
        data(socket, chunk) {
          rogueSeen.push(chunk.slice());
          if (rogueSeen.length > 1) return;
          // The rogue cannot open message 1 (wrong PSK), so it answers with a message 2 of its own.
          const body = rogueSeen[0]?.subarray(4) as Uint8Array;
          try {
            openPairResponder(body, { s: generateBoxKeypair(), psk: roguePsk });
          } catch {
            // expected: it cannot even read message 1; send junk shaped like a message 2
          }
          const junk = new Uint8Array(48).fill(9);
          const header = new Uint8Array(4);
          new DataView(header.buffer).setUint32(0, junk.length, false);
          socket.write(concat([header, junk]));
        },
        close() {},
        error() {},
      },
    });
    stoppers.push(() => rogue.stop(true));
    const err = await outboundPairHandshake(
      "127.0.0.1",
      rogue.port,
      generatePairingCode(),
      generateBoxKeypair(),
      1_000,
    ).catch((e: unknown) => e);
    expect((err as Error).message).toBe("lan-noise: message failed to open");
    expect(rogueSeen).toHaveLength(1); // message 1 only: message 3 (our static key) never left
  });

  test("an old host that does not speak v2 is never sent the code: no v1 `pair` fallback", async () => {
    const received: Uint8Array[] = [];
    const old = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() {},
        data(socket, chunk) {
          received.push(chunk.slice());
          socket.end(); // an old gateway fails to parse a non-JSON first frame and closes
        },
        close() {},
        error() {},
      },
    });
    stoppers.push(() => old.stop(true));
    const code = generatePairingCode();
    expect(
      await failureOf(
        outboundPairHandshake("127.0.0.1", old.port, code, generateBoxKeypair(), 1_000),
      ),
    ).toContain(PAIR_NO_REPLY_HINT);
    await new Promise((r) => setTimeout(r, 50));
    const all = concat(received);
    expect(received).toHaveLength(1); // one connection's one write: no retry in another wire
    expect(all[4]).toBe(0x4e); // "NL", not `{`
    expect(contains(all, new TextEncoder().encode(code))).toBe(false);
    expect(contains(all, new TextEncoder().encode("pairing_code"))).toBe(false);
  });

  test("a host that answers a pair_err record instead of pair_ok is a rejection", async () => {
    const code = generatePairingCode();
    const psk = derivePairingPsk(code);
    let responder: ReturnType<typeof openPairResponder> | undefined;
    const frame = (b: Uint8Array): Uint8Array => {
      const h = new Uint8Array(4);
      new DataView(h.buffer).setUint32(0, b.length, false);
      return concat([h, b]);
    };
    const fake = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() {},
        data(socket, chunk) {
          if (responder === undefined) {
            responder = openPairResponder(chunk.slice(4), { s: generateBoxKeypair(), psk });
            socket.write(frame(responder.message2));
            return;
          }
          const done = responder.finish(chunk.slice(4));
          const record = done.session.sealMessage(
            new TextEncoder().encode(JSON.stringify({ kind: "pair_err" })),
          )[0] as Uint8Array;
          socket.write(frame(record));
        },
        close() {},
        error() {},
      },
    });
    stoppers.push(() => fake.stop(true));
    const err = await outboundPairHandshake(
      "127.0.0.1",
      fake.port,
      code,
      generateBoxKeypair(),
      1_000,
    ).catch((e: unknown) => e);
    expect((err as Error).message).toBe("lan-client: pairing rejected");
  });

  test("a bad code is refused before any socket exists (D-FS-16)", async () => {
    expect(
      await failureOf(outboundPairHandshake("127.0.0.1", 1, "short", generateBoxKeypair())),
    ).toContain("20 base58 characters");
  });
});

describe("XXpsk0 pairing: what a recording shows", () => {
  test("no code, PSK or static key on the wire; both statics and the PSK open nothing; the control opens it", async () => {
    const r = await recordPairingScenario();
    expect([r.wireHasCode, r.wireHasPsk, r.wireHasInitiatorStatic, r.wireHasHostStatic]).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(r.attackerOpened).toBe(0);
    expect(r.controlOpened).toBe(true);
  });
});

describe("pairing frame shape", () => {
  test("the header is NL 02 02, the prologue names the version and pattern", () => {
    const frame = encodePairFirstFrame(new Uint8Array([1, 2, 3]));
    expect([...frame.slice(0, 4)]).toEqual([0x4e, 0x4c, 0x02, 0x02]);
    expect(isPairFirstFrame(frame)).toBe(true);
    expect(isPairFirstFrame(new Uint8Array([0x4e, 0x4c, 0x02, 0x01, 9]))).toBe(false);
    expect(isPairFirstFrame(new Uint8Array([0x4e]))).toBe(false);
    expect(new TextDecoder().decode(PAIR_PROLOGUE.slice(0, 12))).toBe("nimbus-lan/2");
    expect([...PAIR_PROLOGUE.slice(12)]).toEqual([0x02, 0x02]);
  });

  test("a prologue edit breaks the handshake (the version byte is authenticated)", () => {
    const code = generatePairingCode();
    const psk = derivePairingPsk(code);
    const i = createPairInitiator({ s: generateBoxKeypair(), psk });
    const body = i.firstFrameBody.slice();
    body[2] = 0x03;
    expect(() => openPairResponder(body, { s: generateBoxKeypair(), psk })).toThrow(
      "lan-noise: message failed to open",
    );
  });
});
