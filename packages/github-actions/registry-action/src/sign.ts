/**
 * `mode: sign` — the content boundary, run behind the `registry-signing` environment's required
 * approval (design § 7.4). Implemented in Task 10: re-validation of every unsigned
 * `extensions/<id>/<version>/` against the signed bindings, the already-signed and loosening
 * refusals, signing, and the bounded `gh-pages` push.
 */
import { signIndex, validatePublish } from "../../../registry-format/src/index.ts";
import * as gitTree from "./git-tree.ts";

/** Inputs `sign` needs. */
export interface SignOptions {
  /** The registry repository's checkout. */
  workspace: string;
  /** The registry root signing key, as the `root-key` input carries it (format fixed in Task 10). */
  rootKey: string;
}

/** What `sign` reads the registry with and the shared rules it applies; injectable for tests. */
export interface SignDeps {
  validate: typeof validatePublish;
  sign: typeof signIndex;
  git: typeof gitTree;
}

const SHARED: SignDeps = { validate: validatePublish, sign: signIndex, git: gitTree };

/** Run the `sign` mode. */
export async function runSign(opts: SignOptions, deps: SignDeps = SHARED): Promise<void> {
  void opts;
  void deps;
  throw new Error("not implemented");
}
