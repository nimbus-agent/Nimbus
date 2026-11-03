/**
 * Reads a regular file through ONE descriptor with a size bound: open, `fstat` that it is a regular
 * file within the cap, then read at most `max + 1` bytes, so a file that grows, a FIFO or a device
 * is never read without limit and no check names the path twice. A problem is a plain word, never
 * text copied from the OS.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export type BoundedRead = { ok: true; bytes: Buffer } | { ok: false; why: string };

export function readRegularFileBounded(path: string, max: number): BoundedRead {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { ok: false, why: "could not be opened" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, why: "not a regular file" };
    if (st.size > max) return { ok: false, why: "too large" };
    const buf = Buffer.alloc(max + 1);
    let filled = 0;
    while (filled < buf.length) {
      const n = readSync(fd, buf, filled, buf.length - filled, null);
      if (n === 0) break;
      filled += n;
    }
    if (filled > max) return { ok: false, why: "too large" };
    return { ok: true, bytes: buf.subarray(0, filled) };
  } catch {
    return { ok: false, why: "could not be read" };
  } finally {
    closeSync(fd);
  }
}
