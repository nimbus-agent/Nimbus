/**
 * A node:crypto Ed25519 private key from a raw 32-byte seed. A leaf module (it imports nothing from
 * this package) so the index, statement and feed signers can share it without an import cycle.
 */
import { createPrivateKey, type KeyObject } from "node:crypto";

// PKCS#8 wrapper for a raw 32-byte Ed25519 seed.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** A node:crypto private key for a raw 32-byte Ed25519 seed. */
export function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.byteLength !== 32) throw new Error("Ed25519 seed must be 32 bytes");
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}
