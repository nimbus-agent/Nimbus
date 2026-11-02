/**
 * `mode: score` — runs each new extension version's code in the sandbox (eval spec § 4.6, ruling R8).
 *
 * Extension code is untrusted, so it runs ONLY here: a job with no secrets, no environment and a
 * read-only token, never the job that holds the registry root key. Every unsigned candidate that
 * `sign` would consider (validated exactly as `sign` validates it, `candidates.ts`) and that is not
 * a starter pack gets a baseline run: its server is started to list its tools (`score-baseline.ts`).
 * One whose package also holds an eval suite (`PublishVerdict.hasEvals`) then gets a suite run. Each
 * run unpacks the package again with the same safe extractor into a directory this mode owns, and
 * runs the gateway's `__nimbus-eval` role, which confines the extension in the platform sandbox with
 * no network, over it.
 *
 * The role's ONE stdout document is validated with registry-format's validators and must name the
 * candidate's own `<id>@<version>`. For a suite run, anything else (a timeout, stdout past 8 MiB, a
 * non-zero exit, garbage) is an error entry, never a partial score; for a baseline run it is no
 * baseline and a warning. `scores.json` is always written, `{}` when nothing was recorded, through a
 * temp sibling and a rename. `sign` reads it as untrusted input bound to each candidate's
 * `packageSha256`.
 *
 * The whole run has one time budget (`SCORE_RUN_BUDGET_MS`): every role run, baseline or suite, gets
 * its own deadline or what is left of the budget, whichever is shorter. Under two minutes left, no
 * baseline starts; once under a minute is left, every further evals candidate is an
 * `ERR_EVAL_BUDGET` entry without running. Hanging suites,
 * which a publisher can merge on purpose, therefore cannot turn the job red; a red score job would
 * skip the whole sign run, trust requests (takedowns, key revocations) included. The relief is per
 * run only: no state is kept across runs, and `sign` never signs a version whose eval failed, so
 * every sign run scores that version again, spending its budget, until it scores or is removed.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  type EvalBaseline,
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
import { CONFIG_FILE, PAGES_BRANCH, readConfigAt, readVerifiedIndex } from "./registry-state.ts";
import { type ActionIo, code, GHA_IO } from "./report.ts";
import {
  BASELINE_MIN_RUN_MS,
  BASELINE_ROLE_TIMEOUT_MS,
  baselineCandidate,
  baselineFact,
  baselineRoleRunner,
} from "./score-baseline.ts";
import {
  clip,
  duration,
  fail,
  lastLine,
  type RemoveDir,
  ROLE_STDERR_TAIL_BYTES,
  ROLE_STDOUT_MAX_BYTES,
  ROLE_TIMEOUT_MS,
  type RoleRun,
  type RunRole,
  removeDir,
  removeQuietly,
  roleCode,
  roleRunner,
  SCORE_MIN_RUN_MS,
  SCORE_RUN_BUDGET_MS,
  type ScoreError,
} from "./score-role.ts";

export interface ScoreDeps {
  validate: typeof validatePublish;
  git: typeof gitTree;
  io: ActionIo;
  /** Where the score mode's own work directory goes. */
  tmpdir: () => string;
  runRole: RunRole;
  /** Runs the gateway's `__nimbus-eval --baseline` role. */
  runBaseline: RunRole;
  /** The clock the run budget is measured with, in milliseconds. */
  now: () => number;
}

/** One eval-suite result: a quality, or why there is none. */
export type SuiteEntry =
  | { packageSha256: string; quality: EvalQuality }
  | { packageSha256: string; error: ScoreError };

/**
 * One `scores.json` entry: a quality, or why there is none, and/or the baseline check. A version
 * with no eval suite has the baseline alone. The baseline is never inside `quality`.
 */
export type ScoreEntry =
  | { packageSha256: string; quality: EvalQuality; baseline?: EvalBaseline }
  | { packageSha256: string; error: ScoreError; baseline?: EvalBaseline }
  | { packageSha256: string; baseline: EvalBaseline };

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

/** The role's run, judged: a quality for exactly this `<id>@<version>`, or an error. */
export function judgeRoleRun(
  r: RoleRun,
  want: { id: string; version: string },
  timeoutMs: number = ROLE_TIMEOUT_MS,
): { quality: EvalQuality } | { error: ScoreError } {
  if (r.timedOut) {
    // A deadline under the role's own cap was set by the score run's remaining budget: say so,
    // so a maintainer does not blame a suite that earlier, hanging versions starved of time.
    const why =
      timeoutMs < ROLE_TIMEOUT_MS
        ? ` (the score job's remaining time budget; the cap is ${duration(ROLE_TIMEOUT_MS)})`
        : "";
    return fail("ERR_EVAL_TIMEOUT", `the eval did not finish within ${duration(timeoutMs)}${why}`);
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
 * judge its output. Never throws: every failure is an error entry. The directory is removed after
 * (a failure to remove it is ignored, never thrown).
 */
export async function scoreCandidate(
  c: {
    verdict: Pick<PublishVerdict, "id" | "version" | "packageSha256">;
    packageBytes: Uint8Array;
  },
  at: { gateway: string; work: string; timeoutMs?: number },
  runRole: RunRole,
  log: (line: string) => void = () => {},
  rm: RemoveDir = removeDir,
): Promise<SuiteEntry> {
  const { id, version, packageSha256 } = c.verdict;
  const dir = mkdtempSync(join(at.work, "score-"));
  try {
    const tgz = join(dir, "package.tgz");
    writeFileSync(tgz, c.packageBytes, { flag: "wx" });
    await inspectPackage(tgz, dir);
    const r = await runRole(at.gateway, join(dir, "x"), at.timeoutMs);
    logStderr(log, `${id}@${version}`, r.stderrTail);
    return { packageSha256, ...judgeRoleRun(r, { id, version }, at.timeoutMs) };
  } catch (e) {
    return {
      packageSha256,
      ...fail(
        "ERR_EVAL_ROLE_FAILED",
        `the eval could not be run: ${e instanceof Error ? e.message : String(e)}`,
      ),
    };
  } finally {
    removeQuietly(rm, dir);
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
export function assertGateway(gateway: string): void {
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
  runBaseline: baselineRoleRunner(),
  now: Date.now,
};

/** Which mode is scoring: what a message may say about signing depends on it. */
export type ScoreMode = "score" | "check" | "score-package";

export interface ScoreRun {
  scores: ScoresFile;
  skipped: Skipped[];
  /** Versions with no baseline, by `<id>@<version>`: the code that says why. */
  noBaseline: Map<string, string>;
  /** Versions that are starter packs: they never run, so nothing is recorded. */
  starterPacks: string[];
}

/** Says what the summary must say when a version's result reads `no-listing`. */
const NO_LISTING_NOTICE: Record<Exclude<ScoreMode, "check">, string> = {
  score:
    "A `no-listing` baseline can also mean that no sandboxed child could start on this runner. Check the job's sandbox setup before trusting it: the result is signed into the version.",
  "score-package":
    "A `no-listing` baseline can also mean that no sandboxed child could start on this runner. Check the job's sandbox setup before trusting it: `maintain add` signs the result into the version.",
};

/** What happens to a version with no baseline, by mode. */
const NO_BASELINE_TAIL: Record<ScoreMode, string> = {
  score: "it is signed without a baseline",
  check: "nothing is signed in this mode",
  "score-package": "scores.json holds no baseline for it",
};

/** What happens to a version whose baseline failed, by mode. */
const FAILED_BASELINE_TAIL: Record<ScoreMode, string> = {
  score: "the version is still signed",
  check: "nothing is signed in this mode",
  "score-package": "the result is recorded in scores.json",
};

/** Why `maintain add` will not take a package whose eval failed: `score-package`'s remedy. */
const MAINTAIN_ADD_REMEDY =
  "`maintain add` refuses a package with eval suites until its entry in scores.json holds a score.";

/** When an unscored version is tried again: no state is kept across runs. */
const RETRY_NOTE =
  "it is scored again on the next sign run (a push to the default branch or a workflow_dispatch)";

/**
 * Why a failed version keeps coming back: `sign` never signs it, so it stays unsigned on the default
 * branch, and every sign run scores it again and spends budget on it until it scores or is removed.
 */
const FAILED_REMEDY =
  "A version whose eval failed is not signed, so it is scored again on every sign run (a push to the default branch or a workflow_dispatch) until it scores or its directory is removed from the default branch; meanwhile each attempt spends time budget that later versions need.";

/** The entry of an evals candidate the run had no budget left for. */
const budgetSpent = (packageSha256: string, mode: ScoreMode): SuiteEntry => ({
  packageSha256,
  ...fail(
    "ERR_EVAL_BUDGET",
    mode === "score"
      ? `not scored this run: earlier evals spent the score job's time budget; ${RETRY_NOTE}`
      : "not scored: the run's time budget was spent",
  ),
});

/** What `scoreVersion` needs of the candidate: the verdict's facts and the package bytes. */
type VersionCandidate = {
  verdict: Pick<PublishVerdict, "id" | "version" | "packageSha256" | "hasEvals" | "starterPack">;
  packageBytes: Uint8Array;
};

/**
 * Where and until when a version is scored; no `deadline` means no run budget (`check`). `mode` sets
 * what the warnings say about signing, and is `score` when absent.
 */
type VersionAt = { gateway: string; work: string; deadline?: number; mode?: ScoreMode };

/** What `scoreVersion` runs with. `noBaseline` hears the code when a version gets no baseline. */
type VersionDeps = Pick<ScoreDeps, "runRole" | "runBaseline" | "now" | "io"> & {
  noBaseline?: (code: string) => void;
};

/** The run budget left, in milliseconds; unbounded without a deadline. */
const budgetLeft = (at: VersionAt, now: () => number): number =>
  at.deadline === undefined ? Number.POSITIVE_INFINITY : at.deadline - now();

/**
 * Run the baseline for one version within the budget. A baseline that could not be obtained (the
 * budget, a refusing sandbox, a gateway older than the flag) is one clipped warning and `undefined`,
 * and `noBaseline` hears why. A baseline that failed is returned and warned about too. The role's
 * own error text reaches the warning only, never `scores.json`.
 */
async function baselineWithinBudget(
  c: VersionCandidate,
  at: VersionAt,
  deps: VersionDeps,
): Promise<EvalBaseline | undefined> {
  const ref = `${c.verdict.id}@${c.verdict.version}`;
  const mode = at.mode ?? "score";
  const left = budgetLeft(at, deps.now);
  if (left < BASELINE_MIN_RUN_MS) {
    deps.io.annotate(
      "warning",
      `baseline check of ${ref} not run: under ${duration(BASELINE_MIN_RUN_MS)} of the score job's time budget left; ${NO_BASELINE_TAIL[mode]}`,
    );
    deps.noBaseline?.("ERR_EVAL_BUDGET");
    return undefined;
  }
  const r = await baselineCandidate(
    c,
    { gateway: at.gateway, work: at.work, timeoutMs: Math.min(BASELINE_ROLE_TIMEOUT_MS, left) },
    deps.runBaseline,
    (stderrTail) => logStderr(deps.io.log, `${ref} (baseline)`, stderrTail),
  );
  if ("error" in r) {
    deps.io.annotate(
      "warning",
      clip(
        `no baseline check for ${ref} (${r.error.code}): ${r.error.message}; ${NO_BASELINE_TAIL[mode]}`,
      ),
    );
    deps.noBaseline?.(r.error.code);
    return undefined;
  }
  if (!r.baseline.passed) {
    deps.io.annotate(
      "warning",
      clip(`baseline check of ${ref} failed: ${r.baseline.failure}; ${FAILED_BASELINE_TAIL[mode]}`),
    );
  }
  return r.baseline;
}

/**
 * Score one candidate's suites within the run's budget: the role gets its own deadline or what is
 * left, whichever is shorter; with under `SCORE_MIN_RUN_MS` left it does not run at all.
 */
function suiteWithinBudget(
  c: VersionCandidate,
  at: VersionAt,
  deps: VersionDeps,
): Promise<SuiteEntry> {
  const left = budgetLeft(at, deps.now);
  if (left < SCORE_MIN_RUN_MS) {
    return Promise.resolve(budgetSpent(c.verdict.packageSha256, at.mode ?? "score"));
  }
  return scoreCandidate(
    c,
    {
      gateway: at.gateway,
      work: at.work,
      ...(at.deadline !== undefined && { timeoutMs: Math.min(ROLE_TIMEOUT_MS, left) }),
    },
    deps.runRole,
    deps.io.log,
  );
}

/**
 * Everything the score job records for one validated version, in order: nothing for a starter pack
 * (it never runs); otherwise the baseline first, then the suite when the package has one. Returns
 * `undefined` when there is nothing to record (a starter pack, or a package without a suite whose
 * baseline was not obtained). Every role run spends the same budget. Never throws.
 */
export async function scoreVersion(
  c: VersionCandidate,
  at: VersionAt,
  deps: VersionDeps,
): Promise<ScoreEntry | undefined> {
  const { verdict } = c;
  if (verdict.starterPack) return undefined;
  const baseline = await baselineWithinBudget(c, at, deps);
  if (!verdict.hasEvals) {
    return baseline === undefined ? undefined : { packageSha256: verdict.packageSha256, baseline };
  }
  const suite = await suiteWithinBudget(c, at, deps);
  return baseline === undefined ? suite : { ...suite, baseline };
}

/** Score one version into `run`: its entry if any, and why it has no baseline or no entry. */
export async function recordVersion(
  run: ScoreRun,
  c: VersionCandidate,
  at: VersionAt,
  deps: VersionDeps,
): Promise<ScoreEntry | undefined> {
  const ref = `${c.verdict.id}@${c.verdict.version}`;
  if (c.verdict.starterPack) run.starterPacks.push(ref);
  const entry = await scoreVersion(c, at, {
    ...deps,
    noBaseline: (why) => run.noBaseline.set(ref, why),
  });
  if (entry !== undefined) run.scores[ref] = entry;
  return entry;
}

/** A run with nothing in it yet. Keys are `<id>@<version>`: a null prototype keeps them inert. */
export const emptyRun = (): ScoreRun => ({
  scores: Object.create(null) as ScoresFile,
  skipped: [],
  noBaseline: new Map(),
  starterPacks: [],
});

/** Validate every unsigned candidate as `sign` does and record what each one gets. */
async function scoreAll(
  opts: ScoreOptions & { defaultBranch: string },
  deps: ScoreDeps,
  work: string,
  deadline: number,
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
  const signedDirs = assertSignedIntact(git, index, mainRef, paths, cwd, "score");
  const run = emptyRun();
  const admission = admitStatements(git, index, mainRef, cwd, run.skipped);
  const extensions: Record<string, RegistryExtensionEntry> = { ...index.extensions };
  const publishedAt = git.commitTime(mainRef, { cwd });
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
      run.skipped.push({ dir: o.dir, reason: o.reason });
      continue;
    }
    const v = o.verdict;
    // NOSONAR S9382: sequential by design - one sandboxed role at a time, inside the validation loop
    const entry = await recordVersion(
      run,
      { verdict: v, packageBytes: o.candidate.packageBytes },
      { gateway: opts.gateway, work, deadline },
      deps,
    );
    // `sign` will not sign a version with evals and no score: later candidates must not bind to it.
    if (entry !== undefined && "error" in entry) continue;
    addVersion(extensions, v, publishedAt);
  }
  return run;
}

/** The line for a version's eval suite result; the version's baseline, when it has one, follows. */
function suiteText(e: ScoreEntry): string | undefined {
  if ("quality" in e) {
    const q = e.quality;
    return `${String(q.score)}/100 (${String(q.passed)} of ${String(q.cases)} cases passed)`;
  }
  if ("error" in e) return `not scored, ${code(e.error.code)} ${code(e.error.message)}`;
  return undefined;
}

/** The line for a version's baseline: the fact, or why it has none; nothing for no attempt. */
function baselineText(e: ScoreEntry, why: string | undefined): string | undefined {
  if (e.baseline !== undefined) return `baseline: ${baselineFact(e.baseline)}`;
  return why === undefined ? undefined : `no baseline check (${code(why)})`;
}

/** The versions that ended with no entry, each with why. */
function noEntryLines(r: ScoreRun): string[] {
  const lines: string[] = [];
  for (const ref of r.starterPacks) {
    lines.push(`- ${code(ref)}: a starter pack never runs, so nothing is recorded`);
  }
  for (const [ref, why] of r.noBaseline) {
    if (r.scores[ref] === undefined) lines.push(`- ${code(ref)}: no baseline check (${code(why)})`);
  }
  return lines;
}

const remedyFor = (mode: Exclude<ScoreMode, "check">): string =>
  mode === "score" ? FAILED_REMEDY : MAINTAIN_ADD_REMEDY;

const isNoListing = (e: ScoreEntry): boolean =>
  e.baseline?.passed === false && e.baseline.failure === "no-listing";

/** One summary line per entry, appended to `lines`; annotates each failed eval. Returns their refs. */
function entryLines(
  io: ActionIo,
  r: ScoreRun,
  mode: Exclude<ScoreMode, "check">,
  lines: string[],
): string[] {
  const consequence = mode === "score" ? "sign will not sign it" : "there is no score to publish";
  const failed: string[] = [];
  for (const [ref, e] of Object.entries(r.scores)) {
    if ("error" in e) {
      io.annotate(
        "warning",
        `eval of ${ref} failed (${e.error.code}): ${e.error.message}; ${consequence}. ${remedyFor(mode)}`,
      );
      failed.push(ref);
    }
    const parts = [suiteText(e), baselineText(e, r.noBaseline.get(ref))];
    lines.push(`- ${code(ref)}: ${parts.filter((p) => p !== undefined).join("; ")}`);
  }
  return failed;
}

/** The versions with a failed eval, listed apart, with the remedy; nothing when there are none. */
function failedLines(failed: readonly string[], mode: Exclude<ScoreMode, "check">): string[] {
  if (failed.length === 0) return [];
  const heading = mode === "score" ? "**Not signed** (no score):" : "**No score:**";
  return ["", heading, "", ...failed.map((ref) => `- ${code(ref)}`), "", remedyFor(mode)];
}

/**
 * The job summary of a score run. A version with a failed eval is listed apart; a baseline is a
 * stated fact (`baselineFact`) beside the version and never a reason to list it there. Every
 * version seen is named, with or without an entry. `score-package` has no sign run and no default
 * branch, so its wording names neither.
 */
export function reportScores(
  io: ActionIo,
  r: ScoreRun,
  mode: Exclude<ScoreMode, "check"> = "score",
): void {
  const lines = ["## Registry score", ""];
  const entries = Object.entries(r.scores);
  const noEntry = noEntryLines(r);
  if (entries.length === 0 && noEntry.length === 0 && r.skipped.length === 0) {
    lines.push("No unsigned version to score.");
  }
  const failed = entryLines(io, r, mode, lines);
  if (noEntry.length > 0) lines.push("", "**No entry recorded:**", "", ...noEntry);
  lines.push(...failedLines(failed, mode));
  if (entries.some(([, e]) => isNoListing(e))) lines.push("", NO_LISTING_NOTICE[mode]);
  if (r.skipped.length > 0) {
    lines.push("", "**Not scored** (fails validation; `sign` skips it too):", "");
    for (const s of r.skipped) lines.push(`- ${code(s.dir)}: ${code(s.reason)}`);
  }
  io.summary(lines.join("\n"));
  io.log(`scored ${String(entries.length)} version(s); ${String(r.skipped.length)} not valid`);
}

/** Run the `score` mode: write `opts.out`. Throws (failing the run) on a refusal. */
export async function runScore(opts: ScoreOptions, deps: ScoreDeps = SHARED): Promise<ScoresFile> {
  const deadline = deps.now() + SCORE_RUN_BUDGET_MS;
  assertGateway(opts.gateway);
  const defaultBranch = opts.defaultBranch ?? deps.git.remoteDefaultBranch({ cwd: opts.workspace });
  const work = mkdtempSync(join(deps.tmpdir(), "nimbus-registry-score-"));
  let r: ScoreRun;
  try {
    r = await scoreAll({ ...opts, defaultBranch }, deps, work, deadline);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  writeFileAtomic(opts.out, `${JSON.stringify(r.scores, null, 2)}\n`);
  reportScores(deps.io, r);
  return r.scores;
}
