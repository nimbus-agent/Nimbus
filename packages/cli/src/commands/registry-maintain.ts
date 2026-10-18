/**
 * `nimbus registry maintain init|add|remove` — offline builder for a signed static extension
 * registry folder (spec § 9). Pure CLI: no gateway, no network, no Vault. The root key is a file
 * holding base64 of the 32-byte Ed25519 seed (the format `nimbus extension keygen` writes).
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertSafeExtensionId,
  emptyIndex,
  inspectPackage,
  isValidSemver,
  MAX_PACKAGE_BYTES,
  PUBLISHER_ID_RE,
  PUBLISHER_KEY_RE,
  packExtensionDir,
  publicKeyFromSeed,
  publisherKeyFingerprint,
  type RegistryChannel,
  RegistryError,
  type RegistryIndex,
  signIndex,
  verifyIndexSignature,
} from "@nimbus-dev/registry-format";
import {
  decodeBase64,
  encodeBase64,
  generateEd25519Keypair,
  verifyManifestSignature,
} from "../lib/extension-signing.ts";
import { readIndexFile, writeIndexAtomic } from "../lib/registry-index.ts";

export interface MaintainIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const DEFAULT_IO: MaintainIo = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

const USAGE =
  "Usage: nimbus registry maintain init <dir> [--key <path>] [--force] | add <dir> <package.tgz|extension-dir> [--channel stable|beta] [--key <path>] | remove <dir> <id>[@<version>] [--key <path>]\n";

class MaintainError extends Error {}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSafeId(id: string): string[] {
  try {
    assertSafeExtensionId(id);
  } catch {
    throw new MaintainError(`invalid extension id: ${JSON.stringify(id)}`);
  }
  // The id becomes a directory path in the registry folder, so every segment must be a plain name.
  const parts = id.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\\"))) {
    throw new MaintainError(`invalid extension id: ${JSON.stringify(id)}`);
  }
  return parts;
}

interface ParsedArgs {
  positional: string[];
  options: Map<string, string>;
  flags: Set<string>;
}

function parseArgs(
  args: string[],
  valued: readonly string[],
  boolean: readonly string[],
): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (valued.includes(a)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) throw new MaintainError(`${a} needs a value`);
      options.set(a, v);
      i++;
    } else if (boolean.includes(a)) {
      flags.add(a);
    } else if (a.startsWith("--")) {
      throw new MaintainError(`unknown option ${a}`);
    } else {
      positional.push(a);
    }
  }
  return { positional, options, flags };
}

function keyPathOf(p: ParsedArgs): string {
  return p.options.get("--key") ?? join(homedir(), ".nimbus", "registry-key");
}

function loadSeed(keyPath: string): Uint8Array {
  let seed: Uint8Array;
  try {
    seed = decodeBase64(readFileSync(keyPath, "utf8").trim());
  } catch (e) {
    throw new MaintainError(
      `could not read key file ${keyPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (seed.length !== 32) throw new MaintainError(`key file ${keyPath} did not decode to 32 bytes`);
  return seed;
}

/** Read the folder's index and require it to be signed by THIS key before anything is changed. */
function loadOwnedIndex(dir: string, seed: Uint8Array): RegistryIndex {
  const path = join(dir, "index.json");
  if (!existsSync(path)) throw new MaintainError(`${path} not found; run \`maintain init\` first`);
  const index = readIndexFile(path);
  if (index.rootKey !== encodeBase64(publicKeyFromSeed(seed))) {
    throw new MaintainError("this registry is signed by a different key than --key");
  }
  if (!verifyIndexSignature(index)) {
    throw new MaintainError("the existing index.json does not verify");
  }
  return index;
}

async function resign(
  dir: string,
  seed: Uint8Array,
  prev: RegistryIndex,
  extensions: RegistryIndex["extensions"],
): Promise<RegistryIndex> {
  const next = await signIndex(
    {
      format: 1,
      rootKey: prev.rootKey,
      sequence: prev.sequence + 1,
      generatedAt: new Date().toISOString(),
      extensions,
    },
    seed,
  );
  writeIndexAtomic(dir, next);
  return next;
}

async function maintainInit(args: string[], io: MaintainIo): Promise<void> {
  const p = parseArgs(args, ["--key"], ["--force"]);
  const dir = p.positional[0];
  if (dir === undefined || p.positional.length !== 1) throw new MaintainError("init needs <dir>");
  const force = p.flags.has("--force");
  const keyPath = keyPathOf(p);
  if (existsSync(join(dir, "index.json")) && !force) {
    throw new MaintainError(
      `${join(dir, "index.json")} exists; refusing to overwrite without --force`,
    );
  }
  const { privkey, pubkey } = generateEd25519Keypair();
  mkdirSync(dirname(keyPath), { recursive: true });
  try {
    writeFileSync(keyPath, `${encodeBase64(privkey)}\n`, { flag: force ? "w" : "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new MaintainError(`refusing to overwrite ${keyPath} without --force`);
    }
    throw e;
  }
  if (process.platform !== "win32") chmodSync(keyPath, 0o600);
  mkdirSync(join(dir, "extensions"), { recursive: true });
  const index = await signIndex(emptyIndex(encodeBase64(pubkey)), privkey);
  writeIndexAtomic(dir, index);
  io.stdout(`registry initialised in ${dir} (sequence 1)\n`);
  io.stdout(`root key:    ${index.rootKey}\n`);
  io.stdout(`fingerprint: ${publisherKeyFingerprint(encodeBase64(pubkey))}\n`);
  io.stdout(`key file:    ${keyPath} (keep it secret and backed up)\n`);
}

interface ValidManifest {
  id: string;
  idParts: string[];
  version: string;
  name: string;
  publisher: { id: string; key: string };
}

async function validateManifest(m: Record<string, unknown>): Promise<ValidManifest> {
  const id = m["id"];
  const version = m["version"];
  if (typeof id !== "string") throw new MaintainError("manifest has no id");
  const idParts = assertSafeId(id);
  if (typeof version !== "string" || !isValidSemver(version)) {
    throw new MaintainError(`manifest version ${JSON.stringify(version)} is not strict semver`);
  }
  const pub = m["publisher"] as { id?: unknown; key?: unknown } | undefined;
  if (
    pub === undefined ||
    pub === null ||
    typeof pub.id !== "string" ||
    typeof pub.key !== "string" ||
    typeof m["signature"] !== "string"
  ) {
    throw new MaintainError(
      "extension is unsigned: the manifest needs `publisher` and `signature` (run `nimbus extension sign`)",
    );
  }
  if (pub.id.length > 64 || !PUBLISHER_ID_RE.test(pub.id) || !PUBLISHER_KEY_RE.test(pub.key)) {
    throw new MaintainError("manifest publisher id or key is malformed");
  }
  try {
    await verifyManifestSignature(m, decodeBase64(pub.key));
  } catch (e) {
    throw new MaintainError(
      `manifest signature does not verify: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const declaredName = m["name"];
  const name = typeof declaredName === "string" && declaredName !== "" ? declaredName : id;
  return { id, idParts, version, name, publisher: { id: pub.id, key: pub.key } };
}

/**
 * Opens `source` ONCE and does the type check and the read through that descriptor, so nothing can be
 * swapped between a check and a use of the path. Returns the file's bytes, or `undefined` for a
 * directory (which the packer walks). A symlink is refused where the OS can refuse it at open
 * (`O_NOFOLLOW`, POSIX); Windows has no such flag, and there the source is the maintainer's own local
 * path, so a link is followed.
 */
function readSourceFile(source: string): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new MaintainError(`${source} is a symlink; refusing`);
    if (code === "ENOENT") throw new MaintainError(`${source} does not exist`);
    if ((code === "EISDIR" || code === "EPERM" || code === "EACCES") && isDirectory(source)) {
      return undefined; // Windows cannot open a directory as a file
    }
    throw new MaintainError(`${source} cannot be read`);
  }
  try {
    if (fstatSync(fd).isDirectory()) return undefined;
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function maintainAdd(args: string[], io: MaintainIo): Promise<void> {
  const p = parseArgs(args, ["--key", "--channel"], []);
  const [dir, source] = p.positional;
  if (dir === undefined || source === undefined || p.positional.length !== 2) {
    throw new MaintainError("add needs <dir> <package.tgz|extension-dir>");
  }
  const channel = p.options.get("--channel") ?? "stable";
  if (channel !== "stable" && channel !== "beta") {
    throw new MaintainError("--channel must be stable or beta");
  }
  const seed = loadSeed(keyPathOf(p));
  const index = loadOwnedIndex(dir, seed);
  const fileBytes = readSourceFile(source);

  const work = mkdtempSync(join(tmpdir(), "nimbus-registry-add-"));
  try {
    // The package is read ONCE. A file source is copied into the private work dir from that single
    // read; from then on inspection, hashing and the registry copy all use that private copy, never
    // `source` again, so what was validated is exactly what is published.
    const tgz = join(work, "package.tgz");
    if (fileBytes === undefined) {
      await packExtensionDir(source, tgz);
    } else {
      writeFileSync(tgz, fileBytes, { flag: "wx" });
    }
    const tgzBytes = readFileSync(tgz);
    if (tgzBytes.length === 0 || tgzBytes.length > MAX_PACKAGE_BYTES) {
      throw new MaintainError("package size is out of range");
    }
    const pkg = await inspectPackage(tgz, work);
    const v = await validateManifest(pkg.manifest);

    const existing = index.extensions[v.id];
    if (existing !== undefined && existing.publisher.key !== v.publisher.key) {
      throw new MaintainError(
        `${v.id} is already published under a different publisher key; key rotation is not supported`,
      );
    }
    if (existing?.versions[v.version] !== undefined) {
      throw new MaintainError(`${v.id}@${v.version} already exists in this registry`);
    }

    const rel = `extensions/${v.id}/${v.version}`;
    const destDir = join(dir, "extensions", ...v.idParts, v.version);
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "manifest.json"), pkg.manifestBytes);
    writeFileSync(join(destDir, "package.tgz"), tgzBytes);

    const entry = {
      channel: channel as RegistryChannel,
      name: v.name,
      manifest: `${rel}/manifest.json`,
      manifestSha256: sha256Hex(pkg.manifestBytes),
      package: `${rel}/package.tgz`,
      packageSha256: sha256Hex(tgzBytes),
      packageSizeBytes: tgzBytes.length,
      entryHash: pkg.entryHash,
      publishedAt: new Date().toISOString(),
    };
    const next = await resign(dir, seed, index, {
      ...index.extensions,
      [v.id]: {
        publisher: existing?.publisher ?? v.publisher,
        versions: { ...existing?.versions, [v.version]: entry },
      },
    });
    io.stdout(`added ${v.id}@${v.version} (${channel}); sequence ${String(next.sequence)}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

function splitIdVersion(ref: string): { id: string; version: string | undefined } {
  const at = ref.lastIndexOf("@");
  if (at > 0 && isValidSemver(ref.slice(at + 1))) {
    return { id: ref.slice(0, at), version: ref.slice(at + 1) };
  }
  return { id: ref, version: undefined };
}

async function maintainRemove(args: string[], io: MaintainIo): Promise<void> {
  const p = parseArgs(args, ["--key"], []);
  const [dir, ref] = p.positional;
  if (dir === undefined || ref === undefined || p.positional.length !== 2) {
    throw new MaintainError("remove needs <dir> <id>[@<version>]");
  }
  const seed = loadSeed(keyPathOf(p));
  const index = loadOwnedIndex(dir, seed);
  const { id, version } = splitIdVersion(ref);
  const existing = index.extensions[id];
  if (existing === undefined) throw new MaintainError(`${id} is not in this registry`);
  const { [id]: _dropped, ...others } = index.extensions;
  let extensions: RegistryIndex["extensions"] = others;
  if (version !== undefined) {
    if (existing.versions[version] === undefined) {
      throw new MaintainError(`${id}@${version} is not in this registry`);
    }
    const { [version]: _gone, ...left } = existing.versions;
    if (Object.keys(left).length > 0) {
      extensions = { ...others, [id]: { publisher: existing.publisher, versions: left } };
    }
  }
  const next = await resign(dir, seed, index, extensions);
  const what = version === undefined ? id : `${id}@${version}`;
  io.stdout(`removed ${what}; sequence ${String(next.sequence)}\n`);
}

export async function runRegistryMaintain(
  args: string[],
  io: MaintainIo = DEFAULT_IO,
): Promise<number> {
  const [sub, ...rest] = args;
  const handlers: Record<string, (a: string[], io: MaintainIo) => Promise<void>> = {
    init: maintainInit,
    add: maintainAdd,
    remove: maintainRemove,
  };
  const handler = sub === undefined ? undefined : handlers[sub];
  if (handler === undefined) {
    io.stderr(USAGE);
    return 2;
  }
  try {
    await handler(rest, io);
    return 0;
  } catch (e) {
    if (e instanceof MaintainError || e instanceof RegistryError) {
      io.stderr(`${e.message}\n`);
      return 2;
    }
    io.stderr(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
