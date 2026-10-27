/**
 * Reading the Nimbus trust feed's repository for `trust-check` and `trust-sign`: the signed
 * `trust.json` on `gh-pages` (verified against its own root before anything trusts it), the
 * `nimbus-trust.json` marker, and the source files the feed is built from — `publishers/`,
 * `requests/` and `statements/` — at a ref, through git plumbing (never a checkout).
 */
import {
  FEED_CONFIG_FILE,
  FEED_PUBLISHERS_DIR,
  FEED_REQUESTS_DIR,
  FEED_STATEMENTS_DIR,
  type FeedSkip,
  type FeedSource,
  type FeedSourceFile,
  parseFeedConfig,
  parseTrustFeed,
  TRUST_FEED_FILE,
  type TrustFeed,
  verifyTrustFeedPinned,
} from "../../../registry-format/src/index.ts";
import type * as gitTree from "./git-tree.ts";
import { PAGES_REF } from "./registry-state.ts";

type Git = typeof gitTree;

/** A source file is a small JSON document; anything larger is refused, not read whole. */
const MAX_SOURCE_FILE_BYTES = 16 * 1024;

export const FEED_SOURCE_DIRS = [FEED_PUBLISHERS_DIR, FEED_REQUESTS_DIR, FEED_STATEMENTS_DIR];

export const FEED_NOT_INITIALISED =
  "gh-pages has no trust.json: initialise the feed with `nimbus trust maintain init --github` and push its site first";

function hasFile(git: Git, ref: string, path: string, cwd: string): boolean {
  return git.listTreeEntries(ref, path, { cwd }).some((e) => e.path === path);
}

/** `gh-pages:trust.json`, parsed and verified against its OWN root key. */
export async function readVerifiedFeed(git: Git, cwd: string): Promise<TrustFeed> {
  if (!hasFile(git, PAGES_REF, TRUST_FEED_FILE, cwd)) throw new Error(FEED_NOT_INITIALISED);
  const feed = parseTrustFeed(git.readBlob(PAGES_REF, TRUST_FEED_FILE, { cwd }));
  await verifyTrustFeedPinned(feed, feed.rootKey);
  return feed;
}

/** Throws unless `ref` holds `nimbus-trust.json` as exactly `{ "format": 1 }`. */
export function assertFeedConfig(git: Git, ref: string, cwd: string): void {
  if (!hasFile(git, ref, FEED_CONFIG_FILE, cwd)) {
    throw new Error(`${ref} has no ${FEED_CONFIG_FILE}: this is not a trust feed repository`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        git.readBlob(ref, FEED_CONFIG_FILE, { cwd }),
      ),
    );
  } catch {
    throw new Error(`${FEED_CONFIG_FILE} on ${ref} is not valid UTF-8 JSON`);
  }
  parseFeedConfig(raw);
}

function readSourceFile(
  git: Git,
  ref: string,
  e: gitTree.TreeEntry,
  cwd: string,
): FeedSourceFile | FeedSkip {
  if (e.mode !== git.REGULAR_FILE_MODE) {
    return { path: e.path, reason: `git mode ${e.mode} is not a regular file` };
  }
  const bytes = git.readBlob(ref, e.path, { cwd });
  if (bytes.byteLength > MAX_SOURCE_FILE_BYTES) {
    return { path: e.path, reason: `exceeds ${String(MAX_SOURCE_FILE_BYTES)} bytes` };
  }
  try {
    return {
      path: e.path,
      raw: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    };
  } catch {
    return { path: e.path, reason: "is not valid UTF-8 JSON" };
  }
}

/** The feed source at `ref`; `.gitkeep` files are ignored, unreadable files are skips. */
export function readFeedSourceAt(
  git: Git,
  ref: string,
  cwd: string,
): { source: FeedSource; skipped: FeedSkip[] } {
  const skipped: FeedSkip[] = [];
  const read = (dir: string): FeedSourceFile[] => {
    const out: FeedSourceFile[] = [];
    for (const e of git.listTreeEntries(ref, dir, { cwd })) {
      if (e.path === `${dir}.gitkeep`) continue;
      const r = readSourceFile(git, ref, e, cwd);
      if ("reason" in r) skipped.push(r);
      else out.push(r);
    }
    return out;
  };
  return {
    source: {
      publishers: read(FEED_PUBLISHERS_DIR),
      requests: read(FEED_REQUESTS_DIR),
      statements: read(FEED_STATEMENTS_DIR),
    },
    skipped,
  };
}
