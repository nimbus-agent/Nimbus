/**
 * Writes bytes to a path with an exclusive create (`wx`), so an existing file is refused without a
 * check-then-write gap, or, with `overwrite`, replaces it (`w`).
 *
 * The open is the only step that can find something already there, and a failed `wx` open creates
 * nothing (an existing file, but also `EMFILE` or `EACCES`). Only a failure AFTER this call opened
 * the file removes it.
 */
import { closeSync, openSync, rmSync, writeFileSync } from "node:fs";

/** A refusal or failure with a message that is safe to print once control characters are stripped. */
export class WriteFileError extends Error {}

export interface WriteFileExclusiveOptions {
  /** Replace an existing file instead of refusing it. */
  overwrite?: boolean;
  /** Writes the bytes to an open descriptor; a parameter so a test can fail it part-way. */
  writeFd?: (fd: number, data: Uint8Array) => void;
}

export function writeFileExclusive(
  path: string,
  bytes: Uint8Array,
  opts: WriteFileExclusiveOptions = {},
): void {
  let fd: number;
  try {
    fd = openSync(path, opts.overwrite === true ? "w" : "wx");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new WriteFileError(`${path} exists; refusing to overwrite it`);
    throw new WriteFileError(`could not create ${path}: ${code ?? "an error"}`);
  }
  try {
    (opts.writeFd ?? writeFileSync)(fd, bytes);
  } catch (e) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw new WriteFileError(
      `could not write ${path}: ${(e as NodeJS.ErrnoException).code ?? "an error"}`,
    );
  }
  closeSync(fd);
}
