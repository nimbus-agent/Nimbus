import { decodeBase64, encodeBase64 } from "@nimbus-dev/sdk";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import nacl from "tweetnacl";
import { ensureShareKeypair } from "../share/share-keypair.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

/**
 * A stable BLAKE3 digest over a window's ordered row hashes AND its counted totals — the thing the
 * receipt signs.
 *
 * The totals are bound in, not just the rows, because `rows` is a page: `listEgress` caps it at
 * 1000 by default. Signing the page alone produced a receipt that attested a truncated prefix of
 * the window while the printed count claimed the whole of it — the signature was over different
 * evidence than the claim it accompanied. Binding `outboundEgressEvents` and `rowsTotal` means a
 * receipt cannot be reused to vouch for a window whose totals differ, even when the visible page
 * is identical.
 *
 * The `v2` tag is part of the hashed payload so a digest produced under the old (rows-only) rule
 * can never collide with one produced under this rule. Receipts are local and short-lived (the
 * portable EAF artifact is deferred), and nothing verifies a stored digest, so there is no
 * compatibility surface to preserve here.
 */
export function digestEgressWindow(
  rows: readonly { rowHash: string }[],
  summary: { outboundEgressEvents: number; rowsTotal: number },
): string {
  const payload = [
    "nimbus-egress-window-v2",
    `outbound=${summary.outboundEgressEvents}`,
    `rowsTotal=${summary.rowsTotal}`,
    rows.map((r) => r.rowHash).join("|"),
  ].join("\n");
  return bytesToHex(blake3(new TextEncoder().encode(payload)));
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
