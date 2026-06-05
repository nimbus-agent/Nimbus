import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";

export interface BoxKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function generateBoxKeypair(): BoxKeypair {
  const kp = nacl.box.keyPair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

export function sealBoxFrame(
  plaintext: Uint8Array,
  peerPublicKey: Uint8Array,
  ownSecretKey: Uint8Array,
): Uint8Array {
  const nonce = new Uint8Array(randomBytes(24));
  const ct = nacl.box(plaintext, nonce, peerPublicKey, ownSecretKey);
  const out = new Uint8Array(24 + ct.length);
  out.set(nonce, 0);
  out.set(ct, 24);
  return out;
}

export function openBoxFrame(
  frame: Uint8Array,
  peerPublicKey: Uint8Array,
  ownSecretKey: Uint8Array,
): Uint8Array {
  if (frame.length < 24 + 16) {
    throw new Error("frame too short");
  }
  const nonce = frame.slice(0, 24);
  const ct = frame.slice(24);
  const plain = nacl.box.open(ct, nonce, peerPublicKey, ownSecretKey);
  if (!plain) {
    throw new Error("NaCl box open failed (tampered or wrong key)");
  }
  return plain;
}

export function boxKeypairFromSecretKey(secretKey: Uint8Array): BoxKeypair {
  if (secretKey.length !== 32) {
    throw new Error(`box secret key must be 32 bytes, got ${secretKey.length}`);
  }
  const kp = nacl.box.keyPair.fromSecretKey(secretKey);
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}
