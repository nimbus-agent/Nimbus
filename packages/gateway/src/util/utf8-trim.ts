/**
 * Drop a trailing INCOMPLETE UTF-8 sequence.
 *
 * Needed only where WE made the cut. Mid-stream splits are healed by concatenating every chunk
 * before decoding; but an output cap can slice mid-character, and decoding that fragment yields a
 * U+FFFD we manufactured ourselves. That is worse than it looks: U+FFFD re-encodes to 3 bytes, so
 * cutting four emoji at a 10-byte cap produced 11 bytes of output — back OVER the very cap the
 * trim was enforcing.
 *
 * Shared by the two byte-capped output collectors, `exec/exec-run.ts`'s `runConfined` (I33) and
 * the computer-use terminal lane `computer-use/cu-lanes/terminal.ts` (I35). Each calls it only
 * when it truncated the stream itself, so genuinely invalid UTF-8 from the child is reported
 * as-is rather than quietly losing its last byte. Pure: returns `buf` itself, or a `subarray` of
 * it, and never copies.
 */
export function trimPartialUtf8(buf: Uint8Array): Uint8Array {
  for (let back = 1; back <= 4 && back <= buf.length; back++) {
    const b = buf[buf.length - back] as number;
    if ((b & 0xc0) === 0x80) continue; // continuation byte — keep walking back to the lead byte
    return sequenceLength(b) === back ? buf : buf.subarray(0, buf.length - back);
  }
  return buf;
}

/** How many bytes the UTF-8 sequence starting with this lead byte occupies. */
function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  return 4;
}
