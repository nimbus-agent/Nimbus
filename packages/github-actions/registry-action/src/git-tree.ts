/**
 * Read a registry repository from its git TREE, never from the working directory (design § 11.4).
 *
 * A working-directory read follows symlinks and sees whatever a checkout materialised; a tree read
 * sees exactly what was committed, with its mode. So every file the `check` and `sign` modes judge
 * comes through here: `listTreeEntries` refuses anything under `extensions/` that is not a regular
 * `100644` file (a `120000` symlink or a `160000` submodule above all) and any path that is not a
 * plain relative one, and `readBlob` reads the committed bytes by `<ref>:<path>`.
 *
 * `actions/checkout` fetches only the triggering ref, so the base branch and `gh-pages` are fetched
 * explicitly (`fetchRefs`), and the PR diff is taken from the merge base (`findMergeBase`), deepening
 * the shallow history a bounded number of times until one exists.
 *
 * Runs on node24 inside the action bundle: `node:child_process` only, argv arrays, `windowsHide`.
 */
import { execFileSync } from "node:child_process";

/** Where the git commands run (the registry repository's checkout). */
export interface GitOptions {
  cwd: string;
}

/** One `git ls-tree` entry. */
export interface TreeEntry {
  /** The octal git mode, e.g. `100644`. */
  mode: string;
  /** Repository-relative, `/`-separated. */
  path: string;
  /** The object id of the entry. */
  blob: string;
}

/** One `git diff-tree` change between two commits. */
export interface TreeChange {
  /** `A`dded, `M`odified, `D`eleted, `T`ype changed, … (git's status letter). */
  status: string;
  path: string;
  /** The mode on the `to` side (`000000` for a deletion). */
  mode: string;
}

/** The only mode accepted under `extensions/`: a regular, non-executable file. */
export const REGULAR_FILE_MODE = "100644";

const EXTENSIONS_PREFIX = "extensions/";

/** Larger than the 50 MiB package cap, so a capped package is never cut short by the pipe. */
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export const REGISTRY_NOT_INITIALISED =
  "registry not initialised: push the init --github site to gh-pages first";

function git(args: readonly string[], opts: GitOptions): Buffer {
  return execFileSync("git", [...args], {
    cwd: opts.cwd,
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function stderrOf(err: unknown): string {
  if (err !== null && typeof err === "object" && "stderr" in err) {
    const s = (err as { stderr: unknown }).stderr;
    if (typeof s === "string") return s;
    if (s instanceof Uint8Array) return Buffer.from(s).toString("utf8");
  }
  return err instanceof Error ? err.message : String(err);
}

/** A branch name safe to place in a refspec and on a git argv. */
function assertBranchName(name: string): void {
  if (
    name === "" ||
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.includes("..") ||
    !/^[A-Za-z0-9._/-]+$/.test(name)
  ) {
    throw new Error(`refusing unsafe branch name: ${JSON.stringify(name)}`);
  }
}

/** A revision (branch, remote-tracking ref or sha) that git cannot read as an option. */
function assertRev(rev: string): void {
  if (rev === "" || rev.startsWith("-") || !/^[A-Za-z0-9._/^~@-]+$/.test(rev)) {
    throw new Error(`refusing unsafe revision: ${JSON.stringify(rev)}`);
  }
}

/**
 * A committed path is accepted only as a plain relative `/`-separated path: no absolute form, no
 * drive letter, no backslash, no empty / `.` / `..` segment, no control character. git itself
 * refuses most of these on checkout, but a crafted tree can still carry them, and the callers join
 * these paths onto directories.
 */
export function assertSafeTreePath(path: string): void {
  const segments = path.split("/");
  const bad =
    path === "" ||
    path.includes("\\") ||
    /^[A-Za-z]:/.test(path) ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
    /[\x00-\x1f\x7f]/.test(path) ||
    segments.some((s) => s === "" || s === "." || s === "..");
  if (bad) throw new Error(`refusing unsafe path in git tree: ${JSON.stringify(path)}`);
}

function refspecFor(branch: string): string {
  return `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
}

/**
 * Fetch `origin/<ref>` for each branch name, shallowly. A missing `gh-pages` means the registry was
 * never initialised, which gets its own message; any other failure names git's own error.
 */
export function fetchRefs(refs: readonly string[], opts: GitOptions): void {
  for (const r of refs) assertBranchName(r);
  try {
    git(["fetch", "--no-tags", "--depth=1", "origin", ...refs.map(refspecFor)], opts);
  } catch (err) {
    const stderr = stderrOf(err);
    const missing = /couldn't find remote ref (\S+)/.exec(stderr)?.[1];
    if (missing === "refs/heads/gh-pages" || missing === "gh-pages") {
      throw new Error(REGISTRY_NOT_INITIALISED);
    }
    throw new Error(`git fetch ${refs.join(" ")} failed: ${stderr.trim()}`);
  }
}

/**
 * Every blob under `prefix` at `ref`, recursively. Refuses (throws) when any entry under
 * `extensions/` is not a regular `100644` file, and when any path is not a plain relative one.
 */
export function listTreeEntries(ref: string, prefix: string, opts: GitOptions): TreeEntry[] {
  assertRev(ref);
  const args = ["--literal-pathspecs", "ls-tree", "-r", "-z", "--full-tree", ref];
  if (prefix !== "") {
    assertSafeTreePath(prefix.replace(/\/$/, ""));
    args.push("--", prefix);
  }
  const out = git(args, opts).toString("utf8");
  const entries: TreeEntry[] = [];
  for (const record of out.split("\0")) {
    if (record === "") continue;
    // `<mode> SP <type> SP <object> TAB <path>`
    const tab = record.indexOf("\t");
    const [mode, , blob] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (tab < 0 || mode === undefined || blob === undefined) {
      throw new Error(`unparseable git ls-tree record: ${JSON.stringify(record)}`);
    }
    assertSafeTreePath(path);
    if (path.startsWith(EXTENSIONS_PREFIX) && mode !== REGULAR_FILE_MODE) {
      throw new Error(
        `refusing ${path}: git mode ${mode} is not a regular file (${REGULAR_FILE_MODE}); symlinks, submodules and executables are not accepted under extensions/`,
      );
    }
    entries.push({ mode, path, blob });
  }
  return entries;
}

/** The committed bytes of `path` at `ref`. */
export function readBlob(ref: string, path: string, opts: GitOptions): Uint8Array {
  assertRev(ref);
  assertSafeTreePath(path);
  return new Uint8Array(git(["cat-file", "blob", `${ref}:${path}`], opts));
}

function tryMergeBase(a: string, b: string, opts: GitOptions): string | null {
  try {
    return git(["merge-base", a, b], opts).toString("utf8").trim();
  } catch {
    return null;
  }
}

/** Options for `findMergeBase`. */
export interface MergeBaseOptions extends GitOptions {
  /** Branch names whose history is deepened (fetched into `origin/<name>`). */
  deepen: readonly string[];
  /** Commits added per deepening round. */
  step?: number;
  /** Deepening rounds before giving up. */
  maxRounds?: number;
}

/**
 * The merge base of `a` and `b`. In a shallow clone it may not be present yet, so the history of
 * `opts.deepen` is deepened by `step` commits at a time, at most `maxRounds` times; a complete
 * (non-shallow) history without a merge base fails at once.
 */
export function findMergeBase(a: string, b: string, opts: MergeBaseOptions): string {
  assertRev(a);
  assertRev(b);
  for (const r of opts.deepen) assertBranchName(r);
  const step = opts.step ?? 50;
  const maxRounds = opts.maxRounds ?? 10;
  for (let round = 0; ; round++) {
    const base = tryMergeBase(a, b, opts);
    if (base !== null) return base;
    const shallow =
      git(["rev-parse", "--is-shallow-repository"], opts).toString("utf8").trim() === "true";
    if (!shallow) throw new Error(`${a} and ${b} have no common history`);
    if (round >= maxRounds) {
      throw new Error(
        `no merge base of ${a} and ${b} within ${maxRounds} rounds of ${step} commits`,
      );
    }
    git(["fetch", "--no-tags", `--deepen=${step}`, "origin", ...opts.deepen.map(refspecFor)], opts);
  }
}

/** What changed from `from` to `to`, file by file (no rename detection, so a move is D + A). */
export function diffTree(from: string, to: string, opts: GitOptions): TreeChange[] {
  assertRev(from);
  assertRev(to);
  const out = git(["diff-tree", "-r", "-z", "--no-renames", from, to], opts).toString("utf8");
  // `:<oldmode> SP <newmode> SP <oldsha> SP <newsha> SP <status> NUL <path> NUL`
  const fields = out.split("\0");
  const changes: TreeChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i] ?? "";
    const path = fields[i + 1] ?? "";
    const parts = meta.replace(/^:/, "").split(" ");
    const mode = parts[1];
    const status = parts[4];
    if (!meta.startsWith(":") || mode === undefined || status === undefined) {
      throw new Error(`unparseable git diff-tree record: ${JSON.stringify(meta)}`);
    }
    assertSafeTreePath(path);
    changes.push({ status, path, mode });
  }
  return changes;
}
