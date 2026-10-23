/**
 * `nimbus extension publish <dir> --registry-repo <owner/repo> [--clone <path>] [--channel
 * stable|beta] [--no-pr]` (design § 7.2, § 11.9): opens a pull request that adds
 * `extensions/<id>/<version>/{manifest.json,package.tgz,publish-request.json}` to a git-repository
 * registry. No gateway, no Vault, no token: `gh` owns GitHub auth and Nimbus never reads it.
 *
 * Everything that can refuse runs before the first git WRITE: the package is packed and validated
 * by the same `validatePublish` the registry's own check runs, against the signed `index.json` on
 * `gh-pages`, which is verified against its own root key first (the validator trusts its index).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import {
  effectiveRegistryConfig,
  type PublishVerdict,
  packExtensionDir,
  parseRegistryConfig,
  parseRegistryIndex,
  publisherKeyFingerprint,
  type RegistryChannel,
  type RegistryConfig,
  RegistryError,
  type RegistryIndex,
  validatePublish,
  verifyRegistryIndexSelf,
} from "@nimbus-dev/registry-format";
import { buildPublishCandidate } from "../lib/publish-candidate.ts";
import { rmDirWithRetry } from "../lib/rm-dir-with-retry.ts";
import { type RunTool, runTool } from "../lib/run-git.ts";

export interface PublishDeps {
  runTool: RunTool;
  /** Where the work dir and a temp clone go. */
  tmpdir: () => string;
  log: (s: string) => void;
  err: (s: string) => void;
  /** The clone URL of `<owner>/<repo>`; tests point it at a local bare repo. */
  repoUrl: (repo: string) => string;
}

const DEFAULT_DEPS: PublishDeps = {
  runTool,
  tmpdir: osTmpdir,
  log: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  repoUrl: (repo) => `https://github.com/${repo}.git`,
};

const USAGE =
  "Usage: nimbus extension publish <dir> --registry-repo <owner/repo> [--clone <path>] [--channel stable|beta] [--no-pr]\n";

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const FORK_REMOTE = "fork";
const PAGES = "gh-pages";
/** Applied to every `git add`/`git commit`, so the committed bytes are the bytes on disk. */
const RAW_BYTES = ["-c", "core.autocrlf=false", "-c", "core.eol=lf"];

/** A refusal or a failed tool, with the exit code it maps to. */
class PublishError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 = 2,
  ) {
    super(message);
  }
}

interface PublishArgs {
  dir: string;
  repo: string;
  clone: string | undefined;
  channel: RegistryChannel;
  noPr: boolean;
}

function parsePublishArgs(args: string[]): PublishArgs {
  const positional: string[] = [];
  const options = new Map<string, string>();
  let noPr = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--registry-repo" || a === "--clone" || a === "--channel") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) throw new PublishError(`${a} needs a value`);
      options.set(a, v);
      i++;
    } else if (a === "--no-pr") {
      noPr = true;
    } else if (a.startsWith("--")) {
      throw new PublishError(`unknown option ${a}`);
    } else {
      positional.push(a);
    }
  }
  const [dir] = positional;
  if (dir === undefined || positional.length !== 1) throw new PublishError("publish needs <dir>");
  const repo = options.get("--registry-repo");
  if (repo === undefined) throw new PublishError("--registry-repo <owner/repo> is required");
  // A repo part of only dots (`.`, `..`) is a path, not a repository.
  if (!REPO_RE.test(repo) || /^\.+$/.test(repo.split("/")[1] ?? "")) {
    throw new PublishError(`--registry-repo ${repo} is not <owner>/<repo>`);
  }
  const channel = options.get("--channel") ?? "stable";
  if (channel !== "stable" && channel !== "beta") {
    throw new PublishError("--channel must be stable or beta");
  }
  return { dir, repo, clone: options.get("--clone"), channel, noPr };
}

/** Run git in `cwd`; a non-zero exit is a `PublishError` (exit 1) carrying git's own message. */
async function git(deps: PublishDeps, cwd: string, args: string[]): Promise<string> {
  const r = await deps.runTool("git", args, { cwd });
  if (r.code !== 0) {
    const what = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c") ?? "";
    throw new PublishError(`git ${what} failed: ${r.stderr.trim()}`, 1);
  }
  return r.stdout;
}

interface RemoteState {
  defaultBranch: string;
}

/** The remote's default branch; refuses a remote with no `gh-pages`, since it has no signed index. */
async function readRemote(
  deps: PublishDeps,
  cwd: string,
  remote: string,
  repo: string,
): Promise<RemoteState> {
  const refs = await git(deps, cwd, [
    "ls-remote",
    "--symref",
    remote,
    "HEAD",
    `refs/heads/${PAGES}`,
  ]);
  const lines = refs.split(/\r?\n/);
  if (!lines.some((l) => l.endsWith(`\trefs/heads/${PAGES}`))) {
    throw new PublishError(
      `registry not initialised: ${repo} has no ${PAGES} branch holding a signed index.json`,
    );
  }
  const head = lines.find((l) => l.startsWith("ref: refs/heads/") && l.endsWith("\tHEAD"));
  const defaultBranch = head?.slice("ref: refs/heads/".length, -"\tHEAD".length) ?? "main";
  return { defaultBranch };
}

const GITHUB_REMOTE_RE =
  /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/([^/]+)$/i;

/**
 * A comparable form of a remote URL: `https://github.com/<o>/<r>[.git][/]`,
 * `ssh://git@github.com/<o>/<r>[.git]` and `git@github.com:<o>/<r>[.git]` all become
 * `github.com/<o>/<r>`; anything else (a local path in tests) keeps its own text. Case-insensitive.
 */
/** A loop, not a `/+$` regex, which backtracks quadratically on a long run of slashes. */
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") end--;
  return s.slice(0, end);
}

export function normaliseRemoteUrl(url: string): string {
  const trimmed = stripTrailingSlashes(url.trim().replaceAll("\\", "/")).replace(/\.git$/i, "");
  const gh = GITHUB_REMOTE_RE.exec(trimmed);
  return (gh === null ? trimmed : `github.com/${gh[1]}/${gh[2]}`).toLowerCase();
}

/** Refuses a `--clone` whose `origin` is not the registry the PR will target. */
async function assertCloneOrigin(deps: PublishDeps, clone: string, repo: string): Promise<void> {
  const origin = (await git(deps, clone, ["remote", "get-url", "origin"])).trim();
  const expected = deps.repoUrl(repo);
  if (normaliseRemoteUrl(origin) !== normaliseRemoteUrl(expected)) {
    throw new PublishError(
      `${clone}'s origin is ${origin}, not ${expected}; use a clone of ${repo} or omit --clone`,
    );
  }
}

/** A working clone with `origin/gh-pages` and `origin/<default>` current, and whether it is ours. */
async function openClone(
  a: PublishArgs,
  deps: PublishDeps,
  work: string,
): Promise<{ clone: string; temp: boolean; remote: RemoteState }> {
  if (a.clone !== undefined) {
    const clone = a.clone;
    if ((await git(deps, clone, ["status", "--porcelain"])).trim() !== "") {
      throw new PublishError(`${clone} is not clean; commit or discard its changes first`);
    }
    await assertCloneOrigin(deps, clone, a.repo);
    const remote = await readRemote(deps, clone, "origin", a.repo);
    await git(deps, clone, [
      "fetch",
      "origin",
      `+refs/heads/${PAGES}:refs/remotes/origin/${PAGES}`,
      `+refs/heads/${remote.defaultBranch}:refs/remotes/origin/${remote.defaultBranch}`,
    ]);
    return { clone, temp: false, remote };
  }
  const url = deps.repoUrl(a.repo);
  const remote = await readRemote(deps, work, url, a.repo);
  const clone = mkdtempSync(join(deps.tmpdir(), "nimbus-publish-clone-"));
  try {
    await git(deps, work, ["clone", "--depth", "1", "--no-single-branch", "--", url, clone]);
  } catch (e) {
    rmDirWithRetry(clone);
    throw e;
  }
  return { clone, temp: true, remote };
}

/** `git show <rev>:<path>`, or `undefined` when the path is not there. */
async function showFile(
  deps: PublishDeps,
  clone: string,
  rev: string,
  path: string,
): Promise<Uint8Array | undefined> {
  const r = await deps.runTool("git", ["show", `${rev}:${path}`], { cwd: clone });
  return r.code === 0 ? r.stdoutBytes : undefined;
}

/** The signed index on `gh-pages`, verified against its own root key before anything trusts it. */
async function readSignedIndex(
  deps: PublishDeps,
  clone: string,
  repo: string,
): Promise<RegistryIndex> {
  const bytes = await showFile(deps, clone, `origin/${PAGES}`, "index.json");
  if (bytes === undefined) {
    throw new PublishError(`registry not initialised: ${repo}'s ${PAGES} has no index.json`);
  }
  const index = parseRegistryIndex(bytes);
  await verifyRegistryIndexSelf(index);
  return index;
}

/**
 * The config the sign job enforces: the stricter of `gh-pages`'s and the default branch's, exactly
 * as the registry action's `check` reads it (`effectiveRegistryConfig`).
 */
async function readConfig(
  deps: PublishDeps,
  clone: string,
  defaultBranch: string,
): Promise<RegistryConfig> {
  const at = async (rev: string): Promise<RegistryConfig | undefined> => {
    const bytes = await showFile(deps, clone, rev, "nimbus-registry.json");
    return bytes === undefined ? undefined : parseRegistryConfig(bytes);
  };
  return effectiveRegistryConfig(await at(`origin/${PAGES}`), await at(`origin/${defaultBranch}`));
}

/** `-c user.name` / `-c user.email` for whichever of the two the author's git does not set. */
async function identityArgs(
  deps: PublishDeps,
  clone: string,
  publisherId: string,
): Promise<string[]> {
  const has = async (key: string): Promise<boolean> => {
    const r = await deps.runTool("git", ["config", "--get", key], { cwd: clone });
    return r.code === 0 && r.stdout.trim() !== "";
  };
  const out: string[] = [];
  if (!(await has("user.name"))) {
    out.push("-c", `user.name=${publisherId} (nimbus extension publish)`);
  }
  if (!(await has("user.email"))) {
    out.push("-c", `user.email=${publisherId}@nimbus-publish.invalid`);
  }
  return out;
}

const files = (v: PublishVerdict): string[] =>
  ["manifest.json", "package.tgz", "publish-request.json"].map(
    (f) => `extensions/${v.id}/${v.version}/${f}`,
  );

async function commitBranch(
  deps: PublishDeps,
  clone: string,
  defaultBranch: string,
  branch: string,
  v: PublishVerdict,
  bytes: { manifest: Uint8Array; package: Uint8Array; request: Uint8Array },
): Promise<void> {
  const exists = await deps.runTool(
    "git",
    ["cat-file", "-e", `origin/${defaultBranch}:extensions/${v.id}/${v.version}`],
    { cwd: clone },
  );
  if (exists.code === 0) {
    throw new PublishError(
      `extensions/${v.id}/${v.version} is already on ${defaultBranch}, waiting to be signed`,
    );
  }
  const taken = await deps.runTool(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: clone },
  );
  if (taken.code === 0) {
    throw new PublishError(
      `branch ${branch} already exists in ${clone}; delete it or use another clone`,
    );
  }
  await git(deps, clone, ["switch", "--no-track", "-c", branch, `origin/${defaultBranch}`]);
  const dest = join(clone, "extensions", ...v.id.split("/"), v.version);
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "manifest.json"), bytes.manifest);
  writeFileSync(join(dest, "package.tgz"), bytes.package);
  writeFileSync(join(dest, "publish-request.json"), bytes.request);
  await git(deps, clone, [...RAW_BYTES, "add", "--", ...files(v)]);
  const identity = await identityArgs(deps, clone, v.publisher.id);
  await git(deps, clone, [
    ...RAW_BYTES,
    ...identity,
    "commit",
    "-m",
    `Publish ${v.id}@${v.version}`,
  ]);
}

function prBody(v: PublishVerdict): string {
  return (
    `Publishes ${v.id}@${v.version} (${v.channel}) from publisher ${v.publisher.id}, ` +
    `key fingerprint ${publisherKeyFingerprint(v.publisher.key)}. Opened by nimbus extension publish.`
  );
}

/** Quote an argument for a printed command line; plain tokens stay bare. */
function q(arg: string): string {
  return /^[\w./@:=+-]+$/.test(arg) ? arg : `"${arg.replaceAll('"', String.raw`\"`)}"`;
}

function printManualSteps(
  deps: PublishDeps,
  a: PublishArgs,
  clone: string,
  defaultBranch: string,
  branch: string,
  v: PublishVerdict,
): void {
  const pr = [
    "gh pr create --repo",
    a.repo,
    "--base",
    defaultBranch,
    "--head",
    `<your-github-user>:${branch}`,
    "--title",
    `"Publish ${v.id}@${v.version}"`,
    "--body",
    q(prBody(v)),
  ].join(" ");
  deps.log(
    `Committed ${v.id}@${v.version} on branch ${branch} in ${clone}.\n` +
      "To open the pull request, run:\n" +
      `  cd ${q(clone)}\n` +
      `  gh repo fork --remote --remote-name ${FORK_REMOTE}\n` +
      `  git push ${FORK_REMOTE} ${branch}\n` +
      `  ${pr}\n` +
      `(Without gh: fork ${a.repo} on github.com, then \`git remote add ${FORK_REMOTE} ` +
      `https://github.com/<your-github-user>/${a.repo.split("/")[1] ?? ""}.git\`, push, and open ` +
      "the pull request in the browser.)\n",
  );
}

/** `<owner>` of a fork remote URL: `https://github.com/<owner>/<repo>`, `git@github.com:<owner>/<repo>`. */
function forkOwner(url: string): string {
  const parts = url
    .trim()
    .split(/[/:\\]/)
    .filter((p) => p !== "");
  const owner = parts.at(-2);
  if (owner === undefined) throw new PublishError(`cannot tell the fork's owner from ${url}`, 1);
  return owner;
}

/** Fork, push and open the PR through `gh`. Returns the PR URL gh printed. */
async function openPullRequest(
  deps: PublishDeps,
  a: PublishArgs,
  clone: string,
  defaultBranch: string,
  branch: string,
  v: PublishVerdict,
): Promise<string> {
  const gh = async (args: string[]): Promise<string> => {
    const r = await deps.runTool("gh", args, { cwd: clone });
    if (r.code !== 0) throw new PublishError(`gh ${args[0]} failed: ${r.stderr.trim()}`, 1);
    return r.stdout;
  };
  const forkUrl = async (): Promise<string | undefined> => {
    const r = await deps.runTool("git", ["remote", "get-url", FORK_REMOTE], { cwd: clone });
    return r.code === 0 ? r.stdout.trim() : undefined;
  };
  // An existing `fork` remote (a re-run, or the author's own) is reused, never re-forked.
  let url = await forkUrl();
  if (url === undefined) {
    // No repository argument: gh forks the clone's own `origin`, already verified to be `a.repo`,
    // and only then adds the `fork` remote to this clone.
    await gh(["repo", "fork", "--remote", "--remote-name", FORK_REMOTE]);
    url = await forkUrl();
  }
  if (url === undefined) {
    // gh forked but added no remote: point one at the signed-in user's fork.
    const login = (await gh(["api", "user", "--jq", ".login"])).trim();
    url = `https://github.com/${login}/${a.repo.split("/")[1] ?? ""}.git`;
    await git(deps, clone, ["remote", "add", FORK_REMOTE, url]);
  }
  const owner = forkOwner(url);
  await git(deps, clone, ["push", FORK_REMOTE, branch]);
  const prUrl = await gh([
    "pr",
    "create",
    "--repo",
    a.repo,
    "--base",
    defaultBranch,
    "--head",
    `${owner}:${branch}`,
    "--title",
    `Publish ${v.id}@${v.version}`,
    "--body",
    prBody(v),
  ]);
  return prUrl.trim();
}

async function publish(a: PublishArgs, deps: PublishDeps): Promise<number> {
  const work = mkdtempSync(join(deps.tmpdir(), "nimbus-publish-"));
  let clone: { clone: string; temp: boolean; remote: RemoteState } | undefined;
  let keepClone = false;
  try {
    const tgz = join(work, "package.tgz");
    await packExtensionDir(a.dir, tgz);
    const candidate = await buildPublishCandidate(tgz, work, a.channel);

    clone = await openClone(a, deps, work);
    const { defaultBranch } = clone.remote;
    const index = await readSignedIndex(deps, clone.clone, a.repo);
    const config = await readConfig(deps, clone.clone, defaultBranch);
    const v = await validatePublish(candidate, index, config, work);

    const branch = `publish/${v.id}/${v.version}`;
    await commitBranch(deps, clone.clone, defaultBranch, branch, v, {
      manifest: candidate.manifestBytes,
      package: candidate.packageBytes,
      request: candidate.publishRequestBytes,
    });

    const ghReady =
      !a.noPr && (await deps.runTool("gh", ["auth", "status"], { cwd: clone.clone })).code === 0;
    if (!ghReady) {
      keepClone = true;
      if (!a.noPr) deps.log("gh is not installed or not signed in; not opening the PR.\n");
      printManualSteps(deps, a, clone.clone, defaultBranch, branch, v);
      return 0;
    }
    try {
      const url = await openPullRequest(deps, a, clone.clone, defaultBranch, branch, v);
      deps.log(`Opened ${url}\n`);
      return 0;
    } catch (e) {
      keepClone = true;
      printManualSteps(deps, a, clone.clone, defaultBranch, branch, v);
      throw e;
    }
  } finally {
    rmDirWithRetry(work);
    if (clone?.temp === true && !keepClone) rmDirWithRetry(clone.clone);
  }
}

/** Exit 0 on success; 2 for a usage error or a refusal (`CODE: detail`); 1 for a failed tool or anything unexpected. */
export async function runExtensionPublish(
  args: string[],
  deps: PublishDeps = DEFAULT_DEPS,
): Promise<number> {
  let parsed: PublishArgs;
  try {
    parsed = parsePublishArgs(args);
  } catch (e) {
    deps.err(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  try {
    return await publish(parsed, deps);
  } catch (e) {
    if (e instanceof RegistryError) {
      deps.err(`${e.message}\n`);
      return 2;
    }
    if (e instanceof PublishError) {
      deps.err(`${e.message}\n`);
      return e.exitCode;
    }
    deps.err(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
