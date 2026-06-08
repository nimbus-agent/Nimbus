import { decodeBase64, encodeBase64 } from "@nimbus-dev/sdk";
import nacl from "tweetnacl";

/** Canonical byte form for signing/verifying (CRLF/BOM/trailing-ws/EOF-newline stable). */
export function canonicalize(toml: string): string {
  let s = toml;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");
  s = `${s.replace(/\n+$/g, "")}\n`;
  return s;
}

const enc = new TextEncoder();

/** Detached Ed25519 signature (base64) over canonicalize(toml). `privkeyB64` is the base64 of the 32-byte SDK seed. */
export function signPolicy(toml: string, privkeyB64: string): string {
  const seed = decodeBase64(privkeyB64);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const sig = nacl.sign.detached(enc.encode(canonicalize(toml)), kp.secretKey);
  return encodeBase64(sig);
}

/** Verify a detached base64 signature against the base64 pubkey. Returns false on any malformed input. */
export function verifyPolicy(toml: string, sigB64: string, pubKeyB64: string): boolean {
  try {
    return nacl.sign.detached.verify(
      enc.encode(canonicalize(toml)),
      decodeBase64(sigB64),
      decodeBase64(pubKeyB64),
    );
  } catch {
    return false;
  }
}
