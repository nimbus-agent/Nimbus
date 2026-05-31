import { createHash } from "node:crypto";

export const NIMBUS_PERSON_NAMESPACE_UUID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function uuidStringToBytes(uuid: string): Buffer {
  const hex = uuid.replaceAll("-", "");
  if (hex.length !== 32) {
    throw new Error("Invalid namespace UUID");
  }
  return Buffer.from(hex, "hex");
}

function bytesToUuid(buf: Buffer): string {
  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function uuidV5(name: string, namespaceUuid: string): string {
  const ns = uuidStringToBytes(namespaceUuid);
  const hash = createHash("sha256");
  hash.update(ns);
  hash.update(name, "utf8");
  const digest = hash.digest();
  const b6 = digest[6];
  const b8 = digest[8];
  if (b6 === undefined || b8 === undefined) {
    throw new Error("unexpected SHA-256 digest length");
  }
  digest[6] = (b6 & 0x0f) | 0x80;
  digest[8] = (b8 & 0x3f) | 0x80;
  return bytesToUuid(digest.subarray(0, 16));
}
