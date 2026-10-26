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
  parseTrustStatement,
  type RegistryConfig,
  type RegistryIndex,
  trustStatementId,
  verifyRegistryIndexSelf,
} from "../../../registry-format/src/index.ts";
import type * as gitTree from "./git-tree.ts";

export const PAGES_BRANCH = "gh-pages";
export const PAGES_REF = `origin/${PAGES_BRANCH}`;
export const INDEX_FILE = "index.json";
export const CONFIG_FILE = "nimbus-registry.json";
/** Where a publish puts publisher-signed trust statements (`key.rotate`, `key.revoke`). */
export const STATEMENTS_DIR = "statements/";

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

/** A statement file is a handful of keys; anything larger is not one. */
const MAX_STATEMENT_FILE_BYTES = 16 * 1024;
const STATEMENT_FILE_RE = /^statements\/([0-9a-f]{64})\.json$/;

/** A `statements/` file that could not be handed to admission, and why. */
export interface StatementFileSkip {
  path: string;
  reason: string;
}

/** The statement files at `ref`, as parsed JSON values; each is named by its statement id. */
export interface StatementFiles {
  values: unknown[];
  skipped: StatementFileSkip[];
}

function readStatementFile(
  git: Git,
  ref: string,
  e: gitTree.TreeEntry,
  cwd: string,
): { value: unknown } | { reason: string } {
  const m = STATEMENT_FILE_RE.exec(e.path);
  if (m === null) return { reason: "must be statements/<64 lowercase hex statement id>.json" };
  if (e.mode !== git.REGULAR_FILE_MODE)
    return { reason: `git mode ${e.mode} is not a regular file` };
  const bytes = git.readBlob(ref, e.path, { cwd });
  if (bytes.byteLength > MAX_STATEMENT_FILE_BYTES) {
    return { reason: `exceeds ${String(MAX_STATEMENT_FILE_BYTES)} bytes` };
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { reason: "is not valid UTF-8 JSON" };
  }
  let id: string;
  try {
    id = trustStatementId(parseTrustStatement(value));
  } catch (e) {
    return { reason: `is not a valid trust statement: ${(e as Error).message}` };
  }
  if (id !== m[1]) return { reason: "is not named by its statement id" };
  return { value };
}

/**
 * The `statements/<id>.json` files at `ref` — publisher-signed trust statements a publish brings —
 * as parsed JSON values for `admitPublisherStatements`, plus the files that cannot be one (a
 * file that does not parse as a statement, or is not named by its statement id, is refused here).
 * `statements/.gitkeep` is ignored.
 */
export function readStatementFiles(git: Git, ref: string, cwd: string): StatementFiles {
  const out: StatementFiles = { values: [], skipped: [] };
  for (const e of git.listTreeEntries(ref, STATEMENTS_DIR, { cwd })) {
    if (e.path === `${STATEMENTS_DIR}.gitkeep`) continue;
    const r = readStatementFile(git, ref, e, cwd);
    if ("reason" in r) {
      out.skipped.push({ path: e.path, reason: r.reason });
    } else {
      out.values.push(r.value);
    }
  }
  return out;
}

/** The file a statement with this id was read from (files are named by their statement id). */
export function statementPath(id: string | undefined): string {
  return id === undefined ? STATEMENTS_DIR : `${STATEMENTS_DIR}${id}.json`;
}
