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
  // utf16le is a bijection on JS strings (2 bytes per code unit, no replacement),
  // so distinct strings — including lone surrogates — never produce equal buffers.
  // (utf8 collapses lone surrogates / U+FFFD to EF BF BD, a false-positive source.)
  const aBuf = Buffer.from(a, "utf16le");
  const bBuf = Buffer.from(b, "utf16le");
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
