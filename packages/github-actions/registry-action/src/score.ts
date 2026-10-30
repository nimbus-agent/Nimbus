/**
 * `mode: score` — runs each new extension version's eval suites (eval spec § 4.6, ruling R8).
 *
 * Extension code is untrusted, so it runs ONLY here: a job with no secrets, no environment and a
 * read-only token, never the job that holds the registry root key. For every unsigned candidate
 * that `sign` would consider (validated exactly as `sign` validates it, `candidates.ts`) whose
 * package holds an eval suite (`PublishVerdict.hasEvals`), the package is unpacked again with the
 * same safe extractor into a directory this mode owns, and the gateway's `__nimbus-eval` role —
 * which confines the extension in the platform sandbox with no network — is run over it.
 *
 * The role's ONE stdout document is validated with registry-format's `parseEvalRoleDocument` and
 * must name the candidate's own `<id>@<version>`. Anything else (a timeout, stdout past 8 MiB, a
 * non-zero exit, garbage) is an error entry, never a partial score. `scores.json` is always
 * written, `{}` when nothing was scored, through a temp sibling and a rename. `sign` reads it as
 * untrusted input bound to each candidate's `packageSha256`.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  type EvalQuality,
  inspectPackage,
  type PublishVerdict,
  parseEvalQuality,
  parseEvalRoleDocument,
  type RegistryExtensionEntry,
  validatePublish,
} from "../../../registry-format/src/index.ts";
import {
  addVersion,
  admitStatements,
  assertSignedIntact,
  extensionDirs,
  type Skipped,
  validateUnsigned,
} from "./candidates.ts";
import * as gitTree from "./git-tree.ts";
import type { ExecFileLike } from "./provenance.ts";
import { CONFIG_FILE, PAGES_BRANCH, readConfigAt, readVerifiedIndex } from "./registry-state.ts";
import { type ActionIo, code, GHA_IO } from "./report.ts";

/** The role's deadline: a whole package's suites, every case, under the sandbox. */
export const ROLE_TIMEOUT_MS = 12 * 60_000;
/** The most stdout the role may print; past it the role is killed and the eval is an error. */
export const ROLE_STDOUT_MAX_BYTES = 8 * 1024 * 1024;
/** How much of the role's stderr is kept (the end of it), for the step log. */
export const ROLE_STDERR_TAIL_BYTES = 64 * 1024;
/** The longest error message an entry carries. */
const MAX_MESSAGE_CHARS = 1000;

/** One run of the role. */
export interface RoleRun {
  /** The exit code; `null` when it did not exit by itself (killed, or never started). */
  code: number | null;
  stdout: string;
  /** The last `ROLE_STDERR_TAIL_BYTES` of stderr (or why the role could not be started). */
  stderrTail: string;
  timedOut: boolean;
  overflow: boolean;
}

/** Runs `<gateway> __nimbus-eval --package <packageDir> --json`. */
export type RunRole = (gateway: string, packageDir: string) => Promise<RoleRun>;

export interface ScoreDeps {
  validate: typeof validatePublish;
  git: typeof gitTree;
  io: ActionIo;
  /** Where the score mode's own work directory goes. */
  tmpdir: () => string;
  runRole: RunRole;
}

export type ScoreError = { code: string; message: string };

/** One `scores.json` entry: a quality, or why there is none. */
export type ScoreEntry =
  | { packageSha256: string; quality: EvalQuality }
  | { packageSha256: string; error: ScoreError };

/** `scores.json`: entries keyed `<id>@<version>`. */
export type ScoresFile = Record<string, ScoreEntry>;

export interface ScoreOptions {
  /** The registry repository's checkout. */
  workspace: string;
  /** The `nimbus-gateway` input: an absolute path to a gateway executable. */
  gateway: string;
  /** Where `scores.json` is written. */
  out: string;
  /** The default branch; asked of `origin` when absent. */
  defaultBranch?: string;
}

/** Keeps the last `max` characters. */
const tail = (s: string, max: number): string => (s.length > max ? s.slice(-max) : s);

/**
 * The default `runRole`: `execFile` with the absolute gateway path and an argv array (no shell,
 * no `PATH` lookup), `windowsHide`, the deadline and the stdout cap. The environment is minimal —
 * `PATH` and a fresh `HOME` under `tmp()` — so nothing from this process (a token, a key) reaches
 * the role, and the role's sandbox directory, which it derives from `HOME`, is private to this run.
 */
export function roleRunner(exec: ExecFileLike = execFile, tmp: () => string = osTmpdir): RunRole {
  return (gateway, packageDir) =>
    new Promise((resolve) => {
      const home = mkdtempSync(join(tmp(), "nimbus-eval-home-"));
      const finish = (r: RoleRun): void => {
        rmSync(home, { recursive: true, force: true });
        resolve(r);
      };
      const env = { PATH: process.env["PATH"] ?? "", HOME: home };
      try {
        exec(
          gateway,
          ["__nimbus-eval", "--package", packageDir, "--json"],
          {
            env,
            timeout: ROLE_TIMEOUT_MS,
            maxBuffer: ROLE_STDOUT_MAX_BYTES,
            windowsHide: true,
          },
          (err, stdout, stderr) => finish(roleRunOf(err, String(stdout), String(stderr))),
        );
      } catch (e) {
        finish({
          code: null,
          stdout: "",
          stderrTail: `could not start the gateway: ${e instanceof Error ? e.message : String(e)}`,
          timedOut: false,
          overflow: false,
        });
      }
    });
}

/** What `execFile`'s callback reports, as a `RoleRun`. */
function roleRunOf(
  err: { code?: unknown; killed?: boolean } | null,
  stdout: string,
  stderr: string,
): RoleRun {
  const stderrTail = tail(stderr, ROLE_STDERR_TAIL_BYTES);
  if (err === null) return { code: 0, stdout, stderrTail, timedOut: false, overflow: false };
  // A maxBuffer overflow also kills the child: test it before reading `killed` as the deadline.
  const overflow = err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
  const timedOut = !overflow && err.killed === true;
  if (typeof err.code === "number") {
    return { code: err.code, stdout, stderrTail, timedOut, overflow };
  }
  const why =
    typeof err.code === "string" && !overflow ? `could not run the gateway: ${err.code}\n` : "";
  return {
    code: null,
    stdout,
    stderrTail: tail(`${stderrTail}${why}`, ROLE_STDERR_TAIL_BYTES),
    timedOut,
    overflow,
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/** A message an entry may carry: flattened and capped. */
const clip = (s: string): string =>
  s.replace(CONTROL_CHARS, " ").trim().slice(0, MAX_MESSAGE_CHARS);

/** The role's own error code when it looks like one; otherwise a fixed one. */
const roleCode = (c: string): string => (/^[A-Z][A-Z0-9_]{0,63}$/.test(c) ? c : "ERR_EVAL_FAILED");

function lastLine(s: string): string {
  return (
    s
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "")
      .at(-1) ?? ""
  );
}

const fail = (code: string, message: string): { error: ScoreError } => ({
  error: { code, message: clip(message) },
});

/** The role's run, judged: a quality for exactly this `<id>@<version>`, or an error. */
export function judgeRoleRun(
  r: RoleRun,
  want: { id: string; version: string },
): { quality: EvalQuality } | { error: ScoreError } {
  if (r.timedOut) {
    return fail(
      "ERR_EVAL_TIMEOUT",
      `the eval did not finish within ${String(ROLE_TIMEOUT_MS / 60_000)} minutes`,
    );
  }
  if (r.overflow) {
    return fail(
      "ERR_EVAL_OUTPUT_TOO_LARGE",
      `the eval role printed more than ${String(ROLE_STDOUT_MAX_BYTES)} bytes`,
    );
  }
  if (r.code !== 0) {
    const last = lastLine(r.stderrTail);
    return fail(
      "ERR_EVAL_ROLE_FAILED",
      `the eval role exited ${r.code === null ? "without an exit code" : String(r.code)}${last === "" ? "" : `: ${last}`}`,
    );
  }
  const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
  const doc = lines.length === 1 ? parseEvalRoleDocument(lines[0] ?? "") : null;
  if (doc === null) {
    return fail(
      "ERR_EVAL_BAD_OUTPUT",
      "the eval role's output is not exactly one valid eval document",
    );
  }
  if (!doc.ok) return fail(roleCode(doc.error.code), doc.error.message);
  if (doc.extensionId !== want.id || doc.version !== want.version) {
    return fail(
      "ERR_EVAL_IDENTITY_MISMATCH",
      `the eval role scored ${doc.extensionId}@${doc.version}, not ${want.id}@${want.version}`,
    );
  }
  const { results: _results, ...quality } = doc.report;
  try {
    return { quality: parseEvalQuality(quality) };
  } catch (e) {
    return fail("ERR_EVAL_BAD_OUTPUT", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Score one validated candidate: unpack its package into a fresh directory under `work` with
 * `inspectPackage` (the role is handed exactly `<dir>/x`, where that puts the files), run the role,
 * judge its output. Never throws: every failure is an error entry. The directory is removed after.
 */
export async function scoreCandidate(
  c: {
    verdict: Pick<PublishVerdict, "id" | "version" | "packageSha256">;
    packageBytes: Uint8Array;
  },
  at: { gateway: string; work: string },
  runRole: RunRole,
  log: (line: string) => void = () => {},
): Promise<ScoreEntry> {
  const { id, version, packageSha256 } = c.verdict;
  const dir = mkdtempSync(join(at.work, "score-"));
  try {
    const tgz = join(dir, "package.tgz");
    writeFileSync(tgz, c.packageBytes, { flag: "wx" });
    await inspectPackage(tgz, dir);
    const r = await runRole(at.gateway, join(dir, "x"));
    logStderr(log, `${id}@${version}`, r.stderrTail);
    return { packageSha256, ...judgeRoleRun(r, { id, version }) };
  } catch (e) {
    return {
      packageSha256,
      ...fail(
        "ERR_EVAL_ROLE_FAILED",
        `the eval could not be run: ${e instanceof Error ? e.message : String(e)}`,
      ),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The role's stderr in the step log, inside a `::stop-commands::` fence: it is the extension's
 * output, and unfenced a line of it could be a workflow command.
 */
function logStderr(log: (line: string) => void, ref: string, stderrTail: string): void {
  if (stderrTail.trim() === "") return;
  const fence = randomUUID().replaceAll("-", "");
  log(`stderr of the eval role for ${ref} (last ${String(ROLE_STDERR_TAIL_BYTES)} bytes):`);
  log(`::stop-commands::${fence}`);
  log(stderrTail);
  log(`::${fence}::`);
}

/** The `nimbus-gateway` input, refused unless it is an absolute path to an existing file. */
function assertGateway(gateway: string): void {
  let ok = false;
  try {
    ok = isAbsolute(gateway) && existsSync(gateway) && statSync(gateway).isFile();
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Error(
      `input "nimbus-gateway" must be an absolute path to an existing file; got ${JSON.stringify(gateway)}`,
    );
  }
}

/**
 * Writes `text` to `path` through a temp sibling (exclusive create) and a rename, so a reader never
 * sees a partial file; a failure removes the temp file.
 */
export function writeFileAtomic(
  path: string,
  text: string,
  fs: {
    writeFileSync: (p: string, data: string, opts: { flag: string }) => void;
    renameSync: (from: string, to: string) => void;
  } = { writeFileSync, renameSync },
): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, text, { flag: "wx" });
    fs.renameSync(temp, path);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

const SHARED: ScoreDeps = {
  validate: validatePublish,
  git: gitTree,
  io: GHA_IO,
  tmpdir: osTmpdir,
  runRole: roleRunner(),
};

interface ScoreRun {
  scores: ScoresFile;
  skipped: Skipped[];
}

/** Validate every unsigned candidate as `sign` does and score each one with an eval suite. */
async function scoreAll(
  opts: ScoreOptions & { defaultBranch: string },
  deps: ScoreDeps,
  work: string,
): Promise<ScoreRun> {
  const { git } = deps;
  const cwd = opts.workspace;
  const mainRef = `origin/${opts.defaultBranch}`;
  git.fetchRefs([opts.defaultBranch, PAGES_BRANCH], { cwd });
  const index = await readVerifiedIndex(git, cwd);
  const config = readConfigAt(git, mainRef, cwd);
  if (config === undefined) {
    throw new Error(`refusing to score: ${opts.defaultBranch} has no ${CONFIG_FILE}`);
  }
  const { dirs, paths } = extensionDirs(git, mainRef, cwd);
  const signedDirs = assertSignedIntact(git, index, mainRef, paths, cwd);
  const skipped: Skipped[] = [];
  const admission = admitStatements(git, index, mainRef, cwd, skipped);
  const extensions: Record<string, RegistryExtensionEntry> = { ...index.extensions };
  const publishedAt = git.commitTime(mainRef, { cwd });
  // Keys are `<id>@<version>` from validated manifests; a null prototype keeps them inert anyway.
  const scores = Object.create(null) as ScoresFile;
  for await (const o of validateUnsigned({
    git,
    validate: deps.validate,
    ref: mainRef,
    cwd,
    dirs,
    signedDirs,
    config: config.config,
    work,
    bindings: () => ({ ...admission.index, extensions }),
  })) {
    if (o.kind === "skipped") {
      skipped.push({ dir: o.dir, reason: o.reason });
      continue;
    }
    const v = o.verdict;
    if (v.hasEvals) {
      // NOSONAR S9382: sequential by design - one sandboxed eval at a time, inside the validation loop
      const entry = await scoreCandidate(
        { verdict: v, packageBytes: o.candidate.packageBytes },
        { gateway: opts.gateway, work },
        deps.runRole,
        deps.io.log,
      );
      scores[`${v.id}@${v.version}`] = entry;
      // `sign` will not sign a version with evals and no score: later candidates must not bind to it.
      if ("error" in entry) continue;
    }
    addVersion(extensions, v, publishedAt);
  }
  return { scores, skipped };
}

function report(io: ActionIo, r: ScoreRun): void {
  const lines = ["## Registry score", ""];
  const entries = Object.entries(r.scores);
  if (entries.length === 0) lines.push("No unsigned version with eval suites to score.");
  for (const [ref, e] of entries) {
    if ("quality" in e) {
      const q = e.quality;
      lines.push(
        `- ${code(ref)}: ${String(q.score)}/100 (${String(q.passed)} of ${String(q.cases)} cases passed)`,
      );
    } else {
      io.annotate(
        "warning",
        `eval of ${ref} failed (${e.error.code}): ${e.error.message}; sign will not sign it`,
      );
      lines.push(`- ${code(ref)}: not scored, ${code(e.error.code)} ${code(e.error.message)}`);
    }
  }
  if (r.skipped.length > 0) {
    lines.push("", "**Not scored** (fails validation; `sign` skips it too):", "");
    for (const s of r.skipped) lines.push(`- ${code(s.dir)}: ${code(s.reason)}`);
  }
  io.summary(lines.join("\n"));
  io.log(`scored ${String(entries.length)} version(s); ${String(r.skipped.length)} not valid`);
}

/** Run the `score` mode: write `opts.out`. Throws (failing the run) on a refusal. */
export async function runScore(opts: ScoreOptions, deps: ScoreDeps = SHARED): Promise<ScoresFile> {
  assertGateway(opts.gateway);
  const defaultBranch = opts.defaultBranch ?? deps.git.remoteDefaultBranch({ cwd: opts.workspace });
  const work = mkdtempSync(join(deps.tmpdir(), "nimbus-registry-score-"));
  let r: ScoreRun;
  try {
    r = await scoreAll({ ...opts, defaultBranch }, deps, work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  writeFileAtomic(opts.out, `${JSON.stringify(r.scores, null, 2)}\n`);
  report(deps.io, r);
  return r.scores;
}
