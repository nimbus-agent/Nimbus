/**
 * `mode: trust-sign` — the Nimbus trust feed's content boundary, run behind the `trust-signing`
 * environment's required approval. Every attempt starts from a fresh fetch of the default branch and
 * `gh-pages`, and refuses — failing the run with nothing signed or pushed — when `gh-pages:trust.json`
 * does not verify against its own root, the `root-key` input is not that root, or the default branch
 * has no valid `nimbus-trust.json`. Then the next feed is built from the default branch's source by
 * the same builder `nimbus trust maintain sign` runs (`buildTrustFeed`), committed to `gh-pages` and
 * pushed; a push that loses a race starts over, at most `MAX_ATTEMPTS` times. Nothing new means no
 * new signature and no commit.
 *
 * The root key is a secret: parsed in memory only, never written, never named (refusals name
 * fingerprints of PUBLIC keys). `main.ts` masks the input and drops it from the environment first.
 */
import {
  buildTrustFeed,
  type FeedPlan,
  type FeedSkip,
  publicKeyFromSeed,
  publisherKeyFingerprint,
  TRUST_FEED_FILE,
} from "../../../registry-format/src/index.ts";
import * as gitTree from "./git-tree.ts";
import { PAGES_BRANCH, PAGES_REF } from "./registry-state.ts";
import { type ActionIo, code, GHA_IO } from "./report.ts";
import { commitSite, pushCommit } from "./site-commit.ts";
import { assertFeedConfig, readFeedSourceAt, readVerifiedFeed } from "./trust-state.ts";
import { planLines } from "./trust-summary.ts";

export interface TrustSignOptions {
  workspace: string;
  /** The `root-key` input: base64 of the 32-byte Ed25519 seed `trust maintain init` writes. */
  rootKey: string;
  /** The default branch; asked of `origin` when absent. */
  defaultBranch?: string;
}

export interface TrustSignDeps {
  git: typeof gitTree;
  io: ActionIo;
  /** Called between building the commit and pushing it; tests race a concurrent push here. */
  beforePush?: (attempt: number) => void | Promise<void>;
}

const SHARED: TrustSignDeps = { git: gitTree, io: GHA_IO };

const MAX_ATTEMPTS = 3;

const ROOT_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

function parseRootKey(raw: string): Uint8Array {
  const s = raw.trim();
  if (!ROOT_KEY_RE.test(s)) {
    throw new Error(
      'input "root-key" is not a trust root key: expected the base64 of a 32-byte Ed25519 seed, as `nimbus trust maintain init` writes it',
    );
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}

interface Attempt {
  commit: string | undefined;
  plan: FeedPlan;
  skipped: FeedSkip[];
  sequence: number;
}

async function attemptSign(
  opts: TrustSignOptions & { defaultBranch: string },
  seed: Uint8Array,
  rootKey: string,
  git: typeof gitTree,
): Promise<Attempt> {
  const cwd = opts.workspace;
  const mainRef = `origin/${opts.defaultBranch}`;
  git.fetchRefs([opts.defaultBranch, PAGES_BRANCH], { cwd });
  const prev = await readVerifiedFeed(git, cwd);
  if (prev.rootKey !== rootKey) {
    throw new Error(
      `refusing to sign: the root-key input (public key fingerprint ${publisherKeyFingerprint(rootKey)}) is not this feed's root key (fingerprint ${publisherKeyFingerprint(prev.rootKey)})`,
    );
  }
  assertFeedConfig(git, mainRef, cwd);
  const { source, skipped } = readFeedSourceAt(git, mainRef, cwd);
  const at = git.commitTime(mainRef, { cwd });
  const { plan, feed } = await buildTrustFeed(prev, source, seed, at);
  if (feed === undefined) {
    return { commit: undefined, plan, skipped, sequence: prev.sequence };
  }
  const bytes = new TextEncoder().encode(`${JSON.stringify(feed, null, 2)}\n`);
  const commit = commitSite(
    git.commitOf(PAGES_REF, { cwd }),
    [{ path: TRUST_FEED_FILE, bytes }],
    `Sign trust feed sequence ${String(feed.sequence)}`,
    cwd,
  );
  return { commit, plan, skipped, sequence: feed.sequence };
}

function report(io: ActionIo, a: Attempt, pushed: boolean): void {
  for (const s of [...a.skipped, ...a.plan.skipped]) {
    io.annotate("warning", `skipped ${s.path}: ${s.reason}`);
  }
  const head = pushed
    ? `Signed trust feed sequence ${String(a.sequence)}; pushed to ${code(PAGES_BRANCH)}.`
    : "No change: nothing was committed.";
  io.summary(["## Trust feed sign", "", head, "", ...planLines(a.plan, a.skipped)].join("\n"));
  io.log(
    pushed ? `signed trust feed sequence ${String(a.sequence)}` : "nothing to sign; no commit",
  );
}

async function signLoop(
  opts: TrustSignOptions,
  seed: Uint8Array,
  deps: TrustSignDeps,
): Promise<void> {
  const rootKey = Buffer.from(publicKeyFromSeed(seed)).toString("base64");
  const defaultBranch = opts.defaultBranch ?? deps.git.remoteDefaultBranch({ cwd: opts.workspace });
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // NOSONAR S9382: sequential by design - each attempt starts from a fresh fetch after a lost race
    const a = await attemptSign({ ...opts, defaultBranch }, seed, rootKey, deps.git);
    if (a.commit === undefined) {
      report(deps.io, a, false);
      return;
    }
    await deps.beforePush?.(attempt);
    if (pushCommit(a.commit, PAGES_BRANCH, opts.workspace) === "pushed") {
      report(deps.io, a, true);
      return;
    }
    deps.io.log(`${PAGES_BRANCH} moved during attempt ${String(attempt)}; starting over`);
  }
  throw new Error(
    `refusing to continue: the push to ${PAGES_BRANCH} lost to a concurrent update ${String(MAX_ATTEMPTS)} times`,
  );
}

/** Run the `trust-sign` mode. Throws (failing the run, nothing pushed) on any refusal. */
export async function runTrustSign(
  opts: TrustSignOptions,
  deps: TrustSignDeps = SHARED,
): Promise<void> {
  const seed = parseRootKey(opts.rootKey);
  try {
    await signLoop(opts, seed, deps);
  } finally {
    seed.fill(0);
  }
}
