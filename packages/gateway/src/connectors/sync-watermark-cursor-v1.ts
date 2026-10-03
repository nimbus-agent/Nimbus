import { decodeNimbusJsonCursorObject, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

export type WatermarkCursorV1 = { v: 1; watermark: string | null };

export function encodeWatermarkCursorV1(prefix: string, c: WatermarkCursorV1): string {
  return encodeNimbusJsonCursor(prefix, c);
}

export function decodeWatermarkCursorV1(
  raw: string | null,
  prefix: string,
): WatermarkCursorV1 | null {
  const rec = decodeNimbusJsonCursorObject(raw, prefix);
  if (rec === null) {
    return null;
  }
  if (rec["v"] !== 1) {
    return null;
  }
  const w = rec["watermark"];
  if (w !== null && w !== undefined && typeof w !== "string") {
    return null;
  }
  return { v: 1, watermark: typeof w === "string" ? w : null };
}
