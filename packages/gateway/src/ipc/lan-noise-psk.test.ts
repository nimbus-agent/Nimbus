import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type HandshakePattern,
  HandshakeState,
  NOISE_OPEN_FAILED,
  PATTERN_XXPSK0,
  type Token,
  x25519PublicKey,
} from "./lan-noise.ts";

interface Vector {
  protocol_name: string;
  init_prologue: string;
  init_psks: string[];
  init_static: string;
  init_ephemeral: string;
  resp_prologue: string;
  resp_psks: string[];
  resp_static: string;
  resp_ephemeral: string;
  handshake_hash?: string;
  messages: { payload: string; ciphertext: string }[];
}

const fixture = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "..",
      "..",
      "test",
      "fixtures",
      "noise",
      "noise-xxpsk-25519-aesgcm-sha256.vectors.json",
    ),
    "utf8",
  ),
) as { vectors: Vector[] };

const hex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));
const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const keypair = (secretHex: string) => {
  const secretKey = hex(secretHex);
  return { publicKey: x25519PublicKey(secretKey), secretKey };
};
const EMPTY = new Uint8Array(0);

/** Builds the XX pattern with the `pskN` modifiers a protocol name carries (Noise § 9.4). */
function xxPatternFor(protocolName: string): HandshakePattern {
  const modifiers = /^Noise_XX([^_]*)_/.exec(protocolName)?.[1] ?? "";
  const positions = modifiers
    .split("+")
    .map((m) => /^psk(\d)$/.exec(m)?.[1])
    .filter((p): p is string => p !== undefined)
    .map(Number);
  const messages: Token[][] = [["e"], ["e", "ee", "s", "es"], ["s", "se"]];
  for (const pos of positions) {
    if (pos === 0) (messages[0] as Token[]).unshift("psk");
    else (messages[pos - 1] as Token[]).push("psk");
  }
  return {
    name: `XX${modifiers}`,
    preMessages: { initiator: [], responder: [] },
    messages,
  };
}

describe("Noise XX with psk tokens, published vectors", () => {
  test("the fixture is not empty and covers psk0 and a late psk", () => {
    expect(fixture.vectors).toHaveLength(5);
    const names = fixture.vectors.map((v) => v.protocol_name);
    expect(names.some((n) => n.includes("psk0"))).toBe(true);
    expect(names).toContain("Noise_XXpsk3_25519_AESGCM_SHA256");
  });

  test("the XXpsk0 table row is the pattern the vectors' psk0 entries start from", () => {
    expect(PATTERN_XXPSK0.messages[0]).toEqual(["psk", "e"]);
    expect(xxPatternFor("Noise_XXpsk0_25519_AESGCM_SHA256").messages).toEqual(
      PATTERN_XXPSK0.messages,
    );
  });

  for (const v of fixture.vectors) {
    test(`${v.protocol_name}: every ciphertext (and the handshake hash, when given) match`, () => {
      const pattern = xxPatternFor(v.protocol_name);
      expect(`Noise_${pattern.name}_25519_AESGCM_SHA256`).toBe(v.protocol_name);
      const initiator = new HandshakeState({
        pattern,
        initiator: true,
        prologue: hex(v.init_prologue),
        s: keypair(v.init_static),
        psks: v.init_psks.map(hex),
        generateEphemeral: () => keypair(v.init_ephemeral),
      });
      const responder = new HandshakeState({
        pattern,
        initiator: false,
        prologue: hex(v.resp_prologue),
        s: keypair(v.resp_static),
        psks: v.resp_psks.map(hex),
        generateEphemeral: () => keypair(v.resp_ephemeral),
      });
      const handshakeLength = pattern.messages.length;
      for (const [n, m] of v.messages.slice(0, handshakeLength).entries()) {
        const [writer, reader] = n % 2 === 0 ? [initiator, responder] : [responder, initiator];
        const msg = writer.writeMessage(hex(m.payload));
        expect(toHex(msg)).toBe(m.ciphertext);
        expect(toHex(reader.readMessage(msg))).toBe(m.payload);
      }
      if (v.handshake_hash !== undefined) {
        expect(toHex(initiator.handshakeHash())).toBe(v.handshake_hash);
        expect(toHex(responder.handshakeHash())).toBe(v.handshake_hash);
      }
      const i = initiator.split();
      const r = responder.split();
      for (const [n, m] of v.messages.slice(handshakeLength).entries()) {
        const fromInitiator = (handshakeLength + n) % 2 === 0;
        const sealed = (fromInitiator ? i.send : r.send).encryptWithAd(EMPTY, hex(m.payload));
        expect(toHex(sealed)).toBe(m.ciphertext);
        const opened = (fromInitiator ? r.receive : i.receive).decryptWithAd(EMPTY, sealed);
        expect(toHex(opened)).toBe(m.payload);
      }
    });
  }
});

function randomKeypair() {
  const secretKey = new Uint8Array(32);
  crypto.getRandomValues(secretKey);
  return { publicKey: x25519PublicKey(secretKey), secretKey };
}
const randomPsk = () => crypto.getRandomValues(new Uint8Array(32));

function xxPair(initPsk: Uint8Array, respPsk: Uint8Array) {
  const prologue = new TextEncoder().encode("test");
  return {
    initiator: new HandshakeState({
      pattern: PATTERN_XXPSK0,
      initiator: true,
      prologue,
      s: randomKeypair(),
      psks: [initPsk],
    }),
    responder: new HandshakeState({
      pattern: PATTERN_XXPSK0,
      initiator: false,
      prologue,
      s: randomKeypair(),
      psks: [respPsk],
    }),
  };
}

describe("XXpsk0 (random keys)", () => {
  test("the same psk completes, and each side learns the other's static key", () => {
    const psk = randomPsk();
    const { initiator, responder } = xxPair(psk, psk);
    responder.readMessage(initiator.writeMessage(EMPTY));
    initiator.readMessage(responder.writeMessage(EMPTY));
    responder.readMessage(initiator.writeMessage(EMPTY));
    expect(toHex(initiator.handshakeHash())).toBe(toHex(responder.handshakeHash()));
    expect(initiator.remoteStatic()).toHaveLength(32);
    expect(responder.remoteStatic()).toHaveLength(32);
  });

  test("a different psk fails at message 1, with the one fixed error", () => {
    const { initiator, responder } = xxPair(randomPsk(), randomPsk());
    const m1 = initiator.writeMessage(EMPTY);
    expect(() => responder.readMessage(m1)).toThrow(NOISE_OPEN_FAILED);
  });

  test("a truncated or bit-flipped message 1 fails to open", () => {
    const psk = randomPsk();
    const a = xxPair(psk, psk);
    const m1 = a.initiator.writeMessage(EMPTY);
    expect(() => a.responder.readMessage(m1.slice(0, m1.length - 1))).toThrow(NOISE_OPEN_FAILED);
    const b = xxPair(psk, psk);
    const flipped = b.initiator.writeMessage(EMPTY);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    expect(() => b.responder.readMessage(flipped)).toThrow(NOISE_OPEN_FAILED);
  });

  test("a man in the middle without the psk cannot read message 1", () => {
    const psk = randomPsk();
    const { initiator } = xxPair(psk, psk);
    const m1 = initiator.writeMessage(EMPTY);
    const mitm = xxPair(randomPsk(), randomPsk()).responder;
    expect(() => mitm.readMessage(m1)).toThrow(NOISE_OPEN_FAILED);
  });

  test("a message 2 made without the psk fails at the initiator", () => {
    const psk = randomPsk();
    const real = xxPair(psk, psk);
    // The attacker knows the initiator's e (it is on the wire) but not the psk, so it cannot even
    // open message 1; the best it can do is write its own message 2 from a fresh handshake.
    const roguePsk = randomPsk();
    const rogue = xxPair(roguePsk, roguePsk);
    real.initiator.writeMessage(EMPTY);
    rogue.responder.readMessage(rogue.initiator.writeMessage(EMPTY));
    const forged = rogue.responder.writeMessage(EMPTY);
    expect(() => real.initiator.readMessage(forged)).toThrow(NOISE_OPEN_FAILED);
  });

  test("the number and length of psks must match the pattern", () => {
    const base = { pattern: PATTERN_XXPSK0, initiator: true, prologue: EMPTY, s: randomKeypair() };
    expect(() => new HandshakeState(base)).toThrow("psks");
    expect(() => new HandshakeState({ ...base, psks: [new Uint8Array(31)] })).toThrow("key length");
  });
});
