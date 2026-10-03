import { asRecord } from "./unknown-record.ts";

export function encodeNimbusJsonCursor(prefix: string, payload: unknown): string {
  return prefix + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeNimbusJsonCursorPayload(raw: string, prefix: string): unknown {
  if (!raw.startsWith(prefix)) {
    return undefined;
  }
  try {
    const json = Buffer.from(raw.slice(prefix.length), "base64url").toString("utf8");
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Decode a cursor whose payload must be a plain JSON object, or `null` when there is none to read:
 * no cursor, an empty one, another connector's prefix, a payload that does not decode, or one that
 * decodes to an array, a scalar or `null`. A connector's own decoder keeps only its field checks.
 */
export function decodeNimbusJsonCursorObject(
  raw: string | null,
  prefix: string,
): Record<string, unknown> | null {
  if (raw === null || raw === "") {
    return null;
  }
  return asRecord(decodeNimbusJsonCursorPayload(raw, prefix)) ?? null;
}
