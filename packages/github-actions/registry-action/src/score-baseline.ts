/**
 * The baseline run: `<gateway> __nimbus-eval --package <dir> --baseline --json` over a package's own
 * extracted files (the role stages and confines it under the unchanged eval sandbox, I49). It starts
 * the package's server, lists its tool definitions and judges them structurally. The result is a
 * displayed fact beside a version, never a score and never a refusal.
 *
 * Like the suite run, the role's ONE stdout document is validated (registry-format's
 * `parseEvalBaselineDocument`) and must name the candidate's own `<id>@<version>`. Anything else (a
 * timeout, stdout past the cap, a non-zero exit — an older gateway exits 2 on the flag it does not
 * know — or garbage) is an `error`: the caller records no baseline, and the error's message, which
 * can carry the role's stderr, goes to a clipped one-line warning and nowhere else.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type EvalBaseline,
  inspectPackage,
  type PublishVerdict,
  parseEvalBaselineDocument,
} from "../../../registry-format/src/index.ts";
import { code } from "./report.ts";
import {
  duration,
  fail,
  type KillProcess,
  lastLine,
  makeRoleRunner,
  type RemoveDir,
  ROLE_STDOUT_MAX_BYTES,
  type RoleRun,
  type RunRole,
  removeDir,
  removeQuietly,
  roleCode,
  type ScoreError,
  type SpawnLike,
} from "./score-role.ts";

/** The baseline role's deadline: two listing attempts of 45 s and their disconnect caps, with room. */
export const BASELINE_ROLE_TIMEOUT_MS = 3 * 60_000;

/**
 * Below this much run budget left, no baseline starts: its two attempts need 2 x 45 s plus 2 x 2 s
 * of disconnect caps, and a role cut off mid-retry would lose a good package's baseline for good.
 */
export const BASELINE_MIN_RUN_MS = 120_000;

/** The default runner for the baseline run: the suite runner's argv plus `--baseline`. */
export function baselineRoleRunner(
  spawnRole?: SpawnLike,
  tmp?: () => string,
  rm?: RemoveDir,
  kill?: KillProcess,
): RunRole {
  return makeRoleRunner(["--baseline"], BASELINE_ROLE_TIMEOUT_MS, spawnRole, tmp, rm, kill);
}

/** The baseline role's run, judged: a baseline for exactly this `<id>@<version>`, or an error. */
export function judgeBaselineRun(
  r: RoleRun,
  want: { id: string; version: string },
  timeoutMs: number = BASELINE_ROLE_TIMEOUT_MS,
): { baseline: EvalBaseline } | { error: ScoreError } {
  if (r.timedOut) {
    return fail(
      "ERR_EVAL_TIMEOUT",
      `the baseline check did not finish within ${duration(timeoutMs)}`,
    );
  }
  if (r.overflow) {
    return fail(
      "ERR_EVAL_OUTPUT_TOO_LARGE",
      `the baseline role printed more than ${String(ROLE_STDOUT_MAX_BYTES)} bytes`,
    );
  }
  if (r.code !== 0) {
    const last = lastLine(r.stderrTail);
    return fail(
      "ERR_EVAL_ROLE_FAILED",
      `the baseline role exited ${r.code === null ? "without an exit code" : String(r.code)}${last === "" ? "" : `: ${last}`}`,
    );
  }
  const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
  const doc = lines.length === 1 ? parseEvalBaselineDocument(lines[0] ?? "") : null;
  if (doc === null) {
    return fail(
      "ERR_EVAL_BAD_OUTPUT",
      "the baseline role's output is not exactly one valid baseline document",
    );
  }
  if (!doc.ok) return fail(roleCode(doc.error.code), doc.error.message);
  if (doc.extensionId !== want.id || doc.version !== want.version) {
    return fail(
      "ERR_EVAL_IDENTITY_MISMATCH",
      `the baseline role checked ${doc.extensionId}@${doc.version}, not ${want.id}@${want.version}`,
    );
  }
  return { baseline: doc.baseline };
}

/**
 * Run the baseline over one candidate: unpack its package into a fresh directory under `work` (the
 * role is handed exactly `<dir>/x`), run the role, judge its output. Never throws: every failure is
 * an `error`. The directory is removed after; a failure to remove it is ignored.
 */
export async function baselineCandidate(
  c: {
    verdict: Pick<PublishVerdict, "id" | "version">;
    packageBytes: Uint8Array;
  },
  at: { gateway: string; work: string; timeoutMs?: number },
  runBaseline: RunRole,
  log: (stderrTail: string) => void = () => {},
  rm: RemoveDir = removeDir,
): Promise<{ baseline: EvalBaseline } | { error: ScoreError }> {
  const { id, version } = c.verdict;
  const dir = mkdtempSync(join(at.work, "baseline-"));
  try {
    const tgz = join(dir, "package.tgz");
    writeFileSync(tgz, c.packageBytes, { flag: "wx" });
    await inspectPackage(tgz, dir);
    const r = await runBaseline(at.gateway, join(dir, "x"), at.timeoutMs);
    log(r.stderrTail);
    return judgeBaselineRun(r, { id, version }, at.timeoutMs);
  } catch (e) {
    return fail(
      "ERR_EVAL_ROLE_FAILED",
      `the baseline check could not be run: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    removeQuietly(rm, dir);
  }
}

/**
 * A baseline stated as fact, for the job summaries: what the check saw, never a verdict. A pass is
 * only that the server started and every tool it listed was structurally valid; a failure is the
 * code from the fixed set. (The number is validated to an integer by `parseEvalBaseline`.)
 */
export function baselineFact(b: EvalBaseline): string {
  if (b.passed)
    return `starts and lists ${String(b.tools)} valid ${b.tools === 1 ? "tool" : "tools"}`;
  return `failed with ${code(b.failure)}`;
}
