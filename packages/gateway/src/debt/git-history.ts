import { extensionProcessEnv } from "../extensions/spawn-env.ts";

/**
 * The ONLY child process of `nimbus incident debt` (Phase 10 IC7b): three bounded, read-only git calls over
 * one of the owner's own configured `[[filesystem.roots]]`.
 *
 * Security shape (the plan's stated decision):
 *  - Direct `Bun.spawn(["git", "-C", root, ...])`, the same class as `connectors/blame-index-sync.ts` and
 *    `ownership/repo-remote.ts`; not the sandbox runner (I15 governs MCP server specs) and not the exec
 *    gate (I33 is user-supplied code). It lives under `debt/`, not `incident/`, so I57 (a) stays true.
 *  - Env (I1): `extensionProcessEnv` (the baseline key list, no credential) plus constant GIT_ / locale keys.
 *  - argv is a constant list. `<root>` is the owner's configured path; NO pathspec is ever passed, so no
 *    third-party value (a PR file name, a symbol, a repo name) reaches argv.
 *  - stdout is read through a byte cap that kills the child; each call has a deadline; stderr and stdin are
 *    ignored; the window is hidden (D25 precedent).
 */

export type SpawnFn = typeof Bun.spawn;

export const GIT_TIMEOUT_MS = 30_000;
export const GIT_OUTPUT_CAP_BYTES = 32 * 1024 * 1024;
export const LOG_MAX_COMMITS = 20_000;

/** Constant global options placed before every subcommand. */
export const GIT_GLOBAL_ARGS: readonly string[] = ["-c", "core.fsmonitor=false", "--no-pager"];
export const REV_PARSE_ARGS: readonly string[] = [
  "rev-parse",
  "--is-shallow-repository",
  "--show-prefix",
];
export const LS_FILES_ARGS: readonly string[] = ["ls-files", "-z", "--cached"];
export const LOG_ARGS: readonly string[] = [
  "log",
  "--raw",
  "--no-renames",
  "--relative",
  "-z",
  "--no-ext-diff",
  "--no-textconv",
  "--no-show-signature",
  `--max-count=${String(LOG_MAX_COMMITS)}`,
  "--pretty=format:%x01%ct",
];

export type GitHistory = {
  /** The root's path inside the repository (`sub/dir/` or `""`), with forward slashes. */
  readonly prefix: string;
  /** Tracked paths, relative to the root. */
  readonly tracked: ReadonlySet<string>;
  /** Newest commit time (ms) per path, relative to the root. */
  readonly lastTouchMs: ReadonlyMap<string, number>;
  /** The oldest commit time read, or null when no commit was read. */
  readonly oldestCommitMs: number | null;
  /** True when the log reached the first commit (neither the commit cap nor the byte cap cut it). */
  readonly complete: boolean;
};

export type GitHistoryFailure = "not_a_repo" | "shallow" | "git_failed" | "too_large";

export type GitHistoryResult =
  | { readonly ok: true; readonly history: GitHistory }
  | { readonly ok: false; readonly reason: GitHistoryFailure };

export type GitHistoryReader = (root: string) => Promise<GitHistoryResult>;

type RunOut = { readonly code: number; readonly out: string; readonly truncated: boolean };

const GIT_ENV_EXTRA: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
};

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  kill: () => void,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > GIT_OUTPUT_CAP_BYTES) {
      chunks.push(value.subarray(0, GIT_OUTPUT_CAP_BYTES - total));
      truncated = true;
      kill();
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

/** One git call. Never throws: a spawn failure, a timeout or an abort is `{ code: -1 }`. */
export async function runGit(
  root: string,
  subArgs: readonly string[],
  spawn: SpawnFn = Bun.spawn,
): Promise<RunOut> {
  try {
    const proc = spawn(["git", "-C", root, ...GIT_GLOBAL_ARGS, ...subArgs], {
      env: extensionProcessEnv(GIT_ENV_EXTRA),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
    });
    const { text, truncated } = await readCapped(proc.stdout as ReadableStream<Uint8Array>, () =>
      proc.kill(),
    );
    const code = truncated ? 0 : await proc.exited;
    return { code, out: text, truncated };
  } catch {
    return { code: -1, out: "", truncated: false };
  }
}

/** `rev-parse --is-shallow-repository --show-prefix` prints `true|false`, then the prefix line. */
export function parseRevParse(out: string): { shallow: boolean; prefix: string } | null {
  const lines = out.split("\n");
  const shallow = lines[0]?.trim();
  if (shallow !== "true" && shallow !== "false") return null;
  return { shallow: shallow === "true", prefix: (lines[1] ?? "").trim() };
}

export function parseLsFiles(out: string): Set<string> {
  const set = new Set<string>();
  for (const p of out.split("\0")) if (p !== "") set.add(p);
  return set;
}

/** `git log -z` ends the header with a newline, not a NUL: the first meta token rides on the header token. */
const HEADER_BODY_RE = /^(\d{1,12})(?:\n([\s\S]*))?$/;
/** A commit header starts with the byte 0x01 (the `%x01` of the log format). */
const HEADER_MARK = 1;
const META_RE = /^:\d{6} \d{6} [0-9a-f]+ [0-9a-f]+ [A-Z]$/;

function record(into: Map<string, number>, path: string, at: number | null): void {
  if (at !== null && path !== "" && (into.get(path) ?? -1) < at) into.set(path, at);
}

export type ParsedLog = {
  readonly lastTouchMs: ReadonlyMap<string, number>;
  readonly oldestCommitMs: number | null;
  readonly commits: number;
};

/**
 * Parses `log --raw -z --pretty=format:%x01%ct` output.
 *
 * A file name is attacker-influenced text. A meta token (`:100644 100644 a b M`) is always followed by exactly
 * one path token, and that token is consumed WITHOUT being examined, so a file named like a commit header or
 * like a meta line cannot forge a time or a path. A header is only recognised outside a path slot.
 *
 * When `truncated`, the final token may be cut and the final commit may be incompletely listed: the last
 * token is dropped and the last commit's time is left out of `oldestCommitMs` (its paths still count: a
 * listed path really was in that commit).
 */
export function parseLog(out: string, truncated: boolean): ParsedLog {
  const tokens = out.split("\0");
  if (truncated) tokens.pop();
  const lastTouch = new Map<string, number>();
  const commitTimes: number[] = [];
  let current: number | null = null;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i] as string;
    const header = t.charCodeAt(0) === HEADER_MARK ? HEADER_BODY_RE.exec(t.slice(1)) : null;
    if (header !== null) {
      current = Number(header[1]) * 1000;
      commitTimes.push(current);
      i += 1;
      if (header[2] !== undefined && META_RE.test(header[2])) {
        const first = tokens[i];
        if (first === undefined) break;
        record(lastTouch, first, current);
        i += 1;
      }
    } else if (META_RE.test(t)) {
      const path = tokens[i + 1];
      if (path === undefined) break;
      record(lastTouch, path, current);
      i += 2;
    } else {
      i += 1;
    }
  }
  // A loop, not Math.min(...): a spread of a long list can overflow the call stack.
  const counted = truncated ? commitTimes.length - 1 : commitTimes.length;
  let oldest: number | null = null;
  for (let k = 0; k < counted; k += 1) {
    const at = commitTimes[k] as number;
    if (oldest === null || at < oldest) oldest = at;
  }
  return {
    lastTouchMs: lastTouch,
    oldestCommitMs: oldest,
    commits: commitTimes.length,
  };
}

/** The three bounded reads for one configured root. */
export async function readGitHistory(
  root: string,
  spawn: SpawnFn = Bun.spawn,
): Promise<GitHistoryResult> {
  const rp = await runGit(root, REV_PARSE_ARGS, spawn);
  if (rp.code === -1) return { ok: false, reason: "git_failed" };
  const parsed = rp.code === 0 ? parseRevParse(rp.out) : null;
  if (parsed === null) return { ok: false, reason: "not_a_repo" };
  if (parsed.shallow) return { ok: false, reason: "shallow" };

  const ls = await runGit(root, LS_FILES_ARGS, spawn);
  if (ls.code !== 0) return { ok: false, reason: "git_failed" };
  if (ls.truncated) return { ok: false, reason: "too_large" };

  const log = await runGit(root, LOG_ARGS, spawn);
  if (log.code !== 0) return { ok: false, reason: "git_failed" };
  const p = parseLog(log.out, log.truncated);
  return {
    ok: true,
    history: {
      prefix: parsed.prefix,
      tracked: parseLsFiles(ls.out),
      lastTouchMs: p.lastTouchMs,
      oldestCommitMs: p.oldestCommitMs,
      complete: !log.truncated && p.commits < LOG_MAX_COMMITS,
    },
  };
}
