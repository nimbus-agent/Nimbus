/**
 * `mode: check` — the reviewer aid run on a registry pull request (design § 7.4). It is NOT the
 * security boundary: a pull request can edit this workflow itself, so a green check proves only
 * that the files it read pass. The boundary is `sign` and its required approval.
 *
 * Order: the signed `gh-pages` index is verified against its own root key first (the validator
 * trusts the index it is handed); then the path rule over the pull request's diff from the merge
 * base; then `validatePublish` over the committed bytes; then the reviewer's job summary.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import {
  codeUnitCompare,
  effectiveRegistryConfig,
  type PublishVerdict,
  publisherKeyFingerprint,
  type RegistryConfig,
  validatePublish,
} from "../../../registry-format/src/index.ts";
import * as gitTree from "./git-tree.ts";
import {
  CANDIDATE_FILES,
  PAGES_BRANCH,
  PAGES_REF,
  readCandidate,
  readConfigAt,
  readVerifiedIndex,
  splitExtensionDir,
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

/**
 * The path rule: the diff only ADDS the three files of exactly one new `extensions/<id>/<version>/`.
 * Returns that directory's coordinates; anything else — a deletion or edit anywhere, a workflow,
 * `nimbus-registry.json`, `index.json`, another extension's files, a second version — refuses.
 */
function assertSinglePublish(changes: readonly gitTree.TreeChange[]): {
  id: string;
  version: string;
} {
  if (changes.length === 0) throw new Error("the pull request changes no files");
  const offending: string[] = [];
  const dirs = new Set<string>();
  for (const c of changes) {
    const m = FILE_RE.exec(c.path);
    if (c.status !== "A" || m?.[1] === undefined) {
      offending.push(`${c.status} ${c.path}`);
    } else {
      dirs.add(m[1]);
    }
  }
  if (offending.length > 0) {
    throw new Error(
      "a publish pull request may only add manifest.json, package.tgz and publish-request.json " +
        `under one extensions/<id>/<version>/; it also changes: ${offending.join(", ")}`,
    );
  }
  if (dirs.size !== 1) {
    throw new Error(
      `a publish pull request adds exactly one extensions/<id>/<version>/; this one adds ${[...dirs].sort(codeUnitCompare).join(", ")}`,
    );
  }
  const [dir] = dirs;
  const coords = dir === undefined ? undefined : splitExtensionDir(dir);
  if (coords === undefined || changes.length !== CANDIDATE_FILES.length) {
    throw new Error(`${String(dir)}/ must add all of ${CANDIDATE_FILES.join(", ")}`);
  }
  return coords;
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

/** The reviewer's job summary for an accepted publish. */
function checkSummary(v: PublishVerdict): string {
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
  const dir = assertSinglePublish(git.diffTree(mergeBase, "HEAD", { cwd }));
  const candidate = readCandidate(git, "HEAD", dir, cwd);
  const config = effectiveConfig(git, opts.baseRef, cwd);

  const work = mkdtempSync(join(deps.tmpdir(), "nimbus-registry-check-"));
  try {
    const verdict = await deps.validate(candidate, index, config, work);
    deps.io.summary(checkSummary(verdict));
    deps.io.log(
      `check passed: ${verdict.id}@${verdict.version} (${verdict.channel})${verdict.newId ? " — NEW ID" : ""}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
