import nacl from "tweetnacl";
import { decodeBase64, encodeBase64 } from "../util/base64.ts";
import { generateEd25519Keypair } from "../util/ed25519.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

/**
 * Vault key for the toolgen artifact-signing Ed25519 seed (base64, 32 bytes). NEVER leaves the
 * Vault: it is read only to thread into an in-process `nacl.sign.detached` call, never returned
 * over IPC/HTTP, never persisted to a DB column, and never logged.
 *
 * What this signature defends, and what it does not. The gateway already re-hashes every
 * generated-tool artifact at boot and disables anything whose bytes changed on disk, so on-disk
 * tamper detection is not what signing adds — the expected hash lives in `nimbus.db`, and an
 * attacker with filesystem write access holds both the artifact and the database, so they rewrite
 * both together and the hash check reports green. Forging a signature instead requires this seed,
 * which lives in the OS keychain (Windows DPAPI / macOS Keychain / Linux libsecret), not on the
 * filesystem — so this defends the filesystem-write attacker, not the Vault-read attacker. Anyone
 * who can read the Vault can forge a signature, and this claims nothing against them.
 */
export const TOOLGEN_SIGNING_PRIVKEY = "toolgen.signing.privkey";
/**
 * Vault key for the toolgen artifact-signing Ed25519 public key (base64). Safe to surface — it is
 * stored per row alongside a signed artifact (see `toolgen-saved-repo.ts`'s `pubkey` column) so a
 * key rotation can be told apart from tampering.
 */
export const TOOLGEN_SIGNING_PUBKEY = "toolgen.signing.pubkey";

/**
 * The Vault-key prefix the two signing keys above share, and the ONE prefix under `toolgen.` that
 * is NOT a per-host generated-tool credential.
 *
 * Exported, and defined HERE rather than in either consumer, because two different deletion paths
 * must both skip it and a second copy is a second place for one of them to lose the exclusion:
 *
 * - `sweepToolgenCredentials` (`toolgen-credential-sweep.ts`) — the TOTAL boot/shutdown/revoke
 *   sweep over `toolgen.`, which has always skipped it.
 * - `deleteCredentialsForTool` (`toolgen-credentials.ts`) — the per-tool prefix delete behind
 *   `toolgen.revoke`, which did NOT, and could therefore be aimed at this keyspace by a caller
 *   supplying the tool id `signing`: `toolgen.${"signing"}.` IS this prefix, exactly.
 *
 * Losing the signing keypair is not a recoverable inconvenience: every already-saved tool on the
 * machine reports `pubkey_unavailable` at the next boot and can never verify again, because the
 * seed that signed it is gone from the OS keychain and nothing else holds a copy (see
 * `TOOLGEN_SIGNING_PRIVKEY` above — Vault-only, never on disk, never in the database).
 */
export const TOOLGEN_SIGNING_KEY_PREFIX = "toolgen.signing.";

/** True only if `b64` decodes from base64 to exactly `len` bytes (Ed25519 seed/pubkey = 32). */
function isValidB64Len(b64: string, len: number): boolean {
  try {
    return decodeBase64(b64).length === len;
  } catch {
    return false;
  }
}

/**
 * True only if the stored public key is the one derived from the stored private seed — i.e. they
 * form a consistent Ed25519 keypair. Guards against a partially-rotated / mismatched Vault (a
 * privkey from one keypair next to a pubkey from another), which would sign artifacts a boot-time
 * verify would then reject.
 */
function isMatchingKeypair(privkeyB64: string, pubkeyB64: string): boolean {
  try {
    const derivedPub = nacl.sign.keyPair.fromSeed(decodeBase64(privkeyB64)).publicKey;
    return encodeBase64(derivedPub) === pubkeyB64;
  } catch {
    return false;
  }
}

/**
 * Resolve the toolgen artifact-signing keypair from the Vault, generating + storing it on first
 * use. The private seed is Vault-only — it is read here solely to thread into the in-process
 * signing call in `signArtifact`; it is never returned over IPC/HTTP, persisted to a DB column, or
 * logged. Mirrors `share/share-keypair.ts` and `policy/anchor-keypair.ts`.
 *
 * A stored pair that is absent, malformed (wrong decoded length), or internally inconsistent (a
 * privkey that does not derive the stored pubkey) is treated as unusable and silently replaced —
 * this function never throws on a corrupted Vault, it regenerates.
 */
export async function ensureToolgenKeypair(
  vault: NimbusVault,
): Promise<{ privkeyB64: string; pubkeyB64: string }> {
  const existingPriv = await vault.get(TOOLGEN_SIGNING_PRIVKEY);
  const existingPub = await vault.get(TOOLGEN_SIGNING_PUBKEY);
  // Reuse persisted material only when BOTH values decode to valid 32-byte keys AND form a
  // consistent keypair. Corrupt/truncated/mismatched Vault contents are regenerated here rather
  // than deferring failure to a later signing/verify call.
  if (
    existingPriv !== null &&
    existingPub !== null &&
    isValidB64Len(existingPriv, 32) &&
    isValidB64Len(existingPub, 32) &&
    isMatchingKeypair(existingPriv, existingPub)
  ) {
    return { privkeyB64: existingPriv, pubkeyB64: existingPub };
  }
  const kp = generateEd25519Keypair();
  const privkeyB64 = encodeBase64(kp.privkey);
  const pubkeyB64 = encodeBase64(kp.pubkey);
  await vault.set(TOOLGEN_SIGNING_PRIVKEY, privkeyB64);
  await vault.set(TOOLGEN_SIGNING_PUBKEY, pubkeyB64);
  return { privkeyB64, pubkeyB64 };
}

/**
 * Detached-sign `canonicalBytes` (the portable-manifest canonical string from
 * `toolgen-artifact.ts`'s `canonicalArtifactBytes`) with the Vault-held toolgen signing seed,
 * generating the keypair on first use. The seed is read only to construct the in-process
 * `nacl.sign.keyPair.fromSeed` call below and is never included in the return value.
 */
export async function signArtifact(
  vault: NimbusVault,
  canonicalBytes: string,
): Promise<{ sigB64: string; pubkeyB64: string }> {
  const { privkeyB64, pubkeyB64 } = await ensureToolgenKeypair(vault);
  const kp = nacl.sign.keyPair.fromSeed(decodeBase64(privkeyB64));
  const sig = nacl.sign.detached(new TextEncoder().encode(canonicalBytes), kp.secretKey);
  return { sigB64: encodeBase64(sig), pubkeyB64 };
}

/**
 * Verify a detached Ed25519 signature over `canonicalBytes`. Pure and synchronous — no Vault
 * access — so a boot-time pass can verify many artifacts against one already-read pubkey without
 * a keychain round-trip per artifact. Malformed base64 in either `sigB64` or `pubkeyB64` (or a
 * length nacl rejects) returns `false` rather than throwing.
 */
export function verifyArtifactSignature(
  canonicalBytes: string,
  sigB64: string,
  pubkeyB64: string,
): boolean {
  try {
    return nacl.sign.detached.verify(
      new TextEncoder().encode(canonicalBytes),
      decodeBase64(sigB64),
      decodeBase64(pubkeyB64),
    );
  } catch {
    return false;
  }
}
