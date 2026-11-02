/**
 * Writes bytes to a path. Without `overwrite` it is an exclusive create (`wx`): an existing file is
 * refused without a check-then-write gap, and only a failure AFTER this call created the file
 * removes it. With `overwrite` the existing file is never truncated in place: the bytes go to a
 * sibling temp file (created `wx`, named so it can never look like the target's kind) which is then
 * renamed over the target, so a failed write leaves the old file byte-identical and only the temp
 * file is removed.
 */
import { randomBytes } from "node:crypto";
import { closeSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** A refusal or failure with a message that is safe to print once control characters are stripped. */
export class WriteFileError extends Error {}

export interface WriteFileExclusiveOptions {
  /** Replace an existing file instead of refusing it. */
  overwrite?: boolean;
  /** Writes the bytes to an open descriptor; a parameter so a test can fail it part-way. */
  writeFd?: (fd: number, data: Uint8Array) => void;
}

function writeCreating(
  path: string,
  bytes: Uint8Array,
  writeFd: (fd: number, data: Uint8Array) => void,
): void {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new WriteFileError(`${path} exists; refusing to overwrite it`);
    throw new WriteFileError(`could not create ${path}: ${code ?? "an error"}`);
  }
  try {
    writeFd(fd, bytes);
  } catch (e) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw new WriteFileError(
      `could not write ${path}: ${(e as NodeJS.ErrnoException).code ?? "an error"}`,
    );
  }
  closeSync(fd);
}

export function writeFileExclusive(
  path: string,
  bytes: Uint8Array,
  opts: WriteFileExclusiveOptions = {},
): void {
  const writeFd = opts.writeFd ?? writeFileSync;
  if (opts.overwrite !== true) {
    writeCreating(path, bytes, writeFd);
    return;
  }
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  writeCreating(temp, bytes, writeFd);
  try {
    renameSync(temp, path);
  } catch (e) {
    rmSync(temp, { force: true });
    throw new WriteFileError(
      `could not replace ${path}: ${(e as NodeJS.ErrnoException).code ?? "an error"}`,
    );
  }
}
