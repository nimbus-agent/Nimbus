import { decodeBase64, encodeBase64 } from "@nimbus-dev/sdk";
import nacl from "tweetnacl";

export interface DeletionRecord {
  readonly externalId: string;
  readonly peerId: string;
  readonly deletedCount: number;
  readonly at: number;
}

/** Stable canonical JSON (sorted keys) so sign/verify agree byte-for-byte. */
function canonicalJson(r: DeletionRecord): string {
  return JSON.stringify({
    at: r.at,
    deletedCount: r.deletedCount,
    externalId: r.externalId,
    peerId: r.peerId,
  });
}

const enc = new TextEncoder();

/** Sign with the gateway's Ed25519 SEED (base64 of the 32-byte SDK privkey). Returns base64 sig. */
export function signDeletionRecord(r: DeletionRecord, privkeyB64: string): string {
  const kp = nacl.sign.keyPair.fromSeed(decodeBase64(privkeyB64));
  return encodeBase64(nacl.sign.detached(enc.encode(canonicalJson(r)), kp.secretKey));
}

/** Verify against the base64 pubkey. False (never throws) on malformed input. */
export function verifyDeletionRecord(
  r: DeletionRecord,
  sigB64: string,
  pubKeyB64: string,
): boolean {
  try {
    return nacl.sign.detached.verify(
      enc.encode(canonicalJson(r)),
      decodeBase64(sigB64),
      decodeBase64(pubKeyB64),
    );
  } catch {
    return false;
  }
}
