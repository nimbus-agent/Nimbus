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
 * Pack `srcDir` into `outFile`. Files only, sorted by UTF-16 code unit with `/` separators,
 * zeroed mtimes and owners (`portable`), and the gzip level pinned so the same tree yields the
 * same bytes on every platform.
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
    },
    files,
  );
}
