/**
 * CLI-side builder for the signed registry index. The wire types duplicate the gateway's
 * `extensions/registry/index-format.ts` (the packages may not import each other); the golden vector
 * in `registry-index.test.ts` is the contract that keeps the two byte-identical.
 */
import { createPrivateKey, createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// NOSONAR S1874: deprecated in SDK 1.32.0. The gateway verifies these bytes with the SAME export
// (`extensions/canonical-json.ts`); `@nimbus-dev/sdk/signing` NFC-normalises differently and would
// produce signatures the gateway rejects for any non-ASCII string.
import { canonicalize } from "@nimbus-dev/sdk"; // NOSONAR S1874

export type RegistryChannel = "stable" | "beta";

export interface RegistryVersionEntry {
  channel: RegistryChannel;
  name: string;
  manifest: string;
  manifestSha256: string;
  package: string;
  packageSha256: string;
  packageSizeBytes: number;
  entryHash: string;
  publishedAt: string;
}

export interface RegistryExtensionEntry {
  publisher: { id: string; key: string };
  versions: Readonly<Record<string, RegistryVersionEntry>>;
}

export interface RegistryIndex {
  format: 1;
  rootKey: string;
  sequence: number;
  generatedAt: string;
  extensions: Readonly<Record<string, RegistryExtensionEntry>>;
  signature: string;
}

// PKCS#8 wrapper for a raw 32-byte Ed25519 seed.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.byteLength !== 32) throw new Error("Ed25519 seed must be 32 bytes");
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/** The 32-byte public point for a 32-byte Ed25519 seed. */
export function publicKeyFromSeed(seed: Uint8Array): Uint8Array {
  const jwk = createPublicKey(privateKeyFromSeed(seed)).export({ format: "jwk" }) as { x: string };
  return new Uint8Array(Buffer.from(jwk.x, "base64url"));
}

// SPKI wrapper for a raw 32-byte Ed25519 public key.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** True when `index.signature` verifies against `index.rootKey` over the canonical bytes. */
export function verifyIndexSignature(index: RegistryIndex): boolean {
  try {
    const { signature, ...rest } = index;
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(index.rootKey, "base64")]),
      format: "der",
      type: "spki",
    });
    const bytes = new TextEncoder().encode(canonicalize(rest)); // NOSONAR S1874
    return verify(null, bytes, key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function emptyIndex(rootKeyB64: string): Omit<RegistryIndex, "signature"> {
  return {
    format: 1,
    rootKey: rootKeyB64,
    sequence: 1,
    generatedAt: new Date().toISOString(),
    extensions: {},
  };
}

export async function signIndex(
  unsigned: Omit<RegistryIndex, "signature">,
  privkey: Uint8Array,
): Promise<RegistryIndex> {
  const { signature: _omitted, ...rest } = unsigned as RegistryIndex;
  const bytes = new TextEncoder().encode(canonicalize(rest)); // NOSONAR S1874
  const sig = sign(null, bytes, privateKeyFromSeed(privkey));
  return { ...rest, signature: sig.toString("base64") };
}

/** Structural parse only: the signature is verified by the gateway, not here. */
export function readIndexFile(path: string): RegistryIndex {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path} is not a registry index object`);
  }
  const o = raw as Record<string, unknown>;
  if (
    o["format"] !== 1 ||
    typeof o["rootKey"] !== "string" ||
    typeof o["sequence"] !== "number" ||
    typeof o["generatedAt"] !== "string" ||
    typeof o["signature"] !== "string" ||
    o["extensions"] === null ||
    typeof o["extensions"] !== "object"
  ) {
    throw new Error(`${path} is not a valid registry index`);
  }
  return o as unknown as RegistryIndex;
}

export function writeIndexAtomic(dir: string, index: RegistryIndex): void {
  const tmp = join(dir, `index.json.${String(process.pid)}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`);
  renameSync(tmp, join(dir, "index.json"));
}
