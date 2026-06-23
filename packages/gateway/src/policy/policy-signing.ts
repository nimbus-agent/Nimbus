import { decodeBase64, encodeBase64 } from "@nimbus-dev/sdk";
import nacl from "tweetnacl";

// Linear (no-regex) trailing strip. Replaces trailing `[...]+$` / `\n+$` regexes
// whose unanchored start scan is O(n²) on adversarial input (S8786). Exact-match
// the original char sets so the signed canonical bytes never change.
function stripTrailing(s: string, isStrippable: (ch: string) => boolean): string {
  let end = s.length;
  while (end > 0 && isStrippable(s.charAt(end - 1))) end--;
  return s.slice(0, end);
}

/** Canonical byte form for signing/verifying (CRLF/BOM/trailing-ws/EOF-newline stable). */
export function canonicalize(toml: string): string {
  let s = toml;
  // Strip ONLY a leading BOM (an encoding artifact). A mid-document U+FEFF can be
  // meaningful content (e.g. inside a string value), so stripping it globally would let
  // two semantically-different payloads collapse to the same signed bytes (collision).
  if (s.codePointAt(0) === 0xfeff) s = s.slice(1);
  s = s.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  s = s
    .split("\n")
    .map((line) => stripTrailing(line, (c) => c === " " || c === "\t"))
    .join("\n");
  s = `${stripTrailing(s, (c) => c === "\n")}\n`;
  return s;
}

const enc = new TextEncoder();

/** Detached Ed25519 signature (base64) over canonicalize(toml). `privkeyB64` is the base64 of the 32-byte SDK seed. */
export function signPolicy(toml: string, privkeyB64: string): string {
  const seed = decodeBase64(privkeyB64);
  if (seed.length !== 32)
    throw new TypeError(`signPolicy: expected 32-byte seed, got ${seed.length}`);
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
