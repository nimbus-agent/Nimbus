import type { Database } from "bun:sqlite";

import { createMemoryIndexDb } from "../../connectors/connector-sync-test-helpers.ts";
import { extractPrMetadataForIndex } from "../../connectors/github-sync.ts";
import { buildPrMetadata } from "../../connectors/pr-meta.ts";
import { itemPrimaryKey } from "../../index/item-key.ts";
import { upsertIndexedItem } from "../../index/item-store.ts";
import { recordPrChangedFiles } from "../../prfiles/pr-changed-file-store.ts";

/**
 * Index fixtures for `nimbus pre-review`, written through the REAL writers' shapes: GitHub PR metadata from
 * `extractPrMetadataForIndex` (what `upsertPr` stores), a GitLab or Bitbucket PR from `buildPrMetadata`, the
 * changed files through `recordPrChangedFiles` (what `runPrFilePass` stores), and a review in the exact shape
 * `github-sync.ts` `upsertReview` writes.
 */

export const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
export const DAY = 86_400_000;

export function seedDb(): Database {
  return createMemoryIndexDb();
}

export type SeedPr = {
  readonly repo?: string;
  readonly number: number;
  readonly title?: string;
  readonly merged?: boolean;
  readonly mergedDaysAgo?: number;
  readonly files?: readonly string[] | null;
  readonly truncated?: boolean;
  readonly additions?: number;
  readonly deletions?: number;
};

export function prUrl(repo: string, n: number): string {
  return `https://github.com/${repo}/pull/${String(n)}`;
}

/** A GitHub PR item plus (unless `files: null`) its changed-file rows. Returns the item id. */
export function seedGithubPr(db: Database, p: SeedPr): string {
  const repo = p.repo ?? "acme/app";
  const merged = p.merged ?? true;
  const mergedAt = new Date(NOW - (p.mergedDaysAgo ?? 10) * DAY).toISOString();
  const payload: Record<string, unknown> = {
    number: p.number,
    state: merged ? "closed" : "open",
    merged,
    merged_at: merged ? mergedAt : null,
    created_at: new Date(NOW - 40 * DAY).toISOString(),
    user: { login: "dev" },
    head: { ref: `branch-${String(p.number)}` },
    ...(p.additions === undefined ? {} : { additions: p.additions }),
    ...(p.deletions === undefined ? {} : { deletions: p.deletions }),
  };
  const externalId = `${repo}#${String(p.number)}`;
  const url = prUrl(repo, p.number);
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId,
    title: p.title ?? `PR ${String(p.number)}`,
    body: "",
    url,
    canonicalUrl: url,
    modifiedAt: NOW - DAY,
    metadata: extractPrMetadataForIndex(repo, payload, NOW),
    syncedAt: NOW,
  });
  const id = itemPrimaryKey("github", externalId);
  if (p.files !== null) {
    const files = p.files ?? [];
    recordPrChangedFiles(db, {
      itemId: id,
      repoFull: repo,
      files: files.map((path) => ({ path, status: "modified", counterpartPath: null })),
      apiFileCount: p.truncated === true ? files.length + 50 : files.length,
      truncated: p.truncated === true,
      nowMs: NOW,
    });
  }
  return id;
}

/** A GitLab MR in the canonical shape every forge's writer produces through `buildPrMetadata`. */
export function seedGitlabMr(db: Database, n: number, files: readonly string[]): string {
  const repo = "acme/app";
  const externalId = `${repo}!${String(n)}`;
  const url = `https://gitlab.com/${repo}/-/merge_requests/${String(n)}`;
  upsertIndexedItem(db, {
    service: "gitlab",
    type: "pr",
    externalId,
    title: `MR ${String(n)}`,
    body: "",
    url,
    canonicalUrl: url,
    modifiedAt: NOW - DAY,
    metadata: buildPrMetadata({}, { state: "open", repo, number: n }),
    syncedAt: NOW,
  });
  const id = itemPrimaryKey("gitlab", externalId);
  recordPrChangedFiles(db, {
    itemId: id,
    repoFull: repo,
    files: files.map((path) => ({ path, status: "modified", counterpartPath: null })),
    apiFileCount: files.length,
    truncated: false,
    nowMs: NOW,
  });
  return id;
}

/** A review in the shape `github-sync.ts` `upsertReview` writes (the owner's own review). */
export function seedReview(
  db: Database,
  r: {
    readonly repo?: string;
    readonly prNumber: number;
    readonly reviewId: number;
    readonly state: string;
    readonly body: string;
    readonly daysAgo?: number;
  },
): void {
  const repo = r.repo ?? "acme/app";
  upsertIndexedItem(db, {
    service: "github",
    type: "review",
    externalId: `${repo}#${String(r.prNumber)}#review-${String(r.reviewId)}`,
    title: `Review on ${repo}#${String(r.prNumber)}`,
    body: r.body,
    url: `${prUrl(repo, r.prNumber)}#pullrequestreview-${String(r.reviewId)}`,
    canonicalUrl: `${prUrl(repo, r.prNumber)}#pullrequestreview-${String(r.reviewId)}`,
    modifiedAt: NOW - (r.daysAgo ?? 5) * DAY,
    metadata: { repo, pr_number: r.prNumber, review_id: r.reviewId, state: r.state },
    syncedAt: NOW,
  });
}
