/**
 * Spec §3.1.1: four canonical keys collide with raw keys writers already emitted, so these reader
 * results change in PR A1 (before any reader code changes in A2). Each change is in the direction
 * of the fix; pinning it makes it deliberate. Rows come ONLY from the real writer mappers.
 */
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  nonGithubMergedPrCount as changelogNonGithubMerged,
  selectMergedPrs as changelogSelectMergedPrs,
} from "../agents/changelog-queries.ts";
import {
  selectActivePrs,
  nonGithubMergedPrCount as standupNonGithubMerged,
  selectMergedPrs as standupSelectMergedPrs,
} from "../agents/standup-queries.ts";
import { gitlabMrMetadata } from "./_lib/gitlab/events.ts";
import { bitbucketPrMetadata } from "./bitbucket-sync.ts";
import { createMemoryIndexDb } from "./connector-sync-test-helpers.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const ME = "person:me";

function insertPr(db: Database, id: string, service: string, meta: Record<string, unknown>): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, url, modified_at, author_id, metadata, synced_at)
     VALUES (?, ?, 'pr', ?, ?, NULL, ?, ?, ?, ?)`,
    [id, service, id, id, NOW - 3_600_000, ME, JSON.stringify(meta), NOW],
  );
}

function seeded(): Database {
  const db = createMemoryIndexDb();
  insertPr(
    db,
    "bitbucket:acme/app#1",
    "bitbucket",
    bitbucketPrMetadata(
      "acme/app",
      { id: 1, state: "MERGED", created_on: "2026-10-01T00:00:00Z" },
      "Me",
    ),
  );
  insertPr(
    db,
    "gitlab:acme/app!2",
    "gitlab",
    gitlabMrMetadata(
      {
        pathWithNamespace: "acme/app",
        iid: 2,
        actionName: "accepted",
        eventCreatedAt: "2026-10-08T10:00:00Z",
      },
      null,
    ),
  );
  return db;
}

describe("§3.1.1 collisions — reader results that change in A1", () => {
  // The GitLab row carries merged_at, so it is LISTED; only the Bitbucket row (no merge time) is
  // counted as unlisted — a listed row is never counted twice.
  test("changelog lists the GitLab merge and counts only the Bitbucket one (was 0 and 0)", () => {
    const db = seeded();
    const w = { fromMs: NOW - 86_400_000, toMs: NOW, scope: { kind: "all" } } as const;
    expect(changelogSelectMergedPrs(db, w).map((r) => r.id)).toEqual(["gitlab:acme/app!2"]);
    expect(changelogNonGithubMerged(db, w)).toBe(1);
    db.close();
  });

  test("standup lists my GitLab merge and counts only my Bitbucket one (was 0 and 0)", () => {
    const db = seeded();
    const w = { fromMs: NOW - 86_400_000, toMs: NOW };
    expect(standupSelectMergedPrs(db, w, ME).map((r) => r.id)).toEqual(["gitlab:acme/app!2"]);
    expect(standupNonGithubMerged(db, w, ME)).toBe(1);
    db.close();
  });

  test("standup no longer lists merged Bitbucket/GitLab PRs as active", () => {
    const db = seeded();
    // Positive control: an OPEN PR by the same author in the same window IS listed, so the
    // absence of the merged rows is not an artefact of the fixture.
    insertPr(
      db,
      "bitbucket:acme/app#3",
      "bitbucket",
      bitbucketPrMetadata(
        "acme/app",
        { id: 3, state: "OPEN", created_on: "2026-10-01T00:00:00Z" },
        "Me",
      ),
    );
    expect(
      selectActivePrs(db, { fromMs: NOW - 86_400_000, toMs: NOW }, ME).map((r) => r.id),
    ).toEqual(["bitbucket:acme/app#3"]);
    db.close();
  });
});
