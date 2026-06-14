import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import { sha256Hex } from "../signature-verifier.ts";
import type { PlatformTarget, UpdateManifest } from "../types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
export function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: JSON_HEADERS });
}

export function makeKeypair(): nacl.SignKeyPair {
  return nacl.sign.keyPair.fromSeed(new Uint8Array(randomBytes(32)));
}

export function buildSignedManifest(
  binary: Uint8Array,
  kp: nacl.SignKeyPair,
  downloadUrl: string,
  version = "0.2.0",
): UpdateManifest {
  const sha = sha256Hex(binary);
  const sig = nacl.sign.detached(new Uint8Array(Buffer.from(sha, "hex")), kp.secretKey);
  const sigB64 = Buffer.from(sig).toString("base64");
  return {
    version,
    pub_date: "2026-05-01T00:00:00Z",
    platforms: {
      "darwin-x86_64": { url: downloadUrl, sha256: sha, signature: sigB64 },
      "darwin-aarch64": { url: downloadUrl, sha256: sha, signature: sigB64 },
      "linux-x86_64": { url: downloadUrl, sha256: sha, signature: sigB64 },
      "windows-x86_64": { url: downloadUrl, sha256: sha, signature: sigB64 },
    },
  };
}

export function buildEnvelopeSignedManifest(
  binary: Uint8Array,
  kp: nacl.SignKeyPair,
  downloadUrl: string,
  version = "0.2.0",
): UpdateManifest {
  const sha = sha256Hex(binary);
  const targets: PlatformTarget[] = [
    "darwin-x86_64",
    "darwin-aarch64",
    "linux-x86_64",
    "windows-x86_64",
  ];
  const platforms = {} as UpdateManifest["platforms"];
  for (const target of targets) {
    const envelope = JSON.stringify({ version, target, sha256: sha });
    const sig = nacl.sign.detached(new TextEncoder().encode(envelope), kp.secretKey);
    platforms[target] = {
      url: downloadUrl,
      sha256: sha,
      signature: Buffer.from(sig).toString("base64"),
    };
  }
  return {
    version,
    pub_date: "2026-05-01T00:00:00Z",
    platforms,
  };
}
