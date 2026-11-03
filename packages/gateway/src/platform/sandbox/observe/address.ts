/**
 * Address decoding shared by the Windows and macOS connection sources: both OSes hand back ports as
 * a DWORD in network byte order and IPv6 addresses as 16 raw bytes, so both print them here, and
 * the poller's `canonicalIp` reads one text form whichever OS produced it.
 */

/** The port held in network byte order in the low 16 bits of a DWORD. */
export function portFromDword(v: number): number {
  return ((v & 0xff) << 8) | ((v >>> 8) & 0xff);
}

/** Four address bytes as `a.b.c.d`. */
export function dotted(buf: Buffer, offset: number): string {
  return `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
}

/** The first longest run (length >= 2) of zero groups, as RFC 5952 compresses it. */
function longestZeroRun(groups: readonly number[]): { start: number; len: number } {
  let best = { start: -1, len: 0 };
  let start = -1;
  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === 0) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0 && i - start > best.len) best = { start, len: i - start };
    start = -1;
  }
  return best.len >= 2 ? best : { start: -1, len: 0 };
}

/** RFC 5952 text for 16 address bytes: lowercase, compressed, IPv4-mapped as `::ffff:a.b.c.d`. */
export function formatIpv6(buf: Buffer, offset: number): string {
  const groups: number[] = [];
  for (let i = 0; i < 8; i++) groups.push(buf.readUInt16BE(offset + i * 2));
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `::ffff:${dotted(buf, offset + 12)}`;
  }
  const hex = groups.map((g) => g.toString(16));
  const run = longestZeroRun(groups);
  if (run.start < 0) return hex.join(":");
  const head = hex.slice(0, run.start).join(":");
  const tail = hex.slice(run.start + run.len).join(":");
  return `${head}::${tail}`;
}
