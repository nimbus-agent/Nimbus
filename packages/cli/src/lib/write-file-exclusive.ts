/**
 * Writes bytes to a path, atomically in both modes: the bytes go to a sibling temp file (created
 * `wx`, named so it can never look like the target's kind) and only a complete file is published.
 * Without `overwrite` it is published with `linkSync(temp, path)`, which fails with EEXIST when the
 * target exists, so an existing file is refused without a check-then-write gap and a crash never
 * leaves a partial target. With `overwrite` it is `renameSync(temp, path)`, so a failed write
 * leaves the old file byte-identical. Any failure removes only the temp file; a temp file a killed
 * run left behind is found again by `sweepStaleTempFiles`.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** A refusal or failure with a message that is safe to print once control characters are stripped. */
export class WriteFileError extends Error {}

export interface WriteFileExclusiveOptions {
  /** Replace an existing file instead of refusing it. */
  overwrite?: boolean;
  /** Writes the bytes to an open descriptor; a parameter so a test can fail it part-way. */
  writeFd?: (fd: number, data: Uint8Array) => void;
  /** Hard-links the finished temp file to the target; a parameter so a test can observe it. */
  link?: (existing: string, target: string) => void;
}

const TEMP_HEX_BYTES = 6;

/** The temp name for `path`: `.<name>.<12 hex>.tmp`, in the same directory. */
function tempPathFor(path: string): string {
  return join(
    dirname(path),
    `.${basename(path)}.${randomBytes(TEMP_HEX_BYTES).toString("hex")}.tmp`,
  );
}

const errorCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;
/** The error's code for a message, or "an error" when it has none. */
const codeText = (e: unknown): string => errorCode(e) ?? "an error";

/** Writes the temp file; failures are reported against `shown`, the path the caller asked for. */
function writeTemp(
  temp: string,
  shown: string,
  bytes: Uint8Array,
  writeFd: (fd: number, data: Uint8Array) => void,
): void {
  let fd: number;
  try {
    fd = openSync(temp, "wx");
  } catch (e) {
    throw new WriteFileError(`could not create ${shown}: ${codeText(e)}`);
  }
  try {
    writeFd(fd, bytes);
  } catch (e) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw new WriteFileError(`could not write ${shown}: ${codeText(e)}`);
  }
  closeSync(fd);
}

/** Link errors that mean the filesystem has no hard links (FAT, some network shares). */
const NO_HARD_LINKS: ReadonlySet<string> = new Set(["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);

function publishExclusive(
  temp: string,
  path: string,
  bytes: Uint8Array,
  opts: WriteFileExclusiveOptions,
): void {
  try {
    (opts.link ?? linkSync)(temp, path);
  } catch (e) {
    const code = errorCode(e);
    if (code === "EEXIST") throw new WriteFileError(`${path} exists; refusing to overwrite it`);
    if (code !== undefined && NO_HARD_LINKS.has(code)) {
      createDirectly(path, bytes, opts.writeFd ?? writeFileSync);
      return;
    }
    throw new WriteFileError(`could not create ${path}: ${codeText(e)}`);
  }
}

/** The fallback where hard links do not exist: an exclusive create, removed again if the write fails. */
function createDirectly(
  path: string,
  bytes: Uint8Array,
  writeFd: (fd: number, data: Uint8Array) => void,
): void {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (e) {
    if (errorCode(e) === "EEXIST")
      throw new WriteFileError(`${path} exists; refusing to overwrite it`);
    throw new WriteFileError(`could not create ${path}: ${codeText(e)}`);
  }
  try {
    writeFd(fd, bytes);
  } catch (e) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw new WriteFileError(`could not write ${path}: ${codeText(e)}`);
  }
  closeSync(fd);
}

export function writeFileExclusive(
  path: string,
  bytes: Uint8Array,
  opts: WriteFileExclusiveOptions = {},
): void {
  const writeFd = opts.writeFd ?? writeFileSync;
  const temp = tempPathFor(path);
  writeTemp(temp, path, bytes, writeFd);
  try {
    if (opts.overwrite === true) {
      try {
        renameSync(temp, path);
      } catch (e) {
        throw new WriteFileError(`could not replace ${path}: ${codeText(e)}`);
      }
      return;
    }
    publishExclusive(temp, path, bytes, opts);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * Removes temp files a killed earlier write of `path` left in its directory: names matching
 * exactly the pattern `writeFileExclusive` gives this target, and only regular files. Never throws.
 */
export function sweepStaleTempFiles(path: string): void {
  const escaped = basename(path).replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const pattern = new RegExp(String.raw`^\.${escaped}\.[0-9a-f]{${TEMP_HEX_BYTES * 2}}\.tmp$`);
  const dir = dirname(path);
  try {
    for (const name of readdirSync(dir)) {
      if (!pattern.test(name)) continue;
      const file = join(dir, name);
      if (lstatSync(file).isFile()) rmSync(file, { force: true });
    }
  } catch {
    // best effort: a directory that cannot be read has nothing this run could pack by mistake
  }
}
