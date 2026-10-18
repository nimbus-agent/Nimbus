/** Deterministic `.tgz` packer for registry extension packages. */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { create } from "tar";

function collect(root: string, rel: string, out: string[]): void {
  for (const name of readdirSync(join(root, rel))) {
    const relPath = rel === "" ? name : `${rel}/${name}`;
    const st = lstatSync(join(root, relPath));
    if (st.isSymbolicLink()) throw new Error(`refusing to pack a symlink: ${relPath}`);
    if (st.isDirectory()) collect(root, relPath, out);
    else if (st.isFile()) out.push(relPath);
    else throw new Error(`refusing to pack a special file: ${relPath}`);
  }
}

/**
 * Pack `srcDir` into `outFile`. Files only, sorted by UTF-16 code unit with `/` separators.
 * Normalised so the same tree yields the same bytes on every platform: mtime fixed at epoch 0 and
 * uid/gid/uname/gname dropped (`portable`), every file mode forced to 0o644 (via the `onWriteEntry`
 * hook, which runs before the header is built, so umask and Windows-vs-POSIX modes cannot leak;
 * the executable bit is not preserved), and the gzip level pinned.
 */
export async function packExtensionDir(srcDir: string, outFile: string): Promise<void> {
  const files: string[] = [];
  collect(srcDir, "", files);
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  await create(
    {
      gzip: { level: 9 },
      file: outFile,
      cwd: srcDir,
      portable: true,
      mtime: new Date(0),
      noDirRecurse: true,
      onWriteEntry: (entry) => {
        if (entry.stat) entry.stat.mode = (entry.stat.mode & ~0o7777) | 0o644;
      },
    },
    files,
  );
}
