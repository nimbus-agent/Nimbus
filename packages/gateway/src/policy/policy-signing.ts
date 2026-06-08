import nacl from "tweetnacl";

/**
 * Canonical byte form for signing/verifying. Both sign and verify call this,
 * so CRLF↔LF/BOM/trailing-whitespace rewrites by git or editors cannot break a
 * signature across platforms (platform-equality, non-negotiable #5).
 */
export function canonicalize(toml: string): string {
  let s = toml;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // strip UTF-8 BOM
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n"); // LF only
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "")) // trailing whitespace per line
    .join("\n");
  s = `${s.replace(/\n+$/g, "")}\n`; // exactly one trailing newline
  return s;
}

const enc = new TextEncoder();

/**
 * Detached Ed25519 signature (Uint8Array, 64 bytes) over canonicalize(toml).
 * privkey is a 32-byte Ed25519 seed (as returned by generateEd25519Keypair()
 * from @nimbus-dev/sdk). Internally expanded to the 64-byte nacl secret key
 * via nacl.sign.keyPair.fromSeed().
 */
export function signPolicy(toml: string, privkey: Uint8Array): Uint8Array {
  const kp = nacl.sign.keyPair.fromSeed(privkey);
  const msg = enc.encode(canonicalize(toml));
  return nacl.sign.detached(msg, kp.secretKey);
}

/**
 * Verify a detached Ed25519 signature (Uint8Array, 64 bytes) against the
 * 32-byte public key returned by generateEd25519Keypair(). Returns false on
 * any error or mismatch (fail-closed).
 */
export function verifyPolicy(toml: string, sig: Uint8Array, pubkey: Uint8Array): boolean {
  try {
    const msg = enc.encode(canonicalize(toml));
    return nacl.sign.detached.verify(msg, sig, pubkey);
  } catch {
    return false;
  }
}
