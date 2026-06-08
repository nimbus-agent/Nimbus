import { decodeBase64 } from "@nimbus-dev/sdk";
import type { PolicyStore } from "./policy-store.ts";

/** Manually pin an org policy pubkey (the `nimbus policy trust` fallback). */
export function trustAnchorPubkey(store: PolicyStore, pubkeyB64: string, nowMs: number): void {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(pubkeyB64);
  } catch {
    throw new Error("policy trust: pubkey is not valid base64");
  }
  if (bytes.length !== 32) {
    throw new Error("policy trust: Ed25519 pubkey must be 32 bytes");
  }
  store.pinAnchorPubkey(pubkeyB64, "manual", nowMs);
}
