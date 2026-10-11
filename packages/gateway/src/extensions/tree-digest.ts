import { createHash } from "node:crypto";
import { type Dirent, lstatSync, readdirSync, readFileSync } from "node:fs";
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
 */
export function computeExtensionTreeDigest(root: string): string {
  const lines: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    const entries: Dirent[] = readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = join(dir, ent.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        throw new Error(`extension tree contains a symlink: ${full}`);
      }
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!st.isFile()) {
        throw new Error(`extension tree contains a non-regular file: ${full}`);
      }
      const rel = relative(root, full).split(sep).join("/");
      const fileHex = createHash("sha256").update(readFileSync(full)).digest("hex");
      lines.push(`${rel}\0${fileHex}\n`);
    }
  }
  lines.sort(byteOrder);
  const hash = createHash("sha256");
  for (const line of lines) hash.update(line);
  return hash.digest("hex");
}

function byteOrder(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
