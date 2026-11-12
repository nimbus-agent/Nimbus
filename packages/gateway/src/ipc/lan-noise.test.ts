import { describe, expect, test } from "bun:test";
import { createCipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CipherState,
  type HandshakePattern,
  HandshakeState,
  NOISE_OPEN_FAILED,
  PATTERN_IK,
  requireContributory,
  x25519,
  x25519PublicKey,
} from "./lan-noise.ts";

interface Vector {
  protocol_name: string;
  init_prologue: string;
  init_static: string;
  init_ephemeral: string;
  init_remote_static: string;
  resp_prologue: string;
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
      "noise-ik-25519-aesgcm-sha256.vectors.json",
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
const ephemeralOf = (secretHex: string) => () => keypair(secretHex);
const EMPTY = new Uint8Array(0);
const TEXT = new TextEncoder();

function randomKeypair() {
  const secretKey = new Uint8Array(32);
  crypto.getRandomValues(secretKey);
  return { publicKey: x25519PublicKey(secretKey), secretKey };
}

describe("Noise_IK_25519_AESGCM_SHA256 published vectors", () => {
  test("the fixture is not empty, so the vector test cannot pass vacuously", () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(2);
    for (const v of fixture.vectors) {
      expect(v.protocol_name).toBe("Noise_IK_25519_AESGCM_SHA256");
      expect(v.messages.length).toBeGreaterThanOrEqual(4);
    }
  });

  for (const [index, v] of fixture.vectors.entries()) {
    test(`vector ${String(index)}: every ciphertext and the handshake hash match`, () => {
      const initiator = new HandshakeState({
        pattern: PATTERN_IK,
        initiator: true,
        prologue: hex(v.init_prologue),
        s: keypair(v.init_static),
        rs: hex(v.init_remote_static),
        generateEphemeral: ephemeralOf(v.init_ephemeral),
      });
      const responder = new HandshakeState({
        pattern: PATTERN_IK,
        initiator: false,
        prologue: hex(v.resp_prologue),
        s: keypair(v.resp_static),
        generateEphemeral: ephemeralOf(v.resp_ephemeral),
      });
      const m0 = v.messages[0] as { payload: string; ciphertext: string };
      const m1 = v.messages[1] as { payload: string; ciphertext: string };
      const msg1 = initiator.writeMessage(hex(m0.payload));
      expect(toHex(msg1)).toBe(m0.ciphertext);
      expect(toHex(responder.readMessage(msg1))).toBe(m0.payload);
      const msg2 = responder.writeMessage(hex(m1.payload));
      expect(toHex(msg2)).toBe(m1.ciphertext);
      expect(toHex(initiator.readMessage(msg2))).toBe(m1.payload);

      if (v.handshake_hash !== undefined) {
        expect(toHex(initiator.handshakeHash())).toBe(v.handshake_hash);
        expect(toHex(responder.handshakeHash())).toBe(v.handshake_hash);
      }
      expect(toHex(responder.remoteStatic())).toBe(toHex(keypair(v.init_static).publicKey));

      const i = initiator.split();
      const r = responder.split();
      for (const [n, m] of v.messages.slice(2).entries()) {
        const fromInitiator = n % 2 === 0;
        const sender = fromInitiator ? i.send : r.send;
        const receiver = fromInitiator ? r.receive : i.receive;
        const sealed = sender.encryptWithAd(EMPTY, hex(m.payload));
        expect(toHex(sealed)).toBe(m.ciphertext);
        expect(toHex(receiver.decryptWithAd(EMPTY, sealed))).toBe(m.payload);
      }
    });
  }
});

function pair(): { initiator: HandshakeState; responder: HandshakeState } {
  const si = randomKeypair();
  const sr = randomKeypair();
  const prologue = TEXT.encode("test");
  return {
    initiator: new HandshakeState({
      pattern: PATTERN_IK,
      initiator: true,
      prologue,
      s: si,
      rs: sr.publicKey,
    }),
    responder: new HandshakeState({ pattern: PATTERN_IK, initiator: false, prologue, s: sr }),
  };
}

function completed() {
  const { initiator, responder } = pair();
  responder.readMessage(initiator.writeMessage(EMPTY));
  initiator.readMessage(responder.writeMessage(EMPTY));
  return { i: initiator.split(), r: responder.split() };
}

describe("HandshakeState (random keys)", () => {
  test("a full IK exchange agrees on the handshake hash and the two directions", () => {
    const { initiator, responder } = pair();
    responder.readMessage(initiator.writeMessage(EMPTY));
    initiator.readMessage(responder.writeMessage(EMPTY));
    expect(toHex(initiator.handshakeHash())).toBe(toHex(responder.handshakeHash()));
    const i = initiator.split();
    const r = responder.split();
    const ct = i.send.encryptWithAd(EMPTY, TEXT.encode("ping"));
    expect(new TextDecoder().decode(r.receive.decryptWithAd(EMPTY, ct))).toBe("ping");
    const back = r.send.encryptWithAd(EMPTY, TEXT.encode("pong"));
    expect(new TextDecoder().decode(i.receive.decryptWithAd(EMPTY, back))).toBe("pong");
  });

  test("Split() directions are not interchangeable", () => {
    const { i } = completed();
    const ct = i.send.encryptWithAd(EMPTY, new Uint8Array([1, 2, 3]));
    expect(() => i.receive.decryptWithAd(EMPTY, ct)).toThrow(NOISE_OPEN_FAILED);
  });

  test("the default ephemeral differs on every handshake", () => {
    const a = pair().initiator.writeMessage(EMPTY).slice(0, 32);
    const b = pair().initiator.writeMessage(EMPTY).slice(0, 32);
    expect(toHex(a)).not.toBe(toHex(b));
  });

  test("a tampered, truncated or wrong-prologue message 1 all fail with the same fixed message", () => {
    const messages: string[] = [];
    const attempt = (mutate: (m: Uint8Array) => Uint8Array, responderPrologue: string) => {
      const si = randomKeypair();
      const sr = randomKeypair();
      const init = new HandshakeState({
        pattern: PATTERN_IK,
        initiator: true,
        prologue: TEXT.encode("test"),
        s: si,
        rs: sr.publicKey,
      });
      const resp = new HandshakeState({
        pattern: PATTERN_IK,
        initiator: false,
        prologue: TEXT.encode(responderPrologue),
        s: sr,
      });
      try {
        resp.readMessage(mutate(init.writeMessage(EMPTY)));
      } catch (e) {
        messages.push((e as Error).message);
      }
    };
    attempt((m) => {
      const c = m.slice();
      c[40] = (c[40] as number) ^ 1;
      return c;
    }, "test");
    attempt((m) => m.slice(0, m.length - 1), "test");
    attempt((m) => m.slice(0, 20), "test");
    attempt((m) => m.slice(0, 80), "test");
    attempt((m) => m, "other");
    expect(messages).toHaveLength(5);
    expect(new Set(messages)).toEqual(new Set([NOISE_OPEN_FAILED]));
  });

  test("a state that failed to open a message refuses to continue", () => {
    const { initiator, responder } = pair();
    const m = initiator.writeMessage(EMPTY);
    m[50] = (m[50] as number) ^ 1;
    expect(() => responder.readMessage(m)).toThrow(NOISE_OPEN_FAILED);
    expect(() => responder.readMessage(m)).toThrow(NOISE_OPEN_FAILED);
    expect(() => responder.writeMessage(EMPTY)).toThrow();
  });

  test("messages out of turn, after completion, or too long are refused", () => {
    const { initiator, responder } = pair();
    expect(() => responder.writeMessage(EMPTY)).toThrow("lan-noise: out of turn");
    expect(() => initiator.readMessage(new Uint8Array(100))).toThrow("lan-noise: out of turn");
    expect(() => initiator.split()).toThrow("lan-noise: handshake not complete");
    expect(() => pair().initiator.writeMessage(new Uint8Array(65_535))).toThrow(
      "lan-noise: message too large",
    );
    responder.readMessage(initiator.writeMessage(EMPTY));
    initiator.readMessage(responder.writeMessage(EMPTY));
    expect(() => initiator.writeMessage(EMPTY)).toThrow("lan-noise: out of turn");
    expect(() => responder.readMessage(new Uint8Array(70_000))).toThrow(NOISE_OPEN_FAILED);
  });

  test("remoteStatic is unknown to the responder until message 1 is read", () => {
    const { initiator, responder } = pair();
    expect(() => responder.remoteStatic()).toThrow("lan-noise: remote static not known");
    responder.readMessage(initiator.writeMessage(EMPTY));
    expect(responder.remoteStatic()).toHaveLength(32);
  });

  test("an all-zero DH result (low-order point) is refused", () => {
    const zero = new Uint8Array(32);
    const order8 = hex("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800");
    const sk = randomKeypair().secretKey;
    expect(() => x25519(sk, zero)).toThrow("lan-noise: invalid public key");
    expect(() => x25519(sk, order8)).toThrow("lan-noise: invalid public key");
    // As the initiator's pinned responder key:
    const init = new HandshakeState({
      pattern: PATTERN_IK,
      initiator: true,
      prologue: EMPTY,
      s: randomKeypair(),
      rs: order8,
    });
    expect(() => init.writeMessage(EMPTY)).toThrow("lan-noise: invalid public key");
    // As the initiator's ephemeral in message 1 (responder side):
    const resp = new HandshakeState({
      pattern: PATTERN_IK,
      initiator: false,
      prologue: EMPTY,
      s: randomKeypair(),
    });
    const forged = new Uint8Array(32 + 48 + 16);
    forged.set(order8, 0);
    expect(() => resp.readMessage(forged)).toThrow(NOISE_OPEN_FAILED);
  });

  test("an all-zero shared secret is refused whatever the runtime did with the point", () => {
    expect(() => requireContributory(new Uint8Array(32))).toThrow("lan-noise: invalid public key");
    const ok = new Uint8Array(32);
    ok[31] = 1;
    expect(requireContributory(ok)).toBe(ok);
  });

  test("x25519 and x25519PublicKey reject wrong-sized keys", () => {
    expect(() => x25519(new Uint8Array(31), new Uint8Array(32))).toThrow(
      "lan-noise: invalid key length",
    );
    expect(() => x25519(new Uint8Array(32), new Uint8Array(33))).toThrow(
      "lan-noise: invalid key length",
    );
    expect(() => x25519PublicKey(new Uint8Array(5))).toThrow("lan-noise: invalid key length");
  });

  test("a split handshake cannot be split twice, and a long protocol name is hashed", () => {
    const { initiator, responder } = pair();
    responder.readMessage(initiator.writeMessage(EMPTY));
    initiator.readMessage(responder.writeMessage(EMPTY));
    initiator.split();
    expect(() => initiator.split()).toThrow("lan-noise: handshake not complete");
    const long: HandshakePattern = { ...PATTERN_IK, name: "IK".padEnd(40, "x") };
    const si = randomKeypair();
    const sr = randomKeypair();
    const a = new HandshakeState({
      pattern: long,
      initiator: true,
      prologue: EMPTY,
      s: si,
      rs: sr.publicKey,
    });
    const b = new HandshakeState({ pattern: long, initiator: false, prologue: EMPTY, s: sr });
    b.readMessage(a.writeMessage(EMPTY));
    a.readMessage(b.writeMessage(EMPTY));
    expect(toHex(a.handshakeHash())).toBe(toHex(b.handshakeHash()));
  });

  test("constructor validation: bad rs, missing rs, bad s", () => {
    const s = randomKeypair();
    const base = { pattern: PATTERN_IK, prologue: EMPTY, s };
    expect(() => new HandshakeState({ ...base, initiator: true })).toThrow(
      "lan-noise: remote static required",
    );
    expect(() => new HandshakeState({ ...base, initiator: true, rs: new Uint8Array(3) })).toThrow(
      "lan-noise: invalid key length",
    );
    expect(
      () =>
        new HandshakeState({
          ...base,
          initiator: false,
          s: { publicKey: s.publicKey, secretKey: new Uint8Array(3) },
        }),
    ).toThrow("lan-noise: invalid key length");
  });

  test("a malformed pattern (a DH token before its key exists) throws instead of guessing", () => {
    const bad: HandshakePattern = {
      name: "BAD",
      preMessages: { initiator: [], responder: ["s"] },
      messages: [["es"], ["e"]],
    };
    const sr = randomKeypair();
    const init = new HandshakeState({
      pattern: bad,
      initiator: true,
      prologue: EMPTY,
      s: randomKeypair(),
      rs: sr.publicKey,
    });
    expect(() => init.writeMessage(EMPTY)).toThrow("lan-noise: missing key");
    const resp = new HandshakeState({ pattern: bad, initiator: false, prologue: EMPTY, s: sr });
    expect(() => resp.readMessage(new Uint8Array(16))).toThrow(NOISE_OPEN_FAILED);
  });

  test("a pre-message other than s is not implemented", () => {
    const bad: HandshakePattern = {
      name: "BAD",
      preMessages: { initiator: ["e"], responder: [] },
      messages: [["e"]],
    };
    expect(
      () =>
        new HandshakeState({
          pattern: bad,
          initiator: false,
          prologue: EMPTY,
          s: randomKeypair(),
          rs: randomKeypair().publicKey,
        }),
    ).toThrow("lan-noise: unsupported pre-message");
  });

  test("a pattern with both statics pre-shared hashes them in the protocol's order", () => {
    const both: HandshakePattern = {
      name: "KK",
      preMessages: { initiator: ["s"], responder: ["s"] },
      messages: [
        ["e", "es", "ss"],
        ["e", "ee", "se"],
      ],
    };
    const si = randomKeypair();
    const sr = randomKeypair();
    const a = new HandshakeState({
      pattern: both,
      initiator: true,
      prologue: EMPTY,
      s: si,
      rs: sr.publicKey,
    });
    const b = new HandshakeState({
      pattern: both,
      initiator: false,
      prologue: EMPTY,
      s: sr,
      rs: si.publicKey,
    });
    b.readMessage(a.writeMessage(EMPTY));
    a.readMessage(b.writeMessage(EMPTY));
    expect(toHex(a.handshakeHash())).toBe(toHex(b.handshakeHash()));
  });
});

/** Independent reference: AES-256-GCM through node:crypto with the Noise nonce, no CipherState. */
function refEncrypt(key: Uint8Array, n: bigint, ad: Uint8Array, pt: Uint8Array): Uint8Array {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, n, false);
  const c = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  c.setAAD(ad);
  const body = Buffer.concat([c.update(pt), c.final()]);
  return new Uint8Array(Buffer.concat([body, c.getAuthTag()]));
}

describe("CipherState", () => {
  const key = new Uint8Array(32).fill(7);

  test("the nonce is 4 zero bytes then the big-endian counter, and it increments per call", () => {
    const cs = new CipherState(key);
    const pt = new Uint8Array([9, 9]);
    expect(toHex(cs.encryptWithAd(EMPTY, pt))).toBe(toHex(refEncrypt(key, 0n, EMPTY, pt)));
    expect(toHex(cs.encryptWithAd(EMPTY, pt))).toBe(toHex(refEncrypt(key, 1n, EMPTY, pt)));
    expect(cs.nonce()).toBe(2n);
  });

  test("a counter above 255 uses big-endian bytes", () => {
    const cs = new CipherState(key, 0x0102n);
    const pt = new Uint8Array([1]);
    expect(toHex(cs.encryptWithAd(EMPTY, pt))).toBe(toHex(refEncrypt(key, 0x0102n, EMPTY, pt)));
  });

  test("rekey() is the first 32 bytes of ENCRYPT(k, 2^64-1, empty, 32 zero bytes) and does not reset n", () => {
    const cs = new CipherState(key, 5n);
    const expected = refEncrypt(key, 2n ** 64n - 1n, EMPTY, new Uint8Array(32)).slice(0, 32);
    const before = cs.keyFingerprint();
    cs.rekey();
    expect(cs.keyFingerprint()).not.toBe(before);
    expect(cs.keyFingerprint()).toBe(createHash("sha256").update(expected).digest("hex"));
    expect(cs.nonce()).toBe(5n);
    const pt = new Uint8Array([4]);
    expect(toHex(cs.encryptWithAd(EMPTY, pt))).toBe(toHex(refEncrypt(expected, 5n, EMPTY, pt)));
  });

  test("a CipherState at n = 2^64-2 encrypts once and then throws, and decrypt likewise", () => {
    const limit = 2n ** 64n - 2n;
    const enc = new CipherState(key, limit);
    const dec = new CipherState(key, limit);
    const ct = enc.encryptWithAd(EMPTY, new Uint8Array([1]));
    expect(dec.decryptWithAd(EMPTY, ct)[0]).toBe(1);
    expect(() => enc.encryptWithAd(EMPTY, new Uint8Array([1]))).toThrow(
      "lan-noise: nonce space exhausted",
    );
    expect(() => dec.decryptWithAd(EMPTY, ct)).toThrow("lan-noise: nonce space exhausted");
  });

  test("tampered ciphertext, wrong AD, wrong key and truncation all throw the same fixed message", () => {
    const a = new CipherState(key);
    const ct = a.encryptWithAd(new Uint8Array([1]), new Uint8Array([5, 6, 7]));
    const msgs: string[] = [];
    const tryOpen = (cs: CipherState, ad: Uint8Array, data: Uint8Array) => {
      try {
        cs.decryptWithAd(ad, data);
      } catch (e) {
        msgs.push((e as Error).message);
      }
    };
    const flipped = ct.slice();
    flipped[0] = (flipped[0] as number) ^ 1;
    tryOpen(new CipherState(key), new Uint8Array([1]), flipped);
    tryOpen(new CipherState(key), new Uint8Array([2]), ct);
    tryOpen(new CipherState(new Uint8Array(32).fill(8)), new Uint8Array([1]), ct);
    tryOpen(new CipherState(key), new Uint8Array([1]), ct.slice(0, 10));
    tryOpen(new CipherState(key), new Uint8Array([1]), new Uint8Array(0));
    expect(msgs).toEqual(Array(5).fill(NOISE_OPEN_FAILED));
  });

  test("a failed open does not advance n", () => {
    const cs = new CipherState(key);
    expect(() => cs.decryptWithAd(EMPTY, new Uint8Array(40))).toThrow(NOISE_OPEN_FAILED);
    expect(cs.nonce()).toBe(0n);
  });

  test("a CipherState without a key passes data through and cannot rekey", () => {
    const cs = new CipherState(undefined);
    expect(cs.hasKey()).toBe(false);
    const d = new Uint8Array([1, 2]);
    expect(cs.encryptWithAd(EMPTY, d)).toEqual(d);
    expect(cs.decryptWithAd(EMPTY, d)).toEqual(d);
    expect(() => cs.rekey()).toThrow("lan-noise: no key");
    expect(() => cs.keyFingerprint()).toThrow("lan-noise: no key");
  });

  test("a wrong-sized key is refused", () => {
    expect(() => new CipherState(new Uint8Array(16))).toThrow("lan-noise: invalid key length");
  });

  test("a plaintext that would exceed 65,535 bytes with its tag is refused", () => {
    const cs = new CipherState(key);
    expect(() => cs.encryptWithAd(EMPTY, new Uint8Array(65_520))).toThrow(
      "lan-noise: message too large",
    );
    expect(cs.encryptWithAd(EMPTY, new Uint8Array(65_519))).toHaveLength(65_535);
  });
});
