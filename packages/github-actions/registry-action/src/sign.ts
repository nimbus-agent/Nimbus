/**
 * `mode: sign` — the content boundary, run behind the `registry-signing` environment's required
 * approval (design § 7.4, § 11.6–11.8). Every attempt starts from a fresh fetch of the default
 * branch and `gh-pages`, and refuses — failing the run with nothing signed or pushed — when:
 *
 * - the signed `gh-pages` index does not verify against its own root key;
 * - the `root-key` input's public half is not that index's `rootKey`;
 * - the default branch's `nimbus-registry.json` is missing or loosens `gh-pages`'s copy (§ 11.6);
 * - an already-signed version's `manifest.json` or `package.tgz` changed or was deleted (§ 11.7).
 *
 * Only then is every unsigned `extensions/<id>/<version>/` validated with `validatePublish` against
 * the signed bindings (plus the ones this run adds before it). A dir that fails is SKIPPED with a
 * `::warning::` and a summary line and the run still succeeds (§ 11.8). Passing dirs become entries,
 * the index is re-signed at `sequence + 1`, and the site is committed to `gh-pages` and pushed; a
 * push that loses a race starts over from the top, at most `MAX_ATTEMPTS` times. Nothing new means
 * no new signature and no commit.
 *
 * The root key is a secret. It is parsed in memory only, never written to disk, and never named in
 * a message: refusals name fingerprints of PUBLIC keys. `main.ts` masks the input before this runs.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import {
  publicKeyFromSeed,
  publisherKeyFingerprint,
  RegistryError,
  type RegistryExtensionEntry,
  type RegistryIndex,
  signIndex,
  validatePublish,
  verifyRegistryIndexPinned,
} from "../../../registry-format/src/index.ts";
import * as gitTree from "./git-tree.ts";
import {
  CANDIDATE_FILES,
  CONFIG_FILE,
  INDEX_FILE,
  loosens,
  PAGES_BRANCH,
  PAGES_REF,
  readCandidate,
  readConfigAt,
  readVerifiedIndex,
  splitExtensionDir,
} from "./registry-state.ts";
import { type ActionIo, code, GHA_IO } from "./report.ts";
import { commitSite, pushCommit, type SiteFile } from "./site-commit.ts";

/** Inputs `sign` needs. */
export interface SignOptions {
  /** The registry repository's checkout. */
  workspace: string;
  /** The `root-key` input: base64 of the 32-byte Ed25519 seed `registry maintain init` writes. */
  rootKey: string;
  /** The default branch; asked of `origin` when absent. */
  defaultBranch?: string;
}

/** What `sign` reads, judges, signs and reports with; injectable for tests. */
export interface SignDeps {
  validate: typeof validatePublish;
  sign: typeof signIndex;
  git: typeof gitTree;
  io: ActionIo;
  /** Where the validator's scratch directory goes. */
  tmpdir: () => string;
  /** Called between building the commit and pushing it; tests race a concurrent push here. */
  beforePush?: (attempt: number) => void;
}

const SHARED: SignDeps = {
  validate: validatePublish,
  sign: signIndex,
  git: gitTree,
  io: GHA_IO,
  tmpdir: osTmpdir,
};

/** Fetch-validate-sign-push attempts before a push that keeps losing the race fails the run. */
const MAX_ATTEMPTS = 3;

const ROOT_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

/**
 * The 32-byte seed in the `root-key` input. A malformed key is refused with a message that does
 * not repeat it.
 */
function parseRootKey(raw: string): Uint8Array {
  const s = raw.trim();
  if (!ROOT_KEY_RE.test(s)) {
    throw new Error(
      'input "root-key" is not a registry root key: expected the base64 of a 32-byte Ed25519 seed, as `nimbus registry maintain init` writes it',
    );
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}

interface Skipped {
  dir: string;
  reason: string;
}

interface Added {
  id: string;
  version: string;
  channel: string;
}

interface Attempt {
  /** The commit to push, or `undefined` when `gh-pages` already holds this site. */
  commit: string | undefined;
  added: Added[];
  skipped: Skipped[];
  sequence: number;
}

/** Every `extensions/<id>/<version>` on `ref` with the file names directly inside it. */
function extensionDirs(
  git: typeof gitTree,
  ref: string,
  cwd: string,
): { dirs: Map<string, Set<string>>; paths: Set<string> } {
  const dirs = new Map<string, Set<string>>();
  const paths = new Set<string>();
  for (const e of git.listTreeEntries(ref, "extensions/", { cwd })) {
    paths.add(e.path);
    const slash = e.path.lastIndexOf("/");
    const dir = e.path.slice(0, slash);
    if (dir === "extensions") continue; // e.g. `extensions/.gitkeep`
    const names = dirs.get(dir) ?? new Set<string>();
    names.add(e.path.slice(slash + 1));
    dirs.set(dir, names);
  }
  return { dirs, paths };
}

const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** § 11.7: every signed version is still on `ref`, byte for byte. */
function assertSignedIntact(
  git: typeof gitTree,
  index: RegistryIndex,
  ref: string,
  paths: ReadonlySet<string>,
  cwd: string,
): Set<string> {
  const problems: string[] = [];
  const signedDirs = new Set<string>();
  for (const [id, ext] of Object.entries(index.extensions)) {
    for (const [version, v] of Object.entries(ext.versions)) {
      signedDirs.add(`extensions/${id}/${version}`);
      for (const [path, want] of [
        [v.manifest, v.manifestSha256],
        [v.package, v.packageSha256],
      ] as const) {
        if (!paths.has(path)) {
          problems.push(`${path} is signed but was deleted`);
        } else if (sha256Hex(git.readBlob(ref, path, { cwd })) !== want) {
          problems.push(`${path} differs from the signed version`);
        }
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `refusing to sign: already-signed versions changed on the default branch (a signed version is immutable): ${problems.join("; ")}`,
    );
  }
  return signedDirs;
}

function sameFileSet(names: ReadonlySet<string>): boolean {
  return names.size === CANDIDATE_FILES.length && CANDIDATE_FILES.every((f) => names.has(f));
}

/** One attempt, from a fresh fetch to a commit ready to push. Throws on any refusal. */
async function attemptSign(
  opts: SignOptions & { defaultBranch: string },
  seed: Uint8Array,
  rootKey: string,
  deps: SignDeps,
): Promise<Attempt> {
  const { git } = deps;
  const cwd = opts.workspace;
  const mainRef = `origin/${opts.defaultBranch}`;
  git.fetchRefs([opts.defaultBranch, PAGES_BRANCH], { cwd });

  const index = await readVerifiedIndex(git, cwd);
  if (index.rootKey !== rootKey) {
    throw new Error(
      `refusing to sign: the root-key input (public key fingerprint ${publisherKeyFingerprint(rootKey)}) is not this registry's root key (fingerprint ${publisherKeyFingerprint(index.rootKey)})`,
    );
  }

  const config = readConfigAt(git, mainRef, cwd);
  if (config === undefined) {
    throw new Error(`refusing to sign: ${opts.defaultBranch} has no ${CONFIG_FILE}`);
  }
  const pagesConfig = readConfigAt(git, PAGES_REF, cwd);
  if (pagesConfig !== undefined && loosens(pagesConfig.config, config.config)) {
    throw new Error(
      `refusing to sign: ${opts.defaultBranch}'s ${CONFIG_FILE} loosens the rules the last signed run used (requirePublisherNamespace true -> false); loosening is a maintainer action done by hand`,
    );
  }

  const { dirs, paths } = extensionDirs(git, mainRef, cwd);
  const signedDirs = assertSignedIntact(git, index, mainRef, paths, cwd);

  const extensions: Record<string, RegistryExtensionEntry> = { ...index.extensions };
  const publishedAt = git.commitTime(mainRef, { cwd });
  const added: Added[] = [];
  const skipped: Skipped[] = [];
  const files: SiteFile[] = [{ path: CONFIG_FILE, bytes: config.bytes }];
  const work = mkdtempSync(join(deps.tmpdir(), "nimbus-registry-sign-"));
  try {
    for (const dir of [...dirs.keys()].filter((d) => !signedDirs.has(d)).sort()) {
      const coords = splitExtensionDir(dir);
      const names = dirs.get(dir) ?? new Set<string>();
      if (coords === undefined || !sameFileSet(names)) {
        skipped.push({
          dir,
          reason: `must hold exactly ${CANDIDATE_FILES.join(", ")}; holds ${[...names].sort().join(", ")}`,
        });
        continue;
      }
      const candidate = readCandidate(git, mainRef, coords, cwd);
      let v: Awaited<ReturnType<typeof validatePublish>>;
      try {
        // Against the signed bindings plus this run's additions, so two new dirs cannot disagree.
        v = await deps.validate(candidate, { ...index, extensions }, config.config, work);
      } catch (e) {
        if (!(e instanceof RegistryError)) throw e;
        skipped.push({ dir, reason: e.message });
        continue;
      }
      const base = `extensions/${v.id}/${v.version}`;
      const existing = extensions[v.id];
      extensions[v.id] = {
        publisher: existing?.publisher ?? v.publisher,
        versions: {
          ...existing?.versions,
          [v.version]: {
            channel: v.channel,
            name: v.name,
            manifest: `${base}/manifest.json`,
            manifestSha256: v.manifestSha256,
            package: `${base}/package.tgz`,
            packageSha256: v.packageSha256,
            packageSizeBytes: v.packageSizeBytes,
            entryHash: v.entryHash,
            publishedAt,
          },
        },
      };
      files.push(
        { path: `${base}/manifest.json`, bytes: candidate.manifestBytes },
        { path: `${base}/package.tgz`, bytes: candidate.packageBytes },
      );
      added.push({ id: v.id, version: v.version, channel: v.channel });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  let sequence = index.sequence;
  if (added.length > 0) {
    const signed = await deps.sign(
      {
        format: 1,
        rootKey: index.rootKey,
        sequence: index.sequence + 1,
        generatedAt: new Date().toISOString(),
        extensions,
      },
      seed,
    );
    // What a client will do first: verify it against the root key it pinned.
    await verifyRegistryIndexPinned(signed, rootKey);
    sequence = signed.sequence;
    files.push({
      path: INDEX_FILE,
      bytes: new TextEncoder().encode(`${JSON.stringify(signed, null, 2)}\n`),
    });
  }
  const message =
    added.length > 0
      ? `Sign ${added.map((a) => `${a.id}@${a.version}`).join(", ")} (sequence ${String(sequence)})`
      : `Copy ${CONFIG_FILE} from ${opts.defaultBranch}`;
  const parent = git.commitOf(PAGES_REF, { cwd });
  return { commit: commitSite(parent, files, message, cwd), added, skipped, sequence };
}

function report(io: ActionIo, a: Attempt, pushed: boolean): void {
  for (const s of a.skipped) io.annotate("warning", `skipped ${s.dir}: ${s.reason}`);
  const lines = ["## Registry sign", ""];
  if (a.added.length === 0) {
    lines.push("Nothing new to sign.");
  } else {
    lines.push(`Signed index sequence ${String(a.sequence)}:`, "");
    for (const x of a.added) lines.push(`- ${code(`${x.id}@${x.version}`)} (${x.channel})`);
  }
  if (a.skipped.length > 0) {
    lines.push(
      "",
      "**Skipped** (not signed; fix the directory and it is signed on a later run):",
      "",
    );
    for (const s of a.skipped) lines.push(`- ${code(s.dir)}: ${code(s.reason)}`);
  }
  lines.push("", pushed ? `Pushed to ${code(PAGES_BRANCH)}.` : "No change: nothing was committed.");
  io.summary(lines.join("\n"));
  io.log(
    pushed
      ? `signed ${String(a.added.length)} version(s), skipped ${String(a.skipped.length)}; pushed ${PAGES_BRANCH}`
      : `nothing to sign; skipped ${String(a.skipped.length)}; no commit`,
  );
}

/** Run the `sign` mode. Throws (failing the run, nothing pushed) on any refusal. */
export async function runSign(opts: SignOptions, deps: SignDeps = SHARED): Promise<void> {
  const seed = parseRootKey(opts.rootKey);
  const rootKey = Buffer.from(publicKeyFromSeed(seed)).toString("base64");
  const defaultBranch = opts.defaultBranch ?? deps.git.remoteDefaultBranch({ cwd: opts.workspace });
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const a = await attemptSign({ ...opts, defaultBranch }, seed, rootKey, deps);
    if (a.commit === undefined) {
      report(deps.io, a, false);
      return;
    }
    deps.beforePush?.(attempt);
    if (pushCommit(a.commit, PAGES_BRANCH, opts.workspace) === "pushed") {
      report(deps.io, a, true);
      return;
    }
    deps.io.log(`${PAGES_BRANCH} moved during attempt ${String(attempt)}; starting over`);
  }
  throw new Error(
    `refusing to continue: the push to ${PAGES_BRANCH} lost to a concurrent update ${String(MAX_ATTEMPTS)} times`,
  );
}
