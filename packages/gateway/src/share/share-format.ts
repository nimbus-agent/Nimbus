import { decodeBase64 } from "@nimbus-dev/sdk";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import nacl from "tweetnacl";

export const SHARE_FORMAT = "nimbus-share/v1";

export interface ShareOrigin {
  readonly label: string;
  readonly pubkey: string;
}
export interface ShareTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: number;
}
export interface ShareToolCall {
  readonly toolId: string;
  readonly service: string;
  readonly params: unknown;
  readonly status: string;
}
export interface ShareBody {
  readonly kind: "transcript" | "recipe";
  readonly sessionId: string;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly redactionSet: readonly string[];
  readonly origin: ShareOrigin;
  readonly turns?: readonly ShareTurn[];
  readonly toolCalls?: readonly ShareToolCall[];
  readonly recipe?: unknown;
}
export interface ShareForwardingHop {
  readonly gatewayLabel: string;
  readonly pubkey: string;
  readonly sig: string;
}
export interface ShareFile {
  readonly format: string;
  readonly contentHash: string;
  readonly body: ShareBody;
  readonly sig: { readonly alg: "ed25519"; readonly pubkey: string; readonly signature: string };
  readonly forwarding: { readonly hops: number; readonly chain: readonly ShareForwardingHop[] };
}

/**
 * Stable, key-sorted JSON of the body — the canonical bytes for hashing + signing.
 *
 * Forked from the SDK `canonicalize` (not reused): a share body carries arbitrary tool-call
 * `params: unknown` and `recipe: unknown`, which can legitimately contain non-integer numbers
 * (e.g. an LLM temperature `0.7`) — the SDK canonicalizer throws `NonIntegerNumberInManifest`
 * on those. This key-sorter tolerates the full JSON value space `JSON.stringify` accepts.
 */
export function canonicalizeBody(body: ShareBody): Uint8Array {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        o[k] = sortKeys((v as Record<string, unknown>)[k]);
      }
      return o;
    }
    return v;
  };
  return new TextEncoder().encode(JSON.stringify(sortKeys(body)));
}

export function contentHash(body: ShareBody): string {
  return bytesToHex(blake3(canonicalizeBody(body)));
}

export function buildShareFile(body: ShareBody, privkeyB64: string, pubkeyB64: string): ShareFile {
  const canonical = canonicalizeBody(body);
  const seed = decodeBase64(privkeyB64);
  if (seed.length !== 32) {
    throw new TypeError(`share signing key must be a 32-byte seed, got ${seed.length}`);
  }
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const signature = Buffer.from(nacl.sign.detached(canonical, kp.secretKey)).toString("base64");
  return {
    format: SHARE_FORMAT,
    contentHash: contentHash(body),
    body,
    sig: { alg: "ed25519", pubkey: pubkeyB64, signature },
    forwarding: { hops: 0, chain: [] },
  };
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly signatureValid: boolean;
  readonly contentHashValid: boolean;
  readonly expired: boolean;
  readonly errors: readonly string[];
}

export function verifyShareBytes(bytes: Uint8Array, opts?: { now?: number }): VerifyResult {
  const now = opts?.now ?? Date.now();
  const errors: string[] = [];
  let parsed: ShareFile;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as ShareFile;
  } catch {
    return {
      ok: false,
      signatureValid: false,
      contentHashValid: false,
      expired: false,
      errors: ["malformed json"],
    };
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof (parsed as ShareFile).body !== "object" ||
    (parsed as ShareFile).body === null ||
    typeof (parsed as ShareFile).sig !== "object" ||
    (parsed as ShareFile).sig === null
  ) {
    return {
      ok: false,
      signatureValid: false,
      contentHashValid: false,
      expired: false,
      errors: ["not a share file"],
    };
  }
  if (parsed.format !== SHARE_FORMAT) errors.push(`unexpected format: ${String(parsed.format)}`);
  const canonical = canonicalizeBody(parsed.body);
  const contentHashValid = contentHash(parsed.body) === parsed.contentHash;
  if (!contentHashValid) errors.push("content hash mismatch");
  let signatureValid = false;
  try {
    signatureValid = nacl.sign.detached.verify(
      canonical,
      decodeBase64(parsed.sig.signature),
      decodeBase64(parsed.sig.pubkey),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) errors.push("signature invalid");
  const expired = parsed.body.expiresAt !== null && parsed.body.expiresAt < now;
  return {
    ok: signatureValid && contentHashValid,
    signatureValid,
    contentHashValid,
    expired,
    errors,
  };
}
