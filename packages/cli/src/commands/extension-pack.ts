/**
 * `nimbus extension pack <dir> --out <file>`: pack an extension directory into the `.tgz` a registry
 * publishes. No gateway, no network, no key.
 *
 * It exists so one job can pack and every later job can use that one file. Node and Bun gzip the same
 * tree differently, so a directory packed on each side never hashes alike: the registry action's
 * `score-package` mode (Node) and `nimbus registry maintain add` (Bun) must be given the same file.
 *
 * The pack runs in a private directory and the bytes are written once, with exclusive create, so an
 * existing `--out` is refused without a check-then-write gap and is never touched.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGE_MANIFEST_FILE, packExtensionDir } from "@nimbus-dev/registry-format";
import { MaintainError, parseArgs } from "../lib/maintain-shared.ts";
import { stripControlChars } from "../lib/strip-control-chars.ts";

const USAGE = "usage: nimbus extension pack <dir> --out <file>\n";

export interface PackCmdDeps {
  log: (s: string) => void;
  err: (s: string) => void;
  /** Writes the bytes to an open descriptor; a parameter so a test can fail it part-way. */
  writeFd?: (fd: number, data: Uint8Array) => void;
}

const DEFAULT_DEPS: PackCmdDeps = {
  log: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

/** Refuses anything but a directory that holds a manifest file. */
function assertPackageDir(dir: string): void {
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    throw new MaintainError(`${dir} does not exist`);
  }
  if (!isDir) throw new MaintainError(`${dir} is not a directory`);
  let hasManifest = false;
  try {
    hasManifest = lstatSync(join(dir, PACKAGE_MANIFEST_FILE)).isFile();
  } catch {
    hasManifest = false;
  }
  if (!hasManifest) throw new MaintainError(`${dir} has no ${PACKAGE_MANIFEST_FILE}`);
}

/**
 * Writes `bytes` to a path that must not exist yet. The exclusive open is the only step that can
 * find something already there, and it creates nothing when it fails (an existing file, but also
 * `EMFILE` or `EACCES`), so a failed open touches nothing. Only a failure AFTER this call created
 * the file removes it.
 */
function writeNew(
  out: string,
  bytes: Uint8Array,
  writeFd: NonNullable<PackCmdDeps["writeFd"]>,
): void {
  let fd: number;
  try {
    fd = openSync(out, "wx");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new MaintainError(`${out} exists; refusing to overwrite it`);
    throw new MaintainError(`could not create ${out}: ${code ?? "an error"}`);
  }
  try {
    writeFd(fd, bytes);
  } catch (e) {
    closeSync(fd);
    rmSync(out, { force: true });
    throw new MaintainError(
      `could not write ${out}: ${(e as NodeJS.ErrnoException).code ?? "an error"}`,
    );
  }
  closeSync(fd);
}

/** Packs `dir` in a private directory and returns the bytes. */
async function packToBytes(dir: string): Promise<Uint8Array> {
  const work = mkdtempSync(join(tmpdir(), "nimbus-extension-pack-"));
  try {
    const tgz = join(work, "package.tgz");
    await packExtensionDir(dir, tgz);
    return readFileSync(tgz);
  } catch (e) {
    throw new MaintainError(e instanceof Error ? e.message : String(e));
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

/** Exit 0, or 2 with a message on any refusal. */
export async function runExtensionPack(
  args: string[],
  deps: PackCmdDeps = DEFAULT_DEPS,
): Promise<number> {
  try {
    const p = parseArgs(args, ["--out"], []);
    const [dir] = p.positional;
    const out = p.options.get("--out");
    if (dir === undefined || p.positional.length !== 1 || out === undefined) {
      deps.err(USAGE);
      return 2;
    }
    assertPackageDir(dir);
    const bytes = await packToBytes(dir);
    writeNew(out, bytes, deps.writeFd ?? writeFileSync);
    deps.log(`wrote ${stripControlChars(out)}\n`);
    deps.log(`sha256 ${createHash("sha256").update(bytes).digest("hex")}\n`);
    return 0;
  } catch (e) {
    if (e instanceof MaintainError) {
      deps.err(`${stripControlChars(e.message)}\n`);
      return 2;
    }
    throw e;
  }
}
