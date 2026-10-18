/**
 * The registry state `check` and `sign` judge a publish by, read from the git TREE (design § 7.3,
 * § 11.4, § 11.6): the signed `index.json` on `gh-pages` — verified against its OWN root key here,
 * before anything trusts it, because `validatePublish` trusts the index it is handed — the
 * `nimbus-registry.json` rules, and the three committed files of one `extensions/<id>/<version>/`.
 */
import {
  type PublishCandidate,
  parseRegistryConfig,
  parseRegistryIndex,
  type RegistryConfig,
  type RegistryIndex,
  verifyRegistryIndexSelf,
} from "../../../registry-format/src/index.ts";
import type * as gitTree from "./git-tree.ts";

export const PAGES_BRANCH = "gh-pages";
export const PAGES_REF = `origin/${PAGES_BRANCH}`;
export const INDEX_FILE = "index.json";
export const CONFIG_FILE = "nimbus-registry.json";

/** The three files a publish adds, and the only files an `extensions/<id>/<version>/` may hold. */
export const CANDIDATE_FILES = ["manifest.json", "package.tgz", "publish-request.json"] as const;

type Git = typeof gitTree;

/** True when `path` is a file in the tree of `ref`. */
function hasFile(git: Git, ref: string, path: string, cwd: string): boolean {
  return git.listTreeEntries(ref, path, { cwd }).some((e) => e.path === path);
}

/**
 * The signed index on `gh-pages`, parsed strictly and verified against its own root key. A
 * missing index means the registry was never initialised.
 */
export async function readVerifiedIndex(git: Git, cwd: string): Promise<RegistryIndex> {
  if (!hasFile(git, PAGES_REF, INDEX_FILE, cwd)) throw new Error(git.REGISTRY_NOT_INITIALISED);
  const index = parseRegistryIndex(git.readBlob(PAGES_REF, INDEX_FILE, { cwd }));
  await verifyRegistryIndexSelf(index);
  return index;
}

/** `nimbus-registry.json` at `ref` with its committed bytes, or `undefined` when there is none. */
export function readConfigAt(
  git: Git,
  ref: string,
  cwd: string,
): { config: RegistryConfig; bytes: Uint8Array } | undefined {
  if (!hasFile(git, ref, CONFIG_FILE, cwd)) return undefined;
  const bytes = git.readBlob(ref, CONFIG_FILE, { cwd });
  return { config: parseRegistryConfig(bytes), bytes };
}

/**
 * True when `next` drops a rule `prev` imposes. Today that is one rule: `requirePublisherNamespace`
 * turned from true to false.
 */
export function loosens(prev: RegistryConfig, next: RegistryConfig): boolean {
  return prev.requirePublisherNamespace && !next.requirePublisherNamespace;
}

/** `extensions/<id>/<version>` split into the id (which may hold `/`) and the version. */
export function splitExtensionDir(dir: string): { id: string; version: string } | undefined {
  const m = /^extensions\/(.+)\/([^/]+)$/.exec(dir);
  if (m?.[1] === undefined || m[2] === undefined) return undefined;
  return { id: m[1], version: m[2] };
}

/** The candidate `extensions/<id>/<version>/` at `ref`, as the committed bytes. */
export function readCandidate(
  git: Git,
  ref: string,
  dir: { id: string; version: string },
  cwd: string,
): PublishCandidate {
  const base = `extensions/${dir.id}/${dir.version}`;
  const read = (file: string): Uint8Array => git.readBlob(ref, `${base}/${file}`, { cwd });
  return {
    dirId: dir.id,
    dirVersion: dir.version,
    manifestBytes: read("manifest.json"),
    packageBytes: read("package.tgz"),
    publishRequestBytes: read("publish-request.json"),
  };
}
