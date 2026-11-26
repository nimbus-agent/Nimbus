// Phase 7 (the Cost Pack, slice 3): a cost report's `template_file`, read ONLY from
// `<configDir>/cost-templates/` (spec, Fixes 3).
//
// Confined by static rule D48 (no network, no connector, no model).
//
// The checks, in order: the name is a plain file name (no path, no `..`, not hidden); the folder and the file
// are not links (`lstat`); the file's REAL path lies inside the folder's real path (never a string compare of a
// real path with the joined path: macOS `/var` is `/private/var`); the file is opened once (with `O_NOFOLLOW`
// where the platform has it), checked on that handle to be a regular file of at most 64 KiB, and read through
// that same handle; after the read the path must still be the same file (same device and inode) and still not
// a link, so a swap between the checks and the read is refused. The bytes must be valid UTF-8.
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

import { isCostTemplateFileName } from "../config/cost-report-toml.ts";
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
function checkFolder(dir: string): void {
  const st = lstatOrNull(dir);
  if (st === null) refuse(`no ${COST_TEMPLATE_DIR} folder in the config directory`);
  if (st?.isSymbolicLink() === true) refuse(`the ${COST_TEMPLATE_DIR} folder is a link`);
  if (st?.isDirectory() !== true) refuse(`${COST_TEMPLATE_DIR} is not a folder`);
}

/** Step 2: the file exists, is not a link, is a regular file and resolves inside the folder. */
function checkFile(dir: string, path: string, file: string, platform: NodeJS.Platform): Stats {
  const st = lstatOrNull(path);
  if (st === null) return refuse(`no template file ${file} in ${COST_TEMPLATE_DIR}/`);
  if (st.isSymbolicLink()) refuse(`the template file ${file} is a link`);
  if (!st.isFile()) refuse(`the template file ${file} is not a regular file`);
  if (!isSameOrInside(platform, realpathSync(path), realpathSync(dir))) {
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
      const n = readSync(fd, bytes, off, st.size - off, off);
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
  checkFolder(dir);
  const path = join(dir, file);
  checkFile(dir, path, file, platform);
  const { bytes, st } = readThroughHandle(path, file);
  checkUnchanged(path, file, st);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return refuse(`the template file ${file} is not valid UTF-8`);
  }
}
