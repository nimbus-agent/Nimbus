/**
 * Test fixtures for the registry action: a real registry repository in a fresh temp directory —
 * a bare `origin` with `main` (sources) and `gh-pages` (an index signed with a known root seed),
 * and a working clone of it standing in for the `actions/checkout` workspace — plus signed,
 * really-packed extensions to publish into it. Everything stays inside the directory it is given;
 * `origin` is reached through a `file://` URL, so nothing touches the network.
 *
 * The manifest signature is the flat Ed25519 signature over the canonical manifest without its
 * `signature` field: exactly the bytes `signIndex` signs for an index, so it is reused here rather
 * than importing the SDK, which this package cannot resolve.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  emptyIndex,
  packExtensionDir,
  publicKeyFromSeed,
  publisherKeyFingerprint,
  type RegistryIndex,
  signIndex,
} from "../../../../registry-format/src/index.ts";

export const ROOT_SEED = new Uint8Array(32).fill(3);
export const PUBLISHER_SEED = new Uint8Array(32).fill(7);
export const OTHER_SEED = new Uint8Array(32).fill(9);

export const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
export const ROOT_KEY_INPUT = b64(ROOT_SEED);
export const ROOT_PUBLIC_KEY = b64(publicKeyFromSeed(ROOT_SEED));

const IDENTITY = [
  "-c",
  "user.name=test",
  "-c",
  "user.email=test@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.autocrlf=false",
];

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...IDENTITY, ...args], {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");
}

export function write(root: string, rel: string, bytes: string | Uint8Array): void {
  const p = join(root, ...rel.split("/"));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, bytes);
}

export interface ExtensionOpts {
  id?: string;
  version?: string;
  publisherId?: string;
  seed?: Uint8Array;
  channel?: "stable" | "beta";
  name?: string;
  network?: string[];
  /** Replace the manifest's signature with garbage. */
  badSignature?: boolean;
}

/** The three files a publish adds for one extension version. */
export interface PublishFiles {
  id: string;
  version: string;
  manifest: Uint8Array;
  pkg: Uint8Array;
  request: Uint8Array;
}

/**
 * Packed extensions by their options. Signing and packing are deterministic, so one build per
 * distinct `o` serves every test in a file; the returned bytes are never mutated by callers.
 */
const EXTENSION_CACHE = new Map<string, Promise<PublishFiles>>();

/** A signed manifest, packed with the real packer, plus its publish request (cached by `o`). */
export function makeExtension(scratch: string, o: ExtensionOpts = {}): Promise<PublishFiles> {
  const key = JSON.stringify(o, (_k, v: unknown) =>
    v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v,
  );
  let hit = EXTENSION_CACHE.get(key);
  if (hit === undefined) {
    hit = buildExtension(scratch, o);
    EXTENSION_CACHE.set(key, hit);
  }
  return hit;
}

async function buildExtension(scratch: string, o: ExtensionOpts): Promise<PublishFiles> {
  const seed = o.seed ?? PUBLISHER_SEED;
  const key = b64(publicKeyFromSeed(seed));
  const id = o.id ?? "acme/echo";
  const version = o.version ?? "1.0.0";
  const unsigned = {
    id,
    version,
    name: o.name ?? "Echo",
    entry: "dist/index.js",
    permissions: { network: o.network ?? ["api.example.com"], filesystem: { read: [], write: [] } },
    publisher: { id: o.publisherId ?? "acme", key },
  };
  // See the module comment: the same canonical-bytes signature as the SDK's flat signManifest.
  const signed = (await signIndex(
    unsigned as unknown as Omit<RegistryIndex, "signature">,
    seed,
  )) as unknown as Record<string, unknown>;
  if (o.badSignature === true) signed["signature"] = `${"A".repeat(86)}==`;
  const manifest = new TextEncoder().encode(JSON.stringify(signed, null, 2));

  const dir = mkdtempSync(join(scratch, "ext-"));
  write(dir, "nimbus.extension.json", manifest);
  write(dir, "dist/index.js", "export default 1;\n");
  write(dir, "README.md", "echo\n");
  const tgz = join(dir, "..", `${dir.split(/[\\/]/).at(-1) ?? "ext"}.tgz`);
  await packExtensionDir(dir, tgz);
  const request = {
    id,
    version,
    channel: o.channel ?? "stable",
    publisherFingerprint: publisherKeyFingerprint(key),
  };
  return {
    id,
    version,
    manifest,
    pkg: new Uint8Array(readFileSync(tgz)),
    request: new TextEncoder().encode(`${JSON.stringify(request, null, 2)}\n`),
  };
}

export function writePublish(root: string, f: PublishFiles): void {
  const base = `extensions/${f.id}/${f.version}`;
  write(root, `${base}/manifest.json`, f.manifest);
  write(root, `${base}/package.tgz`, f.pkg);
  write(root, `${base}/publish-request.json`, f.request);
}

export interface RegistryRepo {
  /** The directory holding all three repositories. */
  root: string;
  /** The bare `origin`. */
  origin: string;
  originUrl: string;
  /** A maintainer's clone used to change `main` and `gh-pages` the way merges would. */
  maintainer: string;
  /** The action's workspace: a clone of `origin`, on `main`. */
  workspace: string;
}

export interface RegistryRepoOpts {
  requirePublisherNamespace?: boolean;
  /** The root seed the `gh-pages` index is signed with. */
  rootSeed?: Uint8Array;
}

const configBytes = (ns: boolean): string =>
  `${JSON.stringify({ format: 1, requirePublisherNamespace: ns }, null, 2)}\n`;

/** A registry exactly as `registry maintain init --github` lays it out, pushed to a bare origin. */
export async function makeRegistryRepo(
  root: string,
  o: RegistryRepoOpts = {},
): Promise<RegistryRepo> {
  const ns = o.requirePublisherNamespace ?? true;
  const maintainer = join(root, "maintainer");
  mkdirSync(maintainer, { recursive: true });
  git(maintainer, "init", "-q", "-b", "main");
  write(maintainer, "nimbus-registry.json", configBytes(ns));
  write(maintainer, "extensions/.gitkeep", "");
  write(maintainer, ".github/workflows/registry-check.yml", "name: check\n");
  write(maintainer, "README.md", "registry\n");
  git(maintainer, "add", "-A");
  git(maintainer, "commit", "-q", "-m", "init");

  git(maintainer, "checkout", "-q", "--orphan", "gh-pages");
  git(maintainer, "rm", "-rq", "--cached", ".");
  for (const f of ["README.md", ".github/workflows/registry-check.yml", "extensions/.gitkeep"]) {
    git(maintainer, "clean", "-fq", "--", f);
  }
  const index = await signIndex(
    emptyIndex(b64(publicKeyFromSeed(o.rootSeed ?? ROOT_SEED))),
    o.rootSeed ?? ROOT_SEED,
  );
  write(maintainer, "index.json", `${JSON.stringify(index, null, 2)}\n`);
  write(maintainer, "nimbus-registry.json", configBytes(ns));
  git(maintainer, "add", "index.json", "nimbus-registry.json");
  git(maintainer, "commit", "-q", "-m", "site");
  git(maintainer, "checkout", "-q", "main");

  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const originUrl = pathToFileURL(origin).href;
  git(maintainer, "remote", "add", "origin", originUrl);
  git(maintainer, "push", "-q", "origin", "main", "gh-pages");

  const workspace = join(root, "workspace");
  git(root, "clone", "-q", "--branch", "main", originUrl, workspace);
  return { root, origin, originUrl, maintainer, workspace };
}

/**
 * A fresh, independent copy of `template` at `root`: the three repositories are copied as files
 * and the two clones re-pointed at the copied origin, which is far cheaper than building one.
 */
export function copyRegistryRepo(template: RegistryRepo, root: string): RegistryRepo {
  cpSync(template.root, root, { recursive: true });
  const origin = join(root, "origin.git");
  const originUrl = pathToFileURL(origin).href;
  const maintainer = join(root, "maintainer");
  const workspace = join(root, "workspace");
  for (const clone of [maintainer, workspace]) git(clone, "remote", "set-url", "origin", originUrl);
  return { root, origin, originUrl, maintainer, workspace };
}

/** Commit everything in the maintainer clone's `branch` and push it, as a merge would land. */
export function pushMaintainer(repo: RegistryRepo, branch: string, message: string): string {
  git(repo.maintainer, "checkout", "-q", branch);
  git(repo.maintainer, "add", "-A");
  git(repo.maintainer, "commit", "-q", "--allow-empty", "-m", message);
  git(repo.maintainer, "push", "-q", "origin", branch);
  return git(repo.maintainer, "rev-parse", "HEAD").trim();
}

/** Bring the maintainer clone's `branch` up to `origin`'s. */
export function syncMaintainer(repo: RegistryRepo, branch: string): void {
  git(
    repo.maintainer,
    "fetch",
    "-q",
    "origin",
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  );
  git(repo.maintainer, "checkout", "-q", branch);
  git(repo.maintainer, "reset", "-q", "--hard", `origin/${branch}`);
}

/** `origin`'s copy of `path` on `branch`. */
export function originFile(repo: RegistryRepo, branch: string, path: string): Buffer {
  return execFileSync("git", ["cat-file", "blob", `${branch}:${path}`], {
    cwd: repo.origin,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The signed index on `origin`'s `gh-pages`. */
export function originIndex(repo: RegistryRepo): RegistryIndex {
  return JSON.parse(originFile(repo, "gh-pages", "index.json").toString("utf8")) as RegistryIndex;
}

export function originHead(repo: RegistryRepo, branch: string): string {
  return git(repo.origin, "rev-parse", branch).trim();
}
