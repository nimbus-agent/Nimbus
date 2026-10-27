/**
 * `mode: trust-check` — the reviewer aid run on a pull request to the Nimbus trust feed. Like
 * `check`, it is NOT the boundary (a pull request can edit this workflow); the boundary is merging
 * and the `trust-sign` approval. Order: the signed `gh-pages:trust.json` is verified against its own
 * root; the base branch's `nimbus-trust.json` must be valid; the path rule over the pull request's
 * diff from the merge base (only `publishers/`, `requests/` and `statements/` may change); every
 * changed source file must parse; then the plan of the merged result is summarised under a banner,
 * because merging changes what every Nimbus install trusts.
 */
import { planTrustFeed } from "../../../registry-format/src/index.ts";
import * as gitTree from "./git-tree.ts";
import { PAGES_BRANCH } from "./registry-state.ts";
import { type ActionIo, code, GHA_IO } from "./report.ts";
import {
  assertFeedConfig,
  FEED_SOURCE_DIRS,
  readFeedSourceAt,
  readVerifiedFeed,
} from "./trust-state.ts";
import { planLines } from "./trust-summary.ts";

export interface TrustCheckOptions {
  workspace: string;
  /** The pull request's base branch (`GITHUB_BASE_REF`). */
  baseRef: string;
}

export interface TrustCheckDeps {
  git: typeof gitTree;
  io: ActionIo;
}

const SHARED: TrustCheckDeps = { git: gitTree, io: GHA_IO };

/** The path rule: every change is inside one of the three source directories. */
function assertSourceOnly(changes: readonly gitTree.TreeChange[]): void {
  if (changes.length === 0) throw new Error("the pull request changes no files");
  const offending = changes.filter((c) => !FEED_SOURCE_DIRS.some((d) => c.path.startsWith(d)));
  if (offending.length > 0) {
    throw new Error(
      `a trust feed pull request may only change ${FEED_SOURCE_DIRS.join(", ")}; it also changes: ${offending.map((c) => `${c.status} ${c.path}`).join(", ")} (workflows and nimbus-trust.json are maintainer edits made by hand)`,
    );
  }
}

/** Run the `trust-check` mode. Throws (failing the step) on any refusal. */
export async function runTrustCheck(
  opts: TrustCheckOptions,
  deps: TrustCheckDeps = SHARED,
): Promise<void> {
  const { git } = deps;
  const cwd = opts.workspace;
  if (opts.baseRef === "") {
    throw new Error("trust-check runs on pull_request: the base branch (GITHUB_BASE_REF) is empty");
  }
  git.fetchRefs([opts.baseRef, PAGES_BRANCH], { cwd });
  const prev = await readVerifiedFeed(git, cwd);
  assertFeedConfig(git, `origin/${opts.baseRef}`, cwd);
  const mergeBase = git.findMergeBase(`origin/${opts.baseRef}`, "HEAD", {
    cwd,
    deepen: [opts.baseRef],
  });
  const changes = git.diffTree(mergeBase, "HEAD", { cwd });
  assertSourceOnly(changes);

  const { source, skipped } = readFeedSourceAt(git, "HEAD", cwd);
  const plan = planTrustFeed(prev, source);
  // A file this pull request touches that the builder would skip fails the check; skips of files it
  // does not touch are reported (they were already on the base branch) but do not fail it.
  const touched = new Set(changes.filter((c) => c.status !== "D").map((c) => c.path));
  const bad = [...skipped, ...plan.skipped].filter((s) => touched.has(s.path));
  deps.io.summary(
    [
      "## Trust feed change",
      "",
      "> [!CAUTION]",
      "> **NIMBUS TRUST FEED — merging this changes what every Nimbus install trusts.** On merge the trust-sign job signs the result with the Nimbus trust root key, after the `trust-signing` approval. Check each line below against what you intend.",
      "",
      ...planLines(plan, skipped),
    ].join("\n"),
  );
  if (bad.length > 0) {
    throw new Error(
      `the trust feed would not sign: ${bad.map((s) => `${code(s.path)}: ${s.reason}`).join("; ")}`,
    );
  }
  deps.io.log(`trust-check passed: ${plan.status}`);
}
