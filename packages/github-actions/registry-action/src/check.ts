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
  CANDIDATE_FILES,
  PAGES_BRANCH,
  PAGES_REF,
  readCandidate,
  readConfigAt,
  readStatementFiles,
  readVerifiedIndex,
  splitExtensionDir,
  statementPath,
} from "./registry-state.ts";
import { type ActionIo, code, GHA_IO } from "./report.ts";

/** Inputs `check` needs. */
export interface CheckOptions {
  /** The registry repository's checkout, with the pull request at `HEAD`. */
  workspace: string;
  /** The pull request's base branch (`GITHUB_BASE_REF`). */
  baseRef: string;
}

/** What `check` reads the registry with, judges it by and reports to; injectable for tests. */
export interface CheckDeps {
  validate: typeof validatePublish;
  git: typeof gitTree;
  io: ActionIo;
  /** Where the validator's scratch directory goes. */
  tmpdir: () => string;
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
 * The pull request's statement files admitted into `index` exactly as `sign` would admit them. A
 * file `sign` would skip fails the check: the reviewer aid should be loud.
 */
function admitPullRequestStatements(
  git: typeof gitTree,
  index: RegistryIndex,
  added: ReadonlySet<string>,
  cwd: string,
): { index: RegistryIndex; admitted: TrustStatement[] } {
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

/** The reviewer's job summary for an accepted publish. */
function checkSummary(v: PublishVerdict, admitted: readonly TrustStatement[] = []): string {
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
    "",
    ...statementLines(admitted),
    "**Declared permissions**",
    "",
    `- Network hosts: ${listOf(v.permissions.network)}`,
    `- Filesystem read: ${listOf(v.permissions.filesystem.read)}`,
    `- Filesystem write: ${listOf(v.permissions.filesystem.write)}`,
    "",
    "No runtime check of the package is performed: this check validated the signature, the " +
      "registry rules and the package's file set, not what the code does.",
  );
  return lines.join("\n");
}

/** Run the `check` mode. Throws (failing the step) on any refusal. */
export async function runCheck(opts: CheckOptions, deps: CheckDeps = SHARED): Promise<void> {
  const { git } = deps;
  const cwd = opts.workspace;
  if (opts.baseRef === "") {
    throw new Error("check runs on pull_request: the base branch (GITHUB_BASE_REF) is empty");
  }
  git.fetchRefs([opts.baseRef, PAGES_BRANCH], { cwd });
  const index = await readVerifiedIndex(git, cwd);

  const mergeBase = git.findMergeBase(`origin/${opts.baseRef}`, "HEAD", {
    cwd,
    deepen: [opts.baseRef],
  });
  const shape = assertPublishShape(git.diffTree(mergeBase, "HEAD", { cwd }));
  const admitted = admitPullRequestStatements(git, index, shape.statements, cwd);
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
    deps.io.summary(checkSummary(verdict, admitted.admitted));
    deps.io.log(
      `check passed: ${verdict.id}@${verdict.version} (${verdict.channel})${verdict.newId ? " — NEW ID" : ""}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
