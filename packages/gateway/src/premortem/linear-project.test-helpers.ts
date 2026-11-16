import type { Database } from "bun:sqlite";

import { extractPrMetadataForIndex } from "../connectors/github-sync.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import {
  type LinearFixtureIssue,
  type LinearFixtureProject,
  seedLinearViaSync,
} from "./tracker-writers.test-helpers.ts";

/**
 * A GitHub pull request written through `upsertIndexedItem`, so the REAL `syncPrGraph` forms the
 * `resolves` edge to an issue named in `title` (it must be written AFTER the issue: the edge is
 * formed only at PR-write time). Metadata comes from the real GitHub mapper.
 */
export function upsertPrNamingIssue(
  db: Database,
  opts: {
    title: string;
    repo: string;
    openedAtMs: number;
    mergedAtMs: number;
    externalId?: string;
  },
): void {
  const metadata = extractPrMetadataForIndex(
    opts.repo,
    {
      number: 1,
      state: "closed",
      merged: true,
      created_at: new Date(opts.openedAtMs).toISOString(),
      merged_at: new Date(opts.mergedAtMs).toISOString(),
    },
    opts.mergedAtMs,
  );
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: opts.externalId ?? `${opts.repo}#${opts.title}`,
    title: opts.title,
    metadata,
    modifiedAt: opts.mergedAtMs,
    syncedAt: opts.mergedAtMs,
  });
}

export type LinearScenarioProject = LinearFixtureProject & {
  /** The Linear team key used for this project's issue identifiers (`ENG`), unique per project. */
  readonly issuePrefix: string;
  /** Repos whose merged PRs name this project's issues. */
  readonly repos: readonly string[];
};

/**
 * Seeds Linear projects and one issue per (project, repo) through the REAL Linear sync, then one
 * merged PR per issue naming it. `projectId: null` issues are not produced here.
 */
export async function seedLinearScenario(
  db: Database,
  projects: readonly LinearScenarioProject[],
  prTimes: { openedAtMs: number; mergedAtMs: number },
): Promise<void> {
  const issues: LinearFixtureIssue[] = [];
  const prs: Array<{ title: string; repo: string }> = [];
  for (const p of projects) {
    p.repos.forEach((repo, i) => {
      const identifier = `${p.issuePrefix}-${String(i + 1)}`;
      issues.push({ identifier, projectId: p.id });
      prs.push({ title: `Fix ${identifier}`, repo });
    });
  }
  await seedLinearViaSync(db, { projects, issues });
  for (const pr of prs) {
    upsertPrNamingIssue(db, { ...pr, ...prTimes });
  }
}
