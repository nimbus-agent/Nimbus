/**
 * `mode: check` — the reviewer aid run on a registry pull request (design § 7.4). Implemented in
 * Task 10: the path rule over the PR diff, `validatePublish` against the signed `gh-pages` index,
 * and the reviewer job summary.
 */
import { validatePublish } from "../../../registry-format/src/index.ts";
import * as gitTree from "./git-tree.ts";

/** Inputs `check` needs. */
export interface CheckOptions {
  /** The registry repository's checkout. */
  workspace: string;
  /** The pull request's base branch. */
  baseRef: string;
}

/** What `check` reads the registry with and judges it by; injectable so tests can drive it. */
export interface CheckDeps {
  validate: typeof validatePublish;
  git: typeof gitTree;
}

const SHARED: CheckDeps = { validate: validatePublish, git: gitTree };

/** Run the `check` mode. */
export async function runCheck(opts: CheckOptions, deps: CheckDeps = SHARED): Promise<void> {
  void opts;
  void deps;
  throw new Error("not implemented");
}
