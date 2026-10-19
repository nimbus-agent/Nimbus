import { describe, expect, test } from "bun:test";
import {
  boxKeypairFromSecretKey,
  deriveLanSessionKey,
  generateBoxKeypair,
  openSessionFrame,
  pairingProof,
  pairingProofMatches,
  sealSessionFrame,
} from "./lan-crypto.ts";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

function pairOfKeys(): {
  client: ReturnType<typeof generateBoxKeypair>;
  host: ReturnType<typeof generateBoxKeypair>;
  clientEph: ReturnType<typeof generateBoxKeypair>;
  hostEph: ReturnType<typeof generateBoxKeypair>;
} {
  return {
    client: generateBoxKeypair(),
    host: generateBoxKeypair(),
    clientEph: generateBoxKeypair(),
    hostEph: generateBoxKeypair(),
  };
}

function bothKeys(k: ReturnType<typeof pairOfKeys>): { client: Uint8Array; host: Uint8Array } {
  return {
    client: deriveLanSessionKey({
      ownStatic: k.client,
      ownEphemeral: k.clientEph,
      peerStaticPublic: k.host.publicKey,
      peerEphemeralPublic: k.hostEph.publicKey,
      role: "client",
    }),
    host: deriveLanSessionKey({
      ownStatic: k.host,
      ownEphemeral: k.hostEph,
      peerStaticPublic: k.client.publicKey,
      peerEphemeralPublic: k.clientEph.publicKey,
      role: "host",
    }),
  };
}

describe("deriveLanSessionKey", () => {
  test("client and host derive the same 32-byte key", () => {
    const { client, host } = bothKeys(pairOfKeys());
    expect(client.length).toBe(32);
    expect(hex(client)).toBe(hex(host));
  });

  test("a different ephemeral key on either side gives a different session key", () => {
    const k = pairOfKeys();
    const first = bothKeys(k).client;
    const second = bothKeys({ ...k, hostEph: generateBoxKeypair() }).client;
    const third = bothKeys({ ...k, clientEph: generateBoxKeypair() }).client;
    expect(hex(first)).not.toBe(hex(second));
    expect(hex(first)).not.toBe(hex(third));
  });

  test("a client holding the wrong static key derives a key the host does not share", () => {
    const k = pairOfKeys();
    const host = bothKeys(k).host;
    const impostor = deriveLanSessionKey({
      ownStatic: generateBoxKeypair(), // not the key the host knows the client by
      ownEphemeral: k.clientEph,
      peerStaticPublic: k.host.publicKey,
      peerEphemeralPublic: k.hostEph.publicKey,
      role: "client",
    });
    expect(hex(impostor)).not.toBe(hex(host));
  });

  test("rejects a peer key that is not 32 bytes", () => {
    const k = pairOfKeys();
    expect(() =>
      deriveLanSessionKey({
        ownStatic: k.client,
        ownEphemeral: k.clientEph,
        peerStaticPublic: new Uint8Array(31),
        peerEphemeralPublic: k.hostEph.publicKey,
        role: "client",
      }),
    ).toThrow(/32 bytes/);
  });
});

describe("session frames", () => {
  const key = bothKeys(pairOfKeys()).client;
  const msg = new TextEncoder().encode('{"method":"index.search","params":{"q":"x"}}');

  test("seal + open with the same direction and sequence recovers the plaintext", () => {
    const frame = sealSessionFrame(key, "client_to_host", 7, msg);
    expect(new TextDecoder().decode(openSessionFrame(key, "client_to_host", 7, frame))).toBe(
      '{"method":"index.search","params":{"q":"x"}}',
    );
  });

  test("the wrong sequence number does not open (replay / reorder)", () => {
    const frame = sealSessionFrame(key, "client_to_host", 0, msg);
    expect(() => openSessionFrame(key, "client_to_host", 1, frame)).toThrow();
  });

  test("the wrong direction does not open (reflection)", () => {
    const frame = sealSessionFrame(key, "client_to_host", 0, msg);
    expect(() => openSessionFrame(key, "host_to_client", 0, frame)).toThrow();
  });

  test("a tampered byte or another session's key does not open", () => {
    const frame = sealSessionFrame(key, "client_to_host", 0, msg);
    const tampered = frame.slice();
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;
    expect(() => openSessionFrame(key, "client_to_host", 0, tampered)).toThrow();
    const otherKey = bothKeys(pairOfKeys()).client;
    expect(() => openSessionFrame(otherKey, "client_to_host", 0, frame)).toThrow();
    expect(() => openSessionFrame(key, "client_to_host", 0, new Uint8Array(4))).toThrow(/short/);
  });

  test("a negative or fractional sequence number is refused", () => {
    expect(() => sealSessionFrame(key, "client_to_host", -1, msg)).toThrow();
    expect(() => sealSessionFrame(key, "client_to_host", 1.5, msg)).toThrow();
  });

  test("the nonce is never on the wire: the frame is ciphertext + MAC only", () => {
    const frame = sealSessionFrame(key, "client_to_host", 0, msg);
    expect(frame.length).toBe(msg.length + 16);
  });
});

describe("pairingProof", () => {
  const client = generateBoxKeypair().publicKey;
  const host = generateBoxKeypair().publicKey;

  test("deterministic for the same code and keys, and verified in constant time", () => {
    const a = pairingProof("CODE123", "client", client);
    const b = pairingProof("CODE123", "client", client);
    expect(a.length).toBe(32);
    expect(pairingProofMatches(a, b)).toBe(true);
  });

  test("client and host proofs differ, and each is bound to the code and the keys", () => {
    const c = pairingProof("CODE123", "client", client);
    const h = pairingProof("CODE123", "host", client, host);
    expect(pairingProofMatches(c, h)).toBe(false);
    expect(pairingProofMatches(c, pairingProof("CODE124", "client", client))).toBe(false);
    expect(pairingProofMatches(c, pairingProof("CODE123", "client", host))).toBe(false);
    const swappedHost = pairingProof("CODE123", "host", client, generateBoxKeypair().publicKey);
    expect(pairingProofMatches(h, swappedHost)).toBe(false);
  });

  test("a host proof needs the host key; a short received proof never matches", () => {
    expect(() => pairingProof("CODE123", "host", client)).toThrow(/host key/);
    expect(pairingProofMatches(pairingProof("C", "client", client), new Uint8Array(0))).toBe(false);
  });
});

test("boxKeypairFromSecretKey recovers the same keypair from its secret", () => {
  const kp = generateBoxKeypair();
  const recovered = boxKeypairFromSecretKey(kp.secretKey);
  expect(hex(recovered.publicKey)).toBe(hex(kp.publicKey));
  expect(hex(recovered.secretKey)).toBe(hex(kp.secretKey));
});

test("boxKeypairFromSecretKey rejects a wrong-length secret", () => {
  expect(() => boxKeypairFromSecretKey(new Uint8Array(31))).toThrow();
});
