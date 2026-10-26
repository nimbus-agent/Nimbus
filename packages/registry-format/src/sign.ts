/**
 * Signing a registry index with a raw Ed25519 seed (node:crypto), for the maintainer and
 * publishing tools. The bytes signed are `registryIndexSigningBytes` — the same function the
 * verifier reads — and the golden vector in `index-format.test.ts` pins them.
 */
import { createPublicKey, sign, verify } from "node:crypto";

import { privateKeyFromSeed } from "./ed25519-seed.ts";
import { type RegistryIndex, registryIndexSigningBytes } from "./index-format.ts";

/** The 32-byte public point for a 32-byte Ed25519 seed. */
export function publicKeyFromSeed(seed: Uint8Array): Uint8Array {
  const jwk = createPublicKey(privateKeyFromSeed(seed)).export({ format: "jwk" }) as { x: string };
  return new Uint8Array(Buffer.from(jwk.x, "base64url"));
}

// SPKI wrapper for a raw 32-byte Ed25519 public key.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** True when `index.signature` verifies against `index.rootKey` over the canonical bytes. */
export function verifyIndexSignature(index: RegistryIndex): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(index.rootKey, "base64")]),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      registryIndexSigningBytes(index),
      key,
      Buffer.from(index.signature, "base64"),
    );
  } catch {
    return false;
  }
}

export function emptyIndex(rootKeyB64: string): Omit<RegistryIndex, "signature"> {
  return {
    format: 1,
    rootKey: rootKeyB64,
    sequence: 1,
    generatedAt: new Date().toISOString(),
    extensions: {},
  };
}

/**
 * Not `async`: nothing here awaits, but a bad key still rejects rather than throws (the executor's
 * throw becomes the rejection). Not `Promise.try`: the registry action runs this under the
 * runner's Node, which may not have it.
 */
export function signIndex(
  unsigned: Omit<RegistryIndex, "signature">,
  privkey: Uint8Array,
): Promise<RegistryIndex> {
  return new Promise((resolve) => {
    const { signature: _omitted, ...rest } = unsigned as RegistryIndex;
    const sig = sign(null, registryIndexSigningBytes(rest), privateKeyFromSeed(privkey));
    resolve({ ...rest, signature: sig.toString("base64") });
  });
}
