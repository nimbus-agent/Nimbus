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
 * Bounds: one run budget (`LIVENESS_RUN_BUDGET_MS`); a package reached with the budget spent gets no
 * entry (which reads "no checks published for this version") and one log line. Packages are
 * checked in id order. A package whose bytes differ from the index's `packageSha256` gets no entry.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersionsDesc,
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
} from "../../../registry-format/src/index.ts";
import * as gitTree from "./git-tree.ts";
import { type HostProbeDeps, probeHosts, REAL_HOST_PROBE } from "./host-probe.ts";
import { PAGES_BRANCH, PAGES_REF, readVerifiedIndex } from "./registry-state.ts";
import { type ActionIo, GHA_IO } from "./report.ts";
import { assertGateway, budgetLeft, scoreCandidate, writeFileAtomic } from "./score.ts";
import {
  BASELINE_MIN_RUN_MS,
  BASELINE_ROLE_TIMEOUT_MS,
  baselineCandidate,
  baselineRoleRunner,
} from "./score-baseline.ts";
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
  /** Accepted for symmetry with the other modes; the index is read from gh-pages. */
  defaultBranch?: string;
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
  for (const id of Object.keys(index.extensions).sort()) {
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
};

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
  const at = { gateway: opts.gateway, work: c.work, deadline: c.deadline };
  if (budgetLeft(at, deps.now) < BASELINE_MIN_RUN_MS) {
    deps.io.log(`liveness: ${ref} not checked: the run's time budget is spent`);
    return undefined;
  }
  const packageBytes = deps.git.readBlob(PAGES_REF, v.package, { cwd: opts.workspace });
  if (sha256Hex(packageBytes) !== v.packageSha256) {
    deps.io.log(`liveness: ${ref} not checked: its package differs from the index's packageSha256`);
    return undefined;
  }
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
    const hostList = declaredHosts(manifest.permissions.network);
    const hosts = hostList.length === 0 ? undefined : await probeHosts(hostList, deps.probe);
    const cand = { verdict: { id, version, packageSha256: v.packageSha256 }, packageBytes };
    const baselineRun = await baselineCandidate(
      cand,
      {
        gateway: opts.gateway,
        work: c.work,
        timeoutMs: Math.min(BASELINE_ROLE_TIMEOUT_MS, budgetLeft(at, deps.now)),
      },
      deps.runBaseline,
    );
    const baseline = "baseline" in baselineRun ? baselineRun.baseline : undefined;
    if (baseline === undefined && "error" in baselineRun) {
      deps.io.log(`liveness: no baseline for ${ref} (${baselineRun.error.code})`);
    }
    let tests: LivenessEntry["tests"];
    if (hasEvals) tests = await runSuites(c, cand, at);
    const raw = {
      checkedAt,
      ...(hosts !== undefined && hosts.declared > 0 && { hosts }),
      ...(tests !== undefined && { tests }),
      ...(baseline !== undefined && { baseline }),
    };
    try {
      return parseLivenessEntry(raw);
    } catch (e) {
      deps.io.log(
        `liveness: ${ref} has no publishable result: ${clip(e instanceof Error ? e.message : String(e))}`,
      );
      return undefined;
    }
  } finally {
    removeQuietly((p) => rmSync(p, { recursive: true, force: true }), dir);
  }
}

/** The suites within the budget; `undefined` when skipped for budget (not a failure). */
async function runSuites(
  c: Ctx,
  cand: {
    verdict: { id: string; version: string; packageSha256: string };
    packageBytes: Uint8Array;
  },
  at: { gateway: string; work: string; deadline: number },
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
  const r = await scoreCandidate(
    cand,
    { gateway: at.gateway, work: at.work, timeoutMs: Math.min(ROLE_TIMEOUT_MS, left) },
    deps.runRole,
    deps.io.log,
  );
  if ("error" in r) return { failure: testFailure(r.error.code) };
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
  const work = mkdtempSync(join(deps.tmpdir(), "nimbus-registry-liveness-"));
  const extensions = Object.create(null) as Record<string, LivenessEntry>;
  try {
    const ctx: Ctx = { opts, deps, work, deadline, index };
    for (const { id, version } of newestStableVersions(index)) {
      try {
        // NOSONAR S9382: sequential by design - one sandboxed role at a time
        const entry = await checkPackage(ctx, id, version);
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
  const results: LivenessResults = {
    format: LIVENESS_RESULTS_FORMAT,
    nimbusVersion: opts.nimbusVersion,
    extensions,
  };
  writeFileAtomic(opts.out, `${JSON.stringify(results, null, 2)}\n`);
  deps.io.log(`liveness: wrote ${String(Object.keys(extensions).length)} entr(ies)`);
  return results;
}
