import nacl from "tweetnacl";

export interface BoxKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function generateBoxKeypair(): BoxKeypair {
  const kp = nacl.box.keyPair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

export function boxKeypairFromSecretKey(secretKey: Uint8Array): BoxKeypair {
  if (secretKey.length !== 32) {
    throw new Error(`box secret key must be 32 bytes, got ${secretKey.length}`);
  }
  const kp = nacl.box.keyPair.fromSecretKey(secretKey);
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}
