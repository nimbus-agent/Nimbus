import { timingSafeEqual } from "node:crypto";

export function sha256HexEqualConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length || a.length !== 64) return false;
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, "hex");
    bufB = Buffer.from(b, "hex");
  } catch {
    return false;
  }
  if (bufA.length !== 32 || bufB.length !== 32) return false;
  return timingSafeEqual(bufA, bufB);
}

export function constantTimeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
