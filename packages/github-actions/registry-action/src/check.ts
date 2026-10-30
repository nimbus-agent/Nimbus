/**
 * `mode: check` — the reviewer aid run on a registry pull request (design § 7.4). It is NOT the
 * security boundary: a pull request can edit this workflow itself, so a green check proves only
 * that the files it read pass. The boundary is `sign` and its required approval.
 *
 * Order: the signed `gh-pages` index is verified against its own root key first (the validator
 * trusts the index it is handed); then the path rule over the pull request's diff from the merge
 * base; then the publisher statements the pull request adds, through the same admission `sign`
 * runs (any statement it would skip fails the check); then `validatePublish` over the committed
 * bytes against the index with those statements admitted; then the reviewer's job summary.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import {
  admitPublisherStatements,
  assertRequestSignable,
  codeUnitCompare,
  effectiveRegistryConfig,
  type PublishVerdict,
  publisherKeyFingerprint,
  type RegistryConfig,
  type RegistryIndex,
  type TrustStatement,
  trustStatementId,
  validatePublish,
} from "../../../registry-format/src/index.ts";
import * as gitTree from "./git-tree.ts";
import {
  ghProvenance,
  type ProvenanceResult,
  type VerifyPackage,
  verifyNeverThrowing,
} from "./provenance.ts";
import {
  CANDIDATE_FILES,
  PAGES_BRANCH,
  PAGES_REF,
  REQUESTS_DIR,
  type RequestFile,
  readCandidate,
  readConfigAt,
  readRequestFiles,
  readStatementFiles,
  readVerifiedIndex,
  splitExtensionDir,
  statementPath,
} from "./registry-state.ts";
import { type ActionIo, code, GHA_IO } from "./report.ts";
import {
  assertGateway,
  type RunRole,
  roleRunner,
  type ScoreEntry,
  scoreCandidate,
} from "./score.ts";

/** Inputs `check` needs. */
export interface CheckOptions {
  /** The registry repository's checkout, with the pull request at `HEAD`. */
  workspace: string;
  /** The pull request's base branch (`GITHUB_BASE_REF`). */
  baseRef: string;
  /** The `github-token` input: what `gh attestation verify` fetches attestations with. */
  githubToken?: string;
  /**
   * The `nimbus-gateway` input: an absolute path to a gateway executable. When set, a publish
   * whose package holds eval suites is scored as the score job will score it; absent, nothing is.
   * It runs extension code, so it excludes `githubToken` (R8) and provenance is not verified here.
   */
  gateway?: string;
}

/** What `check` reads the registry with, judges it by and reports to; injectable for tests. */
export interface CheckDeps {
  validate: typeof validatePublish;
  git: typeof gitTree;
  io: ActionIo;
  /** Where the validator's scratch directory goes. */
  tmpdir: () => string;
  /** Verifies the version's build provenance for the summary; the default runs `gh`. */
  provenance?: VerifyPackage;
  /** Runs the gateway's `__nimbus-eval` role; the default is score mode's `roleRunner()`. */
  runRole?: RunRole;
}

const SHARED: CheckDeps = { validate: validatePublish, git: gitTree, io: GHA_IO, tmpdir: osTmpdir };

const CANDIDATE_ALTERNATION = CANDIDATE_FILES.join("|").replaceAll(".", String.raw`\.`);
const FILE_RE = new RegExp(`^(extensions/.+)/(${CANDIDATE_ALTERNATION})$`);
const STATEMENT_RE = /^statements\/[0-9a-f]{64}\.json$/;

/** What a pull request adds: at most one version directory, and any statement files. */
interface PullRequestShape {
  dir: { id: string; version: string } | undefined;
  statements: Set<string>;
}

/**
 * The path rule: the diff only ADDS the three files of at most one new
 * `extensions/<id>/<version>/`, plus any `statements/<statement id>.json` files (a statement-only
 * pull request — a revocation, say — is valid). Anything else — a deletion or edit anywhere, a
 * workflow, `nimbus-registry.json`, `index.json`, another extension's files, a second version —
 * refuses.
 */
function assertPublishShape(changes: readonly gitTree.TreeChange[]): PullRequestShape {
  if (changes.length === 0) throw new Error("the pull request changes no files");
  const offending: string[] = [];
  const dirs = new Set<string>();
  const statements = new Set<string>();
  let dirFiles = 0;
  for (const c of changes) {
    const m = FILE_RE.exec(c.path);
    if (c.status === "A" && STATEMENT_RE.test(c.path)) {
      statements.add(c.path);
    } else if (c.status !== "A" || m?.[1] === undefined) {
      offending.push(`${c.status} ${c.path}`);
    } else {
      dirs.add(m[1]);
      dirFiles++;
    }
  }
  if (offending.length > 0) {
    throw new Error(
      "a publish pull request may only add manifest.json, package.tgz and publish-request.json " +
        "under one extensions/<id>/<version>/, and statements/<statement id>.json files; " +
        `it also changes: ${offending.join(", ")}`,
    );
  }
  if (dirs.size > 1) {
    throw new Error(
      `a publish pull request adds exactly one extensions/<id>/<version>/; this one adds ${[...dirs].sort(codeUnitCompare).join(", ")}`,
    );
  }
  const [dir] = dirs;
  if (dir === undefined) return { dir: undefined, statements };
  const coords = splitExtensionDir(dir);
  if (coords === undefined || dirFiles !== CANDIDATE_FILES.length) {
    throw new Error(`${dir}/ must add all of ${CANDIDATE_FILES.join(", ")}`);
  }
  return { dir: coords, statements };
}

/**
 * The pull request's statement files admitted into `index` exactly as `sign` would admit them. The
 * base branch's statement files go in first, as `sign` will see them merged there (one already in
 * the index is a no-op; one `sign` would skip is ignored here — it is not this pull request's). A
 * file of THIS pull request that `sign` would skip fails the check: the reviewer aid should be loud.
 */
function admitPullRequestStatements(
  git: typeof gitTree,
  signed: RegistryIndex,
  baseRef: string,
  added: ReadonlySet<string>,
  cwd: string,
): { index: RegistryIndex; admitted: TrustStatement[] } {
  const index = admitPublisherStatements(
    signed,
    readStatementFiles(git, `origin/${baseRef}`, cwd).values,
  ).index;
  if (added.size === 0) return { index, admitted: [] };
  const files = readStatementFiles(git, "HEAD", cwd, added);
  const admission = admitPublisherStatements(index, files.values);
  const problems = [
    ...files.skipped.map((f) => `${f.path} ${f.reason}`),
    ...admission.skipped.map((x) => `${statementPath(x.id)}: ${x.reason}`),
  ];
  if (problems.length > 0) {
    throw new Error(`the registry would not admit these statements: ${problems.join("; ")}`);
  }
  return { index: admission.index, admitted: admission.admitted };
}

/** The rules the sign job will apply (`effectiveRegistryConfig`): the stricter of the two copies. */
function effectiveConfig(git: typeof gitTree, baseRef: string, cwd: string): RegistryConfig {
  return effectiveRegistryConfig(
    readConfigAt(git, PAGES_REF, cwd)?.config,
    readConfigAt(git, `origin/${baseRef}`, cwd)?.config,
  );
}

const listOf = (items: readonly string[]): string =>
  items.length === 0 ? "none" : items.map(code).join(", ");

/** What a statement concerns, for the reviewer: the fingerprints, and a revocation's reason. */
function statementSubject(s: TrustStatement): string {
  if (s.kind === "key.rotate") {
    return `${code(publisherKeyFingerprint(s.fromKey))} -> ${code(publisherKeyFingerprint(s.toKey))}`;
  }
  if (s.kind === "key.revoke") return `key ${code(s.keyFingerprint)}, reason ${code(s.reason)}`;
  return "";
}

/** One reviewer line per admitted statement: kind, publisher and the fingerprints it concerns. */
function statementLines(admitted: readonly TrustStatement[]): string[] {
  if (admitted.length === 0) return [];
  const lines = ["**Publisher statements**", ""];
  for (const s of admitted) {
    lines.push(
      `- ${code(s.kind)} for ${code(s.publisherId)}: ${statementSubject(s)} (${code(trustStatementId(s))})`,
    );
  }
  lines.push("");
  return lines;
}

/** The reviewer's job summary for a statement-only pull request. */
function statementOnlySummary(admitted: readonly TrustStatement[]): string {
  return ["## Registry statements", "", ...statementLines(admitted)].join("\n");
}

/**
 * What the check learned of the version's provenance: a result, `"deferred"` when this check
 * scores (it holds no token, so the sign job verifies it), or `undefined` without a repository.
 */
type CheckedProvenance = ProvenanceResult | "deferred" | undefined;

/** The summary line for the version's build provenance; informational, never a failure. */
function provenanceLine(v: PublishVerdict, r: CheckedProvenance): string {
  if (v.repositoryIgnored === true) {
    return "- **Provenance:** none (the manifest's `repository` is not `owner/repo`, so it is ignored)";
  }
  if (v.repository === undefined) {
    return "- **Provenance:** none (the manifest declares no `repository`)";
  }
  if (r === "deferred") {
    return `- **Provenance:** not verified here (this check runs extension code and holds no token); the sign job verifies ${code(v.repository)} when it signs`;
  }
  if (!r?.ok) {
    return `- **Provenance:** none for ${code(v.repository)} — ${code(r?.reason ?? "not checked")} (the version is signed without it)`;
  }
  const p = r.provenance;
  return `- **Provenance:** built from ${code(p.sourceRepository)} at ${code(p.commit.slice(0, 12))} by ${code(p.workflow)} (${p.runner})`;
}

/** The longest eval error message the summary repeats. */
const MAX_SUMMARY_MESSAGE_CHARS = 300;

/** The summary line for the eval score this check measured. */
function qualityLine(e: ScoreEntry): string {
  if ("quality" in e) {
    const q = e.quality;
    return `- **Quality:** quality ${String(q.score)}/100 (${String(q.passed)} of ${String(q.cases)} cases passed)`;
  }
  const message = e.error.message.slice(0, MAX_SUMMARY_MESSAGE_CHARS);
  return `- **Quality:** could not score: ${code(e.error.code)} ${code(message)} (a sign job given scores will not sign this version without one)`;
}

/** The closing sentence: what this check did and did not run. */
function runtimeSentence(scored: boolean): string {
  if (scored) {
    return (
      "The package's eval suites were run in the platform sandbox, offline and without " +
      "credentials; nothing else about what the code does was checked."
    );
  }
  return (
    "No runtime check of the package is performed: this check validated the signature, the " +
    "registry rules and the package's file set, not what the code does."
  );
}

/** The reviewer's job summary for an accepted publish. */
function checkSummary(
  v: PublishVerdict,
  admitted: readonly TrustStatement[] = [],
  provenance?: CheckedProvenance,
  score?: ScoreEntry,
): string {
  const ref = `${v.id}@${v.version}`;
  const lines = [`## Registry publish: ${code(ref)}`, ""];
  if (v.newId) {
    lines.push(
      `> [!WARNING]`,
      `> **NEW ID** — ${code(v.id)} is not in the signed index yet. Check the publisher and the name before approving.`,
      "",
    );
  }
  lines.push(
    `- **Extension:** ${code(v.id)}`,
    `- **Version:** ${code(v.version)}`,
    `- **Channel:** ${code(v.channel)}`,
    `- **Name:** ${code(v.name)}`,
    `- **Publisher:** ${code(v.publisher.id)}, key fingerprint ${code(publisherKeyFingerprint(v.publisher.key))}`,
    `- **Package:** ${String(v.packageSizeBytes)} bytes, sha256 ${code(v.packageSha256)}`,
    provenanceLine(v, provenance),
    ...(score === undefined ? [] : [qualityLine(score)]),
    "",
    ...statementLines(admitted),
    "**Declared permissions**",
    "",
    `- Network hosts: ${listOf(v.permissions.network)}`,
    `- Filesystem read: ${listOf(v.permissions.filesystem.read)}`,
    `- Filesystem write: ${listOf(v.permissions.filesystem.write)}`,
    "",
    runtimeSentence(score !== undefined),
  );
  return lines.join("\n");
}

/** One reviewer line per maintainer request: what it blocks, for whom. */
function requestLine(f: RequestFile): string {
  const r = f.request;
  if (r.kind === "key.revoke") {
    return `- ${code(f.path)}: revoke publisher ${code(r.publisherId)}'s key ${code(r.keyFingerprint)} — ${code(r.reason)}`;
  }
  const versions = r.versions === "*" ? "every version" : r.versions.map(code).join(", ");
  const publisher = r.publisherId === undefined ? "" : ` (publisher ${code(r.publisherId)})`;
  return `- ${code(f.path)}: take down ${code(r.extensionId)}${publisher}, ${versions} — ${code(r.reason)}`;
}

/**
 * A maintainer-request pull request: it may only ADD `trust-requests/<name>.json` files, each a valid
 * request. Anyone can propose one, as anyone can propose a publish; merging it and approving the
 * signing run are the maintainers' decision, so the summary says so loudly.
 */
function checkRequestPullRequest(
  git: typeof gitTree,
  index: RegistryIndex,
  changes: readonly gitTree.TreeChange[],
  cwd: string,
  io: ActionIo,
): void {
  const offending = changes.filter((c) => c.status !== "A" || !c.path.startsWith(REQUESTS_DIR));
  if (offending.length > 0) {
    throw new Error(
      `a maintainer request pull request may only add ${REQUESTS_DIR}<name>.json files; it also changes: ${offending.map((c) => `${c.status} ${c.path}`).join(", ")}`,
    );
  }
  const files = readRequestFiles(git, "HEAD", cwd, new Set(changes.map((c) => c.path)));
  // The sign job's own rule: a request that passes review must be signable (it can never be removed).
  for (const f of files.requests) {
    try {
      assertRequestSignable(f.request, index);
    } catch (e) {
      files.skipped.push({ path: f.path, reason: (e as Error).message });
    }
  }
  if (files.skipped.length > 0) {
    throw new Error(
      `invalid maintainer request: ${files.skipped.map((f) => `${f.path} ${f.reason}`).join("; ")}`,
    );
  }
  io.summary(
    [
      "## Registry maintainer request",
      "",
      "> [!CAUTION]",
      "> **MAINTAINER REQUEST — merge only if you, a maintainer of this registry, intend this block.** On merge the sign job signs it with the registry root key, and every client that installed from this registry applies it.",
      "",
      ...files.requests.map(requestLine),
    ].join("\n"),
  );
  io.log(`check passed: ${String(files.requests.length)} maintainer request(s)`);
}

/** What `sign` would record for this version, for the reviewer; `undefined` without a repository. */
async function checkProvenance(
  v: PublishVerdict,
  packageBytes: Uint8Array,
  work: string,
  opts: CheckOptions,
  deps: CheckDeps,
): Promise<CheckedProvenance> {
  if (v.repository === undefined) return undefined;
  if (opts.gateway !== undefined) return "deferred";
  return verifyNeverThrowing(deps.provenance ?? ghProvenance(opts.githubToken ?? ""), {
    pkgPath: join(work, "provenance-check.tgz"),
    packageBytes,
    repository: v.repository,
    verifiedAt: new Date().toISOString(),
  });
}

/**
 * The version's eval score, measured as the score job will measure it, when the `nimbus-gateway`
 * input is set and the package holds an eval suite; `undefined` otherwise. Never throws.
 */
async function checkScore(
  v: PublishVerdict,
  packageBytes: Uint8Array,
  work: string,
  opts: CheckOptions,
  deps: CheckDeps,
): Promise<ScoreEntry | undefined> {
  if (opts.gateway === undefined || !v.hasEvals) return undefined;
  return scoreCandidate(
    { verdict: v, packageBytes },
    { gateway: opts.gateway, work },
    deps.runRole ?? roleRunner(),
    deps.io.log,
  );
}

/** Run the `check` mode. Throws (failing the step) on any refusal. */
export async function runCheck(opts: CheckOptions, deps: CheckDeps = SHARED): Promise<void> {
  const { git } = deps;
  const cwd = opts.workspace;
  if (opts.baseRef === "") {
    throw new Error("check runs on pull_request: the base branch (GITHUB_BASE_REF) is empty");
  }
  if (opts.gateway !== undefined) {
    if ((opts.githubToken ?? "") !== "") {
      throw new Error(
        'input "github-token" must not be set with "nimbus-gateway" in check mode: scoring runs extension code and holds no secrets',
      );
    }
    assertGateway(opts.gateway);
  }
  git.fetchRefs([opts.baseRef, PAGES_BRANCH], { cwd });
  const index = await readVerifiedIndex(git, cwd);

  const mergeBase = git.findMergeBase(`origin/${opts.baseRef}`, "HEAD", {
    cwd,
    deepen: [opts.baseRef],
  });
  const changes = git.diffTree(mergeBase, "HEAD", { cwd });
  if (changes.some((c) => c.path.startsWith(REQUESTS_DIR))) {
    checkRequestPullRequest(git, index, changes, cwd, deps.io);
    return;
  }
  const shape = assertPublishShape(changes);
  const admitted = admitPullRequestStatements(git, index, opts.baseRef, shape.statements, cwd);
  if (shape.dir === undefined) {
    deps.io.summary(statementOnlySummary(admitted.admitted));
    deps.io.log(`check passed: ${String(admitted.admitted.length)} statement(s), no publish`);
    return;
  }
  const candidate = readCandidate(git, "HEAD", shape.dir, cwd);
  const config = effectiveConfig(git, opts.baseRef, cwd);

  const work = mkdtempSync(join(deps.tmpdir(), "nimbus-registry-check-"));
  try {
    const verdict = await deps.validate(candidate, admitted.index, config, work);
    const provenance = await checkProvenance(verdict, candidate.packageBytes, work, opts, deps);
    const score = await checkScore(verdict, candidate.packageBytes, work, opts, deps);
    deps.io.summary(checkSummary(verdict, admitted.admitted, provenance, score));
    deps.io.log(
      `check passed: ${verdict.id}@${verdict.version} (${verdict.channel})${verdict.newId ? " — NEW ID" : ""}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
