import { createHash } from "node:crypto";
import nacl from "tweetnacl";

export function verifyBinarySignature(
  binary: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) {
    return false;
  }
  try {
    const digest = new Uint8Array(createHash("sha256").update(binary).digest());
    return nacl.sign.detached.verify(digest, signature, publicKey);
  } catch {
    return false;
  }
}

export function sha256Hex(binary: Uint8Array): string {
  return createHash("sha256").update(binary).digest("hex");
}

export function verifyManifestEnvelope(input: {
  version: string;
  target: string;
  sha256: string;
  signature: Uint8Array;
  publicKey: Uint8Array;
}): boolean {
  if (input.signature.length !== 64 || input.publicKey.length !== 32) return false;
  const envelope = JSON.stringify({
    version: input.version,
    target: input.target,
    sha256: input.sha256,
  });
  try {
    const bytes = new TextEncoder().encode(envelope);
    return nacl.sign.detached.verify(bytes, input.signature, input.publicKey);
  } catch {
    return false;
  }
}
