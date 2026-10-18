/** Deterministic `.tgz` packer for registry extension packages. */
import { create } from "tar";
import { listPackageFiles } from "./package-set.ts";

/**
 * Pack the package file set of `srcDir` into `outFile`. Files only, sorted by UTF-16 code unit with
 * `/` separators. Normalised so the same tree yields the same bytes on every platform: mtime fixed at
 * epoch 0 and uid/gid/uname/gname dropped (`portable`), every file mode forced to 0o644 (via the
 * `onWriteEntry` hook, which runs before the header is built, so umask and Windows-vs-POSIX modes
 * cannot leak; the executable bit is not preserved), and the gzip level pinned.
 */
export async function packExtensionDir(srcDir: string, outFile: string): Promise<void> {
  const files = listPackageFiles(srcDir);
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
