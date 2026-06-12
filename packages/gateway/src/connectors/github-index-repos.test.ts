import { describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "./connector-sync-test-helpers.ts";
import { listGithubReposFromIndex } from "./github-index-repos.ts";

// Helper: insert a row into the item table with given service and metadata JSON.
function insertItem(
  db: ReturnType<typeof createMemoryIndexDb>,
  id: string,
  service: string,
  metadataJson: string,
): void {
  const now = Date.now();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, service, "commit", id, "Title", "", null, null, now, null, metadataJson, now, 0],
  );
}

describe("listGithubReposFromIndex", () => {
  test("returns empty array when db has no items", () => {
    const db = createMemoryIndexDb();
    const result = listGithubReposFromIndex(db);
    expect(result).toEqual([]);
  });

  test("returns empty array when no github items exist", () => {
    const db = createMemoryIndexDb();
    // Insert items for a different service
    insertItem(db, "gitlab:item1", "gitlab", JSON.stringify({ repo: "owner/repo" }));
    const result = listGithubReposFromIndex(db);
    expect(result).toEqual([]);
  });

  test("returns empty array when github items have no repo in metadata", () => {
    const db = createMemoryIndexDb();
    // metadata with no repo field — json_extract returns NULL, filtered by SQL WHERE
    insertItem(db, "github:item1", "github", JSON.stringify({ other: "value" }));
    const result = listGithubReposFromIndex(db);
    expect(result).toEqual([]);
  });

  test("returns empty array when github items have null repo in metadata", () => {
    const db = createMemoryIndexDb();
    // metadata with null repo — json_extract returns NULL, filtered by SQL WHERE
    insertItem(db, "github:item2", "github", JSON.stringify({ repo: null }));
    const result = listGithubReposFromIndex(db);
    expect(result).toEqual([]);
  });

  test("returns single repo from a single github item", () => {
    const db = createMemoryIndexDb();
    insertItem(db, "github:item1", "github", JSON.stringify({ repo: "owner/my-repo" }));
    const result = listGithubReposFromIndex(db);
    expect(result).toEqual(["owner/my-repo"]);
  });

  test("returns distinct repos when multiple items share the same repo", () => {
    const db = createMemoryIndexDb();
    // Three items all in the same repo — deduplication branch: !out.includes(repo) → false for 2nd and 3rd
    insertItem(db, "github:commit1", "github", JSON.stringify({ repo: "owner/repo-a" }));
    insertItem(db, "github:commit2", "github", JSON.stringify({ repo: "owner/repo-a" }));
    insertItem(db, "github:commit3", "github", JSON.stringify({ repo: "owner/repo-a" }));
    const result = listGithubReposFromIndex(db);
    expect(result).toEqual(["owner/repo-a"]);
  });

  test("returns multiple distinct repos", () => {
    const db = createMemoryIndexDb();
    insertItem(db, "github:item1", "github", JSON.stringify({ repo: "owner/repo-a" }));
    insertItem(db, "github:item2", "github", JSON.stringify({ repo: "owner/repo-b" }));
    insertItem(db, "github:item3", "github", JSON.stringify({ repo: "owner/repo-a" })); // duplicate
    const result = listGithubReposFromIndex(db);
    // Both repos must appear, each exactly once
    expect(result).toHaveLength(2);
    expect(result).toContain("owner/repo-a");
    expect(result).toContain("owner/repo-b");
  });

  test("trims whitespace from repo strings (JS trim branch, string path)", () => {
    const db = createMemoryIndexDb();
    // json_extract returns the raw value; if it has surrounding spaces and is non-empty after
    // the SQL length(trim(...)) > 0 filter passes, the JS trim() branch fires
    insertItem(db, "github:item1", "github", JSON.stringify({ repo: "  owner/repo  " }));
    const result = listGithubReposFromIndex(db);
    // The JS side trims the string value
    expect(result).toEqual(["owner/repo"]);
  });

  test("deduplicates repos that differ only in surrounding whitespace after trimming", () => {
    const db = createMemoryIndexDb();
    // Two items: one has padded spaces, one does not — after trim they are identical
    insertItem(db, "github:item1", "github", JSON.stringify({ repo: "owner/repo" }));
    insertItem(db, "github:item2", "github", JSON.stringify({ repo: "  owner/repo  " }));
    const result = listGithubReposFromIndex(db);
    expect(result).toEqual(["owner/repo"]);
  });

  test("excludes github items whose metadata repo is a JSON number (non-string branch → empty string → skipped)", () => {
    const db = createMemoryIndexDb();
    // json_extract returns a number; the SQL length(trim(cast(42 as text))) > 0 passes ("42" is non-empty),
    // but the JS typeof check → false → repo = "" → skipped by repo !== "" guard
    insertItem(db, "github:item1", "github", JSON.stringify({ repo: 42 }));
    const result = listGithubReposFromIndex(db);
    expect(result).toEqual([]);
  });

  test("mixes valid string repos and non-string repos, returning only valid ones", () => {
    const db = createMemoryIndexDb();
    insertItem(db, "github:item1", "github", JSON.stringify({ repo: "owner/repo-valid" }));
    insertItem(db, "github:item2", "github", JSON.stringify({ repo: 99 })); // numeric — non-string branch
    const result = listGithubReposFromIndex(db);
    expect(result).toEqual(["owner/repo-valid"]);
  });

  test("ignores items from other services mixed with github items", () => {
    const db = createMemoryIndexDb();
    insertItem(db, "github:item1", "github", JSON.stringify({ repo: "owner/github-repo" }));
    insertItem(db, "gitlab:item1", "gitlab", JSON.stringify({ repo: "owner/gitlab-repo" }));
    insertItem(db, "bitbucket:item1", "bitbucket", JSON.stringify({ repo: "owner/bb-repo" }));
    const result = listGithubReposFromIndex(db);
    expect(result).toEqual(["owner/github-repo"]);
  });

  test("returns empty array when all github items have empty string repo (empty string filtered by SQL)", () => {
    const db = createMemoryIndexDb();
    // An empty-string repo: length(trim("")) = 0 → filtered by SQL, so no rows returned
    insertItem(db, "github:item1", "github", JSON.stringify({ repo: "" }));
    const result = listGithubReposFromIndex(db);
    expect(result).toEqual([]);
  });
});
