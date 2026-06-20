import { decodeBase64, encodeBase64 } from "@nimbus-dev/sdk";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import nacl from "tweetnacl";
import { ensureShareKeypair } from "../share/share-keypair.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

/** A stable BLAKE3 digest over a window's ordered row hashes — the thing the receipt signs. */
export function digestEgressWindow(rows: readonly { rowHash: string }[]): string {
  const encoder = new TextEncoder();
  return bytesToHex(blake3(encoder.encode(rows.map((r) => r.rowHash).join("|"))));
}

/**
 * Sign a window digest with the Vault-only Ed25519 share keypair (reused — no new Vault key). The
 * private seed is read inside `ensureShareKeypair` solely to thread into the in-process signing
 * call; it is NEVER returned. The result carries only the detached signature + the public key
 * (safe to surface). This is a LOCAL receipt — not the portable EAF artifact (deferred to Phase 22).
 */
export async function signWindowDigest(
  vault: NimbusVault,
  digest: string,
): Promise<{ sigB64: string; pubkeyB64: string }> {
  const { privkeyB64, pubkeyB64 } = await ensureShareKeypair(vault);
  const seed = decodeBase64(privkeyB64);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const sig = nacl.sign.detached(new TextEncoder().encode(digest), kp.secretKey);
  return { sigB64: encodeBase64(sig), pubkeyB64 };
}
