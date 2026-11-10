/**
 * `mode: liveness-check` — the keyless half of a registry's liveness producer. For the newest
 * stable version of every published extension it observes three facts and writes them to a results
 * file for `liveness-sign` to sign: did the hosts the manifest declares answer (`host-probe.ts`,
 * credential-free), did the package's own eval suites pass, and the Nimbus baseline (the same two
 * `__nimbus-eval` role runs `score` makes, under the unchanged eval sandbox, I49).
 *
 * It runs extension code, so it holds no secret: `main.ts` refuses `root-key`, `github-token` and
 * `liveness-key`. The results file is untrusted input to the sign job, which re-parses every entry.
 * An entry is validated here with `parseLivenessEntry` before it is written, so this job can never
 * write one that `liveness-sign` would refuse.
 *
 * Bounds: one run budget (`LIVENESS_RUN_BUDGET_MS`) and ONE host allowance (`MAX_HOSTS_PER_RUN`)
 * for the whole run: a package whose distinct hosts do not all fit in what remains gets no `hosts`,
 * never a count cut short. A package reached with the budget spent gets no
 * entry (which reads "no checks published for this version") and one log line. Packages are
 * checked in id order. A package whose bytes differ from the index's `packageSha256` gets no entry.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import {
  codeUnitCompare,
  compareVersionsDesc,
  type EvalBaseline,
  inspectPackage,
  isEvalSuiteFile,
  isStarterPack,
  isValidSemver,
  type LivenessEntry,
  type LivenessTestFailure,
  NIMBUS_VERSION_RE,
  parseExtensionManifestForRegistry,
  parseLivenessEntry,
  parseNetworkEntry,
  type RegistryIndex,
  readRegistryLivenessKey,
} from "../../../registry-format/src/index.ts";
import * as gitTree from "./git-tree.ts";
import {
  createHostAllowance,
  type HostAllowance,
  type HostProbeDeps,
  MAX_HOSTS_PER_RUN,
  probeHosts,
  REAL_HOST_PROBE,
  reserveHosts,
} from "./host-probe.ts";
import { PAGES_BRANCH, PAGES_REF, readVerifiedIndex } from "./registry-state.ts";
import { type ActionIo, GHA_IO } from "./report.ts";
import { assertGateway, budgetLeft, scoreCandidate, writeFileAtomic } from "./score.ts";
import {
  BASELINE_MIN_RUN_MS,
  BASELINE_ROLE_TIMEOUT_MS,
  baselineCandidate,
  baselineRoleRunner,
} from "./score-baseline.ts";
import { packageBytesProblem } from "./score-package.ts";
import {
  clip,
  duration,
  ROLE_TIMEOUT_MS,
  type RunRole,
  removeQuietly,
  roleRunner,
  SCORE_MIN_RUN_MS,
} from "./score-role.ts";

/** The whole run's time budget; the workflow job's own timeout is 60 minutes. */
export const LIVENESS_RUN_BUDGET_MS = 45 * 60_000;
export const LIVENESS_RESULTS_FORMAT = 1;

export type LivenessResults = {
  readonly format: 1;
  readonly nimbusVersion: string;
  /** `<id>@<version>` to entry, as the liveness format defines it. */
  readonly extensions: Readonly<Record<string, LivenessEntry>>;
};

export interface LivenessCheckOptions {
  /** The registry repository's checkout. */
  workspace: string;
  /** The `nimbus-gateway` input: an absolute path to a gateway executable. */
  gateway: string;
  /** The `nimbus-version` input: the release the gateway was downloaded from. */
  nimbusVersion: string;
  /** Where the results file is written. */
  out: string;
}

export interface LivenessCheckDeps {
  git: typeof gitTree;
  io: ActionIo;
  tmpdir: () => string;
  runRole: RunRole;
  runBaseline: RunRole;
  probe: HostProbeDeps;
  /** The clock the run budget and `checkedAt` are measured with, in milliseconds. */
  now: () => number;
}

const SHARED: LivenessCheckDeps = {
  git: gitTree,
  io: GHA_IO,
  tmpdir: osTmpdir,
  runRole: roleRunner(),
  runBaseline: baselineRoleRunner(),
  probe: REAL_HOST_PROBE,
  now: Date.now,
};

const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** The `nimbus-version` input, refused unless it is a release number the format accepts. */
export function assertNimbusVersion(v: string): void {
  if (!NIMBUS_VERSION_RE.test(v)) {
    throw new Error(
      `input "nimbus-version" must be a Nimbus release number such as 10.14.1; got ${JSON.stringify(clip(v))}`,
    );
  }
}

/**
 * The newest stable version of every extension, in id order. A version that is not valid SemVer is
 * skipped, never thrown on; an extension with no stable version is left out.
 */
export function newestStableVersions(
  index: RegistryIndex,
): ReadonlyArray<{ id: string; version: string }> {
  const out: Array<{ id: string; version: string }> = [];
  for (const id of Object.keys(index.extensions).sort(codeUnitCompare)) {
    const versions = index.extensions[id]?.versions ?? {};
    const stable = Object.keys(versions)
      .filter((v) => versions[v]?.channel === "stable" && isValidSemver(v))
      .sort(compareVersionsDesc);
    const [newest] = stable;
    if (newest !== undefined) out.push({ id, version: newest });
  }
  return out;
}

/** Ruling 6: how a failed suite run reads in the entry. */
function testFailure(code: string): LivenessTestFailure {
  if (code === "ERR_EVAL_SANDBOX_UNAVAILABLE") return "sandbox-unavailable";
  if (code === "ERR_EVAL_TIMEOUT") return "run-timeout";
  return "run-failed";
}

/** The declared hosts of a manifest; an entry the parser refuses is skipped, not counted. */
function declaredHosts(network: readonly string[]): Array<{ host: string; port: number }> {
  const hosts: Array<{ host: string; port: number }> = [];
  for (const raw of network) {
    const e = parseNetworkEntry(raw);
    if (e.host !== "" && Number.isInteger(e.port) && e.port >= 1 && e.port <= 65535) hosts.push(e);
  }
  return hosts;
}

type Ctx = {
  opts: LivenessCheckOptions;
  deps: LivenessCheckDeps;
  work: string;
  deadline: number;
  index: RegistryIndex;
  hostAllowance: HostAllowance;
};

type TimeBox = { gateway: string; work: string; deadline: number };
type Candidate = {
  verdict: { id: string; version: string; packageSha256: string };
  packageBytes: Uint8Array;
};

/** The package's bytes, or `undefined` (logged) when they cannot be checked. */
function readCheckedPackage(
  c: Ctx,
  ref: string,
  packagePath: string,
  expectedSha256: string,
): Uint8Array | undefined {
  const { deps, opts } = c;
  const packageBytes = deps.git.readBlob(PAGES_REF, packagePath, { cwd: opts.workspace });
  const problem = packageBytesProblem(packageBytes);
  if (problem !== undefined) {
    deps.io.log(`liveness: ${ref} not checked: its package ${problem}`);
    return undefined;
  }
  if (sha256Hex(packageBytes) !== expectedSha256) {
    deps.io.log(`liveness: ${ref} not checked: its package differs from the index's packageSha256`);
    return undefined;
  }
  return packageBytes;
}

/**
 * The host check, charged to the run-wide allowance. `undefined` (logged where it is a refusal)
 * when there is nothing to probe, the list is over the cap, or the allowance cannot cover all of it.
 */
async function checkHosts(
  c: Ctx,
  ref: string,
  network: readonly string[],
): Promise<{ declared: number; answered: number } | undefined> {
  const r = reserveHosts(declaredHosts(network), c.hostAllowance);
  if (r.kind === "none") return undefined;
  if (r.kind === "too-many") {
    c.deps.io.log(
      `liveness: ${ref}: host check skipped: it declares more than ${String(MAX_HOSTS_PER_RUN)} distinct hosts`,
    );
    return undefined;
  }
  if (r.kind === "spent") {
    c.deps.io.log(`liveness: ${ref}: host check skipped: run host allowance spent`);
    return undefined;
  }
  return probeHosts(r.hosts, c.deps.probe);
}

/** The entry for what was observed, or `undefined` (logged) when the format refuses it. */
function assembleEntry(
  c: Ctx,
  ref: string,
  observed: {
    checkedAt: string;
    hosts: { declared: number; answered: number } | undefined;
    tests: LivenessEntry["tests"];
    baseline: EvalBaseline | undefined;
  },
): LivenessEntry | undefined {
  const { checkedAt, hosts, tests, baseline } = observed;
  const raw = {
    checkedAt,
    ...(hosts !== undefined && hosts.declared > 0 && { hosts }),
    ...(tests !== undefined && { tests }),
    ...(baseline !== undefined && { baseline }),
  };
  try {
    return parseLivenessEntry(raw);
  } catch (e) {
    c.deps.io.log(
      `liveness: ${ref} has no publishable result: ${clip(e instanceof Error ? e.message : String(e))}`,
    );
    return undefined;
  }
}

/** One package's entry, or undefined for no entry. Throws only for what the caller logs. */
async function checkPackage(
  c: Ctx,
  id: string,
  version: string,
): Promise<LivenessEntry | undefined> {
  const { deps, opts } = c;
  const ref = `${id}@${version}`;
  const v = c.index.extensions[id]?.versions[version];
  if (v === undefined) return undefined;
  const at: TimeBox = { gateway: opts.gateway, work: c.work, deadline: c.deadline };
  if (budgetLeft(at, deps.now) < BASELINE_MIN_RUN_MS) {
    deps.io.log(`liveness: ${ref} not checked: the run's time budget is spent`);
    return undefined;
  }
  const packageBytes = readCheckedPackage(c, ref, v.package, v.packageSha256);
  if (packageBytes === undefined) return undefined;
  const checkedAt = new Date(deps.now()).toISOString();
  const dir = mkdtempSync(join(c.work, "pkg-"));
  try {
    const tgz = join(dir, "package.tgz");
    // inspectPackage wants a file; the candidate runners unpack their own copy again.
    writeFileSync(tgz, packageBytes, { flag: "wx" });
    const inspected = await inspectPackage(tgz, dir);
    const { manifest } = parseExtensionManifestForRegistry(
      inspected.manifestBytes.toString("utf8"),
    );
    if (isStarterPack(manifest)) return undefined;
    const hasEvals = inspected.files.some((f) => isEvalSuiteFile(f));
    const hosts = await checkHosts(c, ref, manifest.permissions.network);
    const cand: Candidate = {
      verdict: { id, version, packageSha256: v.packageSha256 },
      packageBytes,
    };
    // The probe spends time too: what the roles may use is read AFTER it.
    let baseline: EvalBaseline | undefined;
    let tests: LivenessEntry["tests"];
    if (budgetLeft(at, deps.now) < BASELINE_MIN_RUN_MS) {
      deps.io.log(`liveness: ${ref}: baseline and suites not run: the time budget is spent`);
    } else {
      baseline = await runBaseline(c, cand, at);
      if (hasEvals) tests = await runSuites(c, cand, at);
    }
    return assembleEntry(c, ref, { checkedAt, hosts, tests, baseline });
  } finally {
    removeQuietly((p) => rmSync(p, { recursive: true, force: true }), dir);
  }
}

/** Never sign a fact the budget caused: a timeout of a run the budget shortened is not recorded. */
const BUDGET_TIMEOUT_NOTE = "budget-shortened run timed out; not recorded";

/** A candidate version being checked: its verdict and the package bytes it was verified from. */
interface RunCandidate {
  verdict: { id: string; version: string; packageSha256: string };
  packageBytes: Uint8Array;
}

/** Where and until when a check may run: the gateway, the work directory and the deadline. */
interface RunWindow {
  gateway: string;
  work: string;
  deadline: number;
}

/** The baseline within the budget, or `undefined` for none (logged). */
async function runBaseline(
  c: Ctx,
  cand: RunCandidate,
  at: RunWindow,
): Promise<EvalBaseline | undefined> {
  const { deps } = c;
  const ref = `${cand.verdict.id}@${cand.verdict.version}`;
  const timeoutMs = Math.min(BASELINE_ROLE_TIMEOUT_MS, budgetLeft(at, deps.now));
  const r = await baselineCandidate(
    cand,
    { gateway: at.gateway, work: at.work, timeoutMs },
    deps.runBaseline,
  );
  if ("baseline" in r) return r.baseline;
  const shortened = timeoutMs < BASELINE_ROLE_TIMEOUT_MS && r.error.code === "ERR_EVAL_TIMEOUT";
  deps.io.log(
    shortened
      ? `liveness: ${ref} baseline: ${BUDGET_TIMEOUT_NOTE}`
      : `liveness: no baseline for ${ref} (${r.error.code})`,
  );
  return undefined;
}

/** The suites within the budget; `undefined` when skipped for budget (not a failure). */
async function runSuites(
  c: Ctx,
  cand: RunCandidate,
  at: RunWindow,
): Promise<LivenessEntry["tests"]> {
  const { deps } = c;
  const left = budgetLeft(at, deps.now);
  const ref = `${cand.verdict.id}@${cand.verdict.version}`;
  if (left < SCORE_MIN_RUN_MS) {
    deps.io.log(
      `liveness: suites of ${ref} not run: under ${duration(SCORE_MIN_RUN_MS)} of the time budget left`,
    );
    return undefined;
  }
  const timeoutMs = Math.min(ROLE_TIMEOUT_MS, left);
  const r = await scoreCandidate(
    cand,
    { gateway: at.gateway, work: at.work, timeoutMs },
    deps.runRole,
    deps.io.log,
  );
  if ("error" in r) {
    if (timeoutMs < ROLE_TIMEOUT_MS && r.error.code === "ERR_EVAL_TIMEOUT") {
      deps.io.log(`liveness: suites of ${ref}: ${BUDGET_TIMEOUT_NOTE}`);
      return undefined;
    }
    return { failure: testFailure(r.error.code) };
  }
  if (r.quality.cases < 1) return undefined;
  return { cases: r.quality.cases, passed: r.quality.passed };
}

/** Run the `liveness-check` mode: write `opts.out`. Throws (failing the run) on a refusal. */
export async function runLivenessCheck(
  opts: LivenessCheckOptions,
  deps: LivenessCheckDeps = SHARED,
): Promise<LivenessResults> {
  assertNimbusVersion(opts.nimbusVersion);
  const deadline = deps.now() + LIVENESS_RUN_BUDGET_MS;
  assertGateway(opts.gateway);
  deps.git.fetchRefs([PAGES_BRANCH], { cwd: opts.workspace });
  const index = await readVerifiedIndex(deps.git, opts.workspace);
  if (readRegistryLivenessKey(index) === undefined) {
    // Nothing could be signed, so run no extension code: liveness-sign refuses on its own.
    deps.io.log(
      "::notice::this registry's index names no liveness key, so no checks were run; run `nimbus registry maintain set-liveness-key`",
    );
    return writeResults(opts, deps, Object.create(null) as Record<string, LivenessEntry>);
  }
  const work = mkdtempSync(join(deps.tmpdir(), "nimbus-registry-liveness-"));
  const extensions = Object.create(null) as Record<string, LivenessEntry>;
  try {
    const ctx: Ctx = { opts, deps, work, deadline, index, hostAllowance: createHostAllowance() };
    for (const { id, version } of newestStableVersions(index)) {
      try {
        // One sandboxed role at a time, by design.
        const entry = await checkPackage(ctx, id, version); // NOSONAR S9382 sequential by design
        if (entry !== undefined) extensions[`${id}@${version}`] = entry;
      } catch (e) {
        deps.io.log(
          `liveness: ${id}@${version} not checked: ${clip(e instanceof Error ? e.message : String(e))}`,
        );
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return writeResults(opts, deps, extensions);
}

function writeResults(
  opts: LivenessCheckOptions,
  deps: LivenessCheckDeps,
  extensions: Record<string, LivenessEntry>,
): LivenessResults {
  const results: LivenessResults = {
    format: LIVENESS_RESULTS_FORMAT,
    nimbusVersion: opts.nimbusVersion,
    extensions,
  };
  writeFileAtomic(opts.out, `${JSON.stringify(results, null, 2)}\n`);
  deps.io.log(`liveness: wrote ${String(Object.keys(extensions).length)} entr(ies)`);
  return results;
}
