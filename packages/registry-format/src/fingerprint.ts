import { createHash } from "node:crypto";

/** The first 32 hex characters of the SHA-256 of a base64 Ed25519 public key, as shown to owners. */
export function publisherKeyFingerprint(base64Key: string): string {
  return createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("hex").slice(0, 32);
}
