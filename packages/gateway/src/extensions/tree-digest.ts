import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  type Dirent,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * A digest over EVERY regular file in an installed extension's directory, not just its manifest and
 * entry. `manifest_hash` + `entry_hash` leave every other module the entry imports — a sibling
 * chunk, anything under the package's own `node_modules/` — unhashed, so a runtime that trusted
 * those two alone would execute bytes nobody checked (extension-runtime design § 3.2).
 *
 * The digest is SHA-256 over one line per file, sorted by relative path (JavaScript string order, which is
 * deterministic across platforms):
 * `<relative path with "/" separators>\0<sha256 hex of the file's bytes>\n`. Using "/" on every OS
 * makes the same package produce the same digest on Windows, macOS and Linux. Directories carry no
 * line of their own, so an empty directory does not change the digest; a file's name, location and
 * bytes all do.
 *
 * A symlink anywhere in the tree THROWS rather than being followed or skipped: a link can point
 * outside the hashed tree, so a digest over it would vouch for bytes it never read. Install already
 * refuses symlinks in the source (`install-from-local.ts`), so a link here means the directory was
 * changed after install. Any other non-regular entry (a FIFO, a socket, a device) throws for the
 * same reason.
 *
 * A file is classified and read through ONE descriptor, never by path twice: an `lstat` of the path
 * followed by a read of the path is a check-then-use race, in which the entry could be swapped for
 * a symlink between the two. Entries are first classified by the directory listing's own type (no path
 * syscall), then each non-directory is opened once with `O_NOFOLLOW` — a symlink swapped in after
 * the listing fails the open instead of being followed — and `O_NONBLOCK`, so opening a FIFO
 * returns at once rather than waiting for a writer; the type check and the read both use that
 * descriptor. Windows defines neither flag (both default to 0 there); its symlinks are still caught
 * by the listing's type.
 */
export function computeExtensionTreeDigest(root: string): string {
  const lines: string[] = [];
  const stack: string[] = [root];
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    const entries: Dirent[] = readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        throw new Error(`extension tree contains a symlink: ${full}`);
      }
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      const rel = relative(root, full).split(sep).join("/");
      lines.push(`${rel}\0${sha256OfRegularFile(full)}\n`);
    }
  }
  // Every line starts with a distinct relative path, so no two lines are ever equal and the
  // comparator needs no "equal" arm.
  lines.sort((a, b) => (a < b ? -1 : 1));
  const hash = createHash("sha256");
  for (const line of lines) hash.update(line);
  return hash.digest("hex");
}

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** SHA-256 hex of a regular file, classified and read through the one descriptor that opened it. */
function sha256OfRegularFile(path: string): string {
  const fd = openSync(path, OPEN_FLAGS);
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`extension tree contains a non-regular file: ${path}`);
    }
    return createHash("sha256").update(readFileSync(fd)).digest("hex");
  } finally {
    closeSync(fd);
  }
}
