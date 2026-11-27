// Phase 7 (the Cost Pack, slice 3): a cost report's `template_file`, read ONLY from
// `<configDir>/cost-templates/` (spec, Fixes 3).
//
// Static rule D48 keeps this module free of network, connector and model imports; the confinement below is
// this module's own contract, pinned by its tests.
//
// The checks, in order: the name is a plain file name (no path, no `..`, not hidden); the folder and the file
// are not links (`lstat`), and the folder's identity (device + inode) is pinned and re-checked just before the
// open and after the read, so a swap of the folder for a link or another folder in between is refused; the file's REAL path lies inside the folder's real path (never a string compare of a
// real path with the joined path: macOS `/var` is `/private/var`); the file is opened once (with `O_NOFOLLOW`
// where the platform has it), checked on that handle to be a regular file of at most 64 KiB, and read through
// that same handle; after the read the path must still be the same file (same device and inode) and still not
// a link, so a swap between the checks and the read is refused. The bytes must be valid UTF-8.
//
// Stated bound: Node has no directory-handle open (`openat`), so a swap of the folder made AND reversed exactly
// between the pre-open check and the open cannot be seen from user space. Doing that needs write access to the
// config directory, which already lets the writer change `nimbus.toml` and the templates themselves.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

import { isCostTemplateFileName, TEMPLATE_CONTROL_RE } from "../config/cost-report-toml.ts";
import { isSameOrInside } from "../util/path-overlap.ts";

export const COST_TEMPLATE_DIR = "cost-templates";
export const COST_TEMPLATE_MAX_BYTES = 64 * 1024;

export class CostTemplateFileError extends Error {
  override readonly name = "CostTemplateFileError";
}

const refuse = (why: string): never => {
  throw new CostTemplateFileError(why);
};

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Step 1: the folder exists, is a real folder and is not a link. */
function checkFolder(dir: string): Stats {
  const st = lstatOrNull(dir);
  if (st === null) return refuse(`no ${COST_TEMPLATE_DIR} folder in the config directory`);
  if (st.isSymbolicLink()) refuse(`the ${COST_TEMPLATE_DIR} folder is a link`);
  if (!st.isDirectory()) refuse(`${COST_TEMPLATE_DIR} is not a folder`);
  return st;
}

/** The folder is still the one first checked: same device and inode, still not a link. */
function checkFolderSame(dir: string, first: Stats): void {
  const now = lstatOrNull(dir);
  if (now === null || now.isSymbolicLink() || now.dev !== first.dev || now.ino !== first.ino) {
    refuse(`the ${COST_TEMPLATE_DIR} folder changed while the template was read`);
  }
}

/** An ordinary filesystem failure, reported as a refusal of this file (never an internal error). */
function fsFailure(e: unknown, file: string): never {
  if (e instanceof CostTemplateFileError) throw e;
  const code = (e as NodeJS.ErrnoException).code ?? String(e);
  return refuse(`could not read the template file ${file}: ${code}`);
}

/** Step 2: the file exists, is not a link, is a regular file and resolves inside the folder. */
function checkFile(dir: string, path: string, file: string, platform: NodeJS.Platform): Stats {
  const st = lstatOrNull(path);
  if (st === null) return refuse(`no template file ${file} in ${COST_TEMPLATE_DIR}/`);
  if (st.isSymbolicLink()) refuse(`the template file ${file} is a link`);
  if (!st.isFile()) refuse(`the template file ${file} is not a regular file`);
  let inside: boolean;
  try {
    inside = isSameOrInside(platform, realpathSync(path), realpathSync(dir));
  } catch (e) {
    return fsFailure(e, file);
  }
  if (!inside) {
    refuse(`the template file ${file} resolves outside ${COST_TEMPLATE_DIR}/`);
  }
  return st;
}

/** Step 3: one handle — a regular file within the cap, read whole through that handle. */
function readThroughHandle(path: string, file: string): { bytes: Buffer; st: Stats } {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return refuse(
      code === "ELOOP"
        ? `the template file ${file} is a link`
        : `could not open ${file}: ${String(code)}`,
    );
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) refuse(`the template file ${file} is not a regular file`);
    if (st.size > COST_TEMPLATE_MAX_BYTES)
      refuse(`the template file ${file} is larger than 64 KiB`);
    const bytes = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      let n: number;
      try {
        n = readSync(fd, bytes, off, st.size - off, off);
      } catch (e) {
        return fsFailure(e, file);
      }
      if (n === 0) break;
      off += n;
    }
    return { bytes: bytes.subarray(0, off), st };
  } finally {
    closeSync(fd);
  }
}

/** Step 4: the path still names the file that was read, and it is still not a link. */
function checkUnchanged(path: string, file: string, read: Stats): void {
  const after = lstatOrNull(path);
  if (
    after === null ||
    after.isSymbolicLink() ||
    after.dev !== read.dev ||
    after.ino !== read.ino
  ) {
    refuse(`the template file ${file} changed while it was read`);
  }
}

/** The template text of `file` in `<configDir>/cost-templates/`. Throws {@link CostTemplateFileError}. */
export function readCostTemplateFile(
  configDir: string,
  file: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!isCostTemplateFileName(file)) {
    refuse(`template_file ${JSON.stringify(file.slice(0, 64))} is not a plain file name`);
  }
  const dir = join(configDir, COST_TEMPLATE_DIR);
  const folder = checkFolder(dir);
  const path = join(dir, file);
  checkFile(dir, path, file, platform);
  checkFolderSame(dir, folder);
  const { bytes, st } = readThroughHandle(path, file);
  checkUnchanged(path, file, st);
  checkFolderSame(dir, folder);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return refuse(`the template file ${file} is not valid UTF-8`);
  }
  // The same rule as an inline template (which a scheduled workflow embeds): Windows line endings become
  // line feeds; any other control character is refused.
  const normalized = text.replaceAll("\r\n", "\n");
  if (TEMPLATE_CONTROL_RE.test(normalized)) {
    return refuse(`the template file ${file} holds a control character`);
  }
  return normalized;
}
