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
