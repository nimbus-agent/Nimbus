import { describe, expect, test } from "bun:test";

import { upsertIndexedItem } from "../index/item-store.ts";
import {
  DAY,
  NOW,
  prUrl,
  seedBitbucketPr,
  seedDb,
  seedGithubPr,
  seedGitlabMr,
  seedReview,
} from "./__fixtures__/prereview-seed.ts";
import {
  AREAS_MAX,
  areaOf,
  areasOf,
  buildPrereviewBrief,
  coChangesForArea,
  FINDINGS_MAX,
  isUnder,
  PrereviewError,
  REVIEWS_PER_PR,
  recurringTerms,
} from "./prreview-build.ts";

const TARGET = 100;

/** A repository where 4 of 5 merged PRs that touch src/index/ also touch docs/architecture.md. */
function standardRepo(): ReturnType<typeof seedDb> {
  const db = seedDb();
  for (let i = 1; i <= 5; i++) {
    const files = ["src/index/schema.ts", ...(i <= 4 ? ["docs/architecture.md"] : [])];
    seedGithubPr(db, {
      number: i,
      title: `Past ${String(i)}`,
      files,
      additions: i * 10,
      deletions: 5,
    });
  }
  seedGithubPr(db, {
    number: TARGET,
    title: "Target",
    merged: false,
    files: ["src/index/schema.ts"],
    additions: 200,
    deletions: 20,
  });
  return db;
}

describe("path helpers", () => {
  test("areaOf and isUnder", () => {
    expect(areaOf("a/b/c.ts")).toBe("a/b");
    expect(areaOf("README.md")).toBe(".");
    expect(areaOf("/x")).toBe(".");
    expect(isUnder("a/b/c.ts", "a/b")).toBe(true);
    expect(isUnder("a/b", "a/b")).toBe(true);
    expect(isUnder("a/bc/d.ts", "a/b")).toBe(false);
    expect(isUnder("anything", ".")).toBe(true);
  });

  test("areasOf orders by file count then path, and caps", () => {
    expect(areasOf(["b/1", "b/2", "a/1"]).areas).toEqual(["b", "a"]);
    expect(areasOf(["b/1", "a/1"]).areas).toEqual(["a", "b"]);
    const many = Array.from(
      { length: AREAS_MAX + 3 },
      (_, i) => `d${String(i).padStart(2, "0")}/f`,
    );
    const out = areasOf(many);
    expect(out.areas).toHaveLength(AREAS_MAX);
    expect(out.total).toBe(AREAS_MAX + 3);
  });
});

function pr(id: string, files: string[]) {
  return {
    ref: { itemId: id, title: id, url: null, mergedAtMs: 1 },
    number: null,
    files,
    size: null,
  };
}

describe("coChangesForArea thresholds (spec § 3.3)", () => {
  test("3 of 4 (0.75) emits; a cohort of 3 is not judged", () => {
    const h = [
      pr("a", ["src/x.ts", "docs/a.md"]),
      pr("b", ["src/y.ts", "docs/a.md"]),
      pr("c", ["src/z.ts", "docs/a.md"]),
      pr("d", ["src/w.ts"]),
    ];
    // count 3 is below MIN_COHORT (4), so even at 0.75 it does not emit
    expect(coChangesForArea("src", ["src/x.ts"], h)).toEqual([]);
    expect(coChangesForArea("src", ["src/x.ts"], h.slice(0, 3))).toBeNull();
  });

  test("4 of 5 emits, 4 of 7 does not", () => {
    const five = [1, 2, 3, 4, 5].map((i) =>
      pr(String(i), ["src/x.ts", ...(i <= 4 ? ["docs/a.md"] : [])]),
    );
    const got = coChangesForArea("src", ["src/x.ts"], five) ?? [];
    expect(got.map((c) => [c.companion, c.companionKind, c.count, c.cohort])).toEqual([
      ["docs/a.md", "file", 4, 5],
    ]);
    const seven = [...five, pr("6", ["src/x.ts"]), pr("7", ["src/x.ts"])];
    expect(coChangesForArea("src", ["src/x.ts"], seven)).toEqual([]);
  });

  test("a directory is reported only when no exact file under it is", () => {
    const h = [1, 2, 3, 4].map((i) => pr(String(i), ["src/x.ts", `test/t${String(i)}.ts`]));
    const got = coChangesForArea("src", ["src/x.ts"], h) ?? [];
    expect(got.map((c) => [c.companion, c.companionKind])).toEqual([["test", "directory"]]);
    const same = [1, 2, 3, 4].map((i) => pr(String(i), ["src/x.ts", "test/t.ts"]));
    const got2 = coChangesForArea("src", ["src/x.ts"], same) ?? [];
    expect(got2.map((c) => [c.companion, c.companionKind])).toEqual([["test/t.ts", "file"]]);
  });

  test("a companion the PR already touches, or an ancestor of a touched path, is never reported", () => {
    const h = [1, 2, 3, 4].map((i) => pr(String(i), ["src/a/x.ts", "docs/a.md"]));
    expect(coChangesForArea("src/a", ["src/a/x.ts", "docs/a.md"], h)).toEqual([]);
  });

  test("a subdirectory of the area counts toward the area's cohort", () => {
    const h = [1, 2, 3, 4].map((i) => pr(String(i), ["src/deep/x.ts", "CHANGELOG.md"]));
    const got = coChangesForArea("src", ["src/y.ts"], h) ?? [];
    expect(got.map((c) => c.companion)).toContain("CHANGELOG.md");
  });
});

describe("recurringTerms", () => {
  test("counts distinct reviews, drops stopwords and numbers, orders and caps", () => {
    const terms = recurringTerms([
      "Please add a migration and a migration test",
      "Migration missing; also rollback",
      "rollback plan? 12345",
      "this that",
    ]);
    expect(terms).toEqual([
      { term: "migration", reviews: 2 },
      { term: "rollback", reviews: 2 },
    ]);
  });
});

describe("coChangesForArea specificity", () => {
  test("a parent directory is dropped when a subdirectory under it is also a finding", () => {
    const h = [1, 2, 3, 4].map((i) =>
      pr(String(i), ["src/x.ts", `tests/unit/a${String(i)}.ts`, `tests/unit/b${String(i)}.ts`]),
    );
    const got = coChangesForArea("src", ["src/x.ts"], h) ?? [];
    expect(got.map((c) => [c.companion, c.companionKind])).toEqual([["tests/unit", "directory"]]);
  });
});

describe("buildPrereviewBrief", () => {
  test("co-change finding, examples, history count, size", () => {
    const db = standardRepo();
    const b = buildPrereviewBrief(db, prUrl("acme/app", TARGET), NOW);
    expect(b.kind).toBe("pr_prereview");
    expect(b.target.number).toBe(TARGET);
    expect(b.target.files).toEqual(["src/index/schema.ts"]);
    expect(b.counts.historyUsed).toBe(5);
    expect(b.coChanges).toHaveLength(1);
    expect(b.coChanges[0]?.companion).toBe("docs/architecture.md");
    expect(b.coChanges[0]?.examples).toHaveLength(3);
    expect(b.size).toEqual({ total: 220, cohortMedian: 35, percentile: 100, comparable: 5 });
  });

  test("history excludes open, old, other-repo, uncovered and truncated PRs, counting the last two", () => {
    const db = standardRepo();
    seedGithubPr(db, { number: 50, merged: false, files: ["src/index/a.ts"] });
    seedGithubPr(db, { number: 51, mergedDaysAgo: 400, files: ["src/index/a.ts"] });
    seedGithubPr(db, { number: 52, repo: "acme/other", files: ["src/index/a.ts"] });
    seedGithubPr(db, { number: 53, files: null });
    seedGithubPr(db, { number: 54, files: ["src/index/a.ts"], truncated: true });
    const b = buildPrereviewBrief(db, prUrl("acme/app", TARGET), NOW);
    expect(b.counts.historyUsed).toBe(5);
    expect(b.counts.historyNoCoverage).toBe(1);
    expect(b.counts.historyTruncated).toBe(1);
    expect(b.gaps.map((g) => g.detail).join("\n")).toContain(
      "1 merged pull request(s) with no indexed file list and 1 with an incomplete one",
    );
  });

  test("own reviews of cohort PRs are matched, filtered by state and repo, and counted", () => {
    const db = standardRepo();
    seedReview(db, {
      prNumber: 1,
      reviewId: 1,
      state: "changes_requested",
      body: "Add a migration note",
      daysAgo: 3,
    });
    seedReview(db, {
      prNumber: 2,
      reviewId: 2,
      state: "COMMENTED",
      body: "migration order?",
      daysAgo: 2,
    });
    seedReview(db, { prNumber: 3, reviewId: 3, state: "APPROVED", body: "lgtm" });
    seedReview(db, { prNumber: 4, reviewId: 4, state: "COMMENTED", body: "   " });
    seedReview(db, { prNumber: 99, reviewId: 5, state: "COMMENTED", body: "not in cohort" });
    seedReview(db, {
      repo: "acme/other",
      prNumber: 1,
      reviewId: 6,
      state: "COMMENTED",
      body: "other repo",
    });
    const b = buildPrereviewBrief(db, prUrl("acme/app", TARGET), NOW);
    expect(b.reviewNotes?.map((n) => [n.pr.title, n.state])).toEqual([
      ["Past 2", "COMMENTED"],
      ["Past 1", "CHANGES_REQUESTED"],
    ]);
    expect(b.counts.reviewsMatched).toBe(2);
    expect(b.reviewTerms).toEqual([{ term: "migration", reviews: 2 }]);
  });

  test("reviews of other PRs never use up the scan cap of a cohort review", () => {
    const db = standardRepo();
    seedReview(db, {
      prNumber: 1,
      reviewId: 1,
      state: "COMMENTED",
      body: "old cohort note",
      daysAgo: 90,
    });
    for (let i = 0; i < 250; i++) {
      seedReview(db, {
        prNumber: 900 + i,
        reviewId: 100 + i,
        state: "COMMENTED",
        body: "noise",
        daysAgo: 1,
      });
    }
    const b = buildPrereviewBrief(db, prUrl("acme/app", TARGET), NOW);
    expect(b.counts.reviewsMatched).toBe(1);
  });

  test("a PR the owner reviewed still resolves (the review shares its resolve key)", () => {
    const db = standardRepo();
    seedReview(db, { prNumber: TARGET, reviewId: 9, state: "COMMENTED", body: "x" });
    expect(buildPrereviewBrief(db, prUrl("acme/app", TARGET), NOW).target.number).toBe(TARGET);
  });

  test("a target with no file list gets no lanes and a gap naming the sync", () => {
    const db = standardRepo();
    seedGithubPr(db, { number: 200, merged: false, files: null });
    const b = buildPrereviewBrief(db, prUrl("acme/app", 200), NOW);
    expect(b.target.filesCovered).toBe(false);
    expect(b.coChanges).toEqual([]);
    const g = b.gaps.find((x) => x.detail.includes("changed files are not in the index"));
    expect(g?.remediation).toBe("run `nimbus connector sync github`");
  });

  test("a truncated target file list is disclosed with both counts", () => {
    const db = standardRepo();
    seedGithubPr(db, { number: 201, merged: false, files: ["src/index/a.ts"], truncated: true });
    const b = buildPrereviewBrief(db, prUrl("acme/app", 201), NOW);
    expect(b.target.filesTruncated).toBe(true);
    expect(b.gaps.map((g) => g.detail).join("\n")).toContain("(1 of 51 files stored)");
  });

  test("thin history, area cut and finding cut are each disclosed", () => {
    const db = seedDb();
    const companions = Array.from(
      { length: FINDINGS_MAX + 2 },
      (_, i) => `c${String(i).padStart(2, "0")}.md`,
    );
    for (let i = 1; i <= 4; i++)
      seedGithubPr(db, { number: i, files: ["src/a.ts", ...companions] });
    const targetFiles = [
      "src/a.ts",
      ...Array.from({ length: AREAS_MAX }, (_, i) => `z${String(i)}/f.ts`),
    ];
    seedGithubPr(db, { number: TARGET, merged: false, files: targetFiles });
    const b = buildPrereviewBrief(db, prUrl("acme/app", TARGET), NOW);
    const text = b.gaps.map((g) => g.detail).join("\n");
    expect(b.coChanges).toHaveLength(FINDINGS_MAX);
    expect(b.counts.findingsCut).toBe(2);
    expect(text).toContain("2 further co-change finding(s)");
    expect(text).toContain(
      `Only the ${String(AREAS_MAX)} largest of ${String(AREAS_MAX + 1)} touched areas`,
    );
    expect(text).toContain("had fewer than 4 comparable merged pull requests");
    expect(b.size).toBeNull();
    expect(text).toContain("No size comparison");
  });

  test("a GitLab MR gets the co-change lane but no review lane, with a gap", () => {
    const db = seedDb();
    const id = seedGitlabMr(db, 7, ["src/a.ts"]);
    const b = buildPrereviewBrief(db, "https://gitlab.com/acme/app/-/merge_requests/7", NOW);
    expect(b.target.itemId).toBe(id);
    expect(b.reviewNotes).toBeNull();
    expect(b.gaps.some((g) => g.detail.startsWith("No review data is indexed for gitlab"))).toBe(
      true,
    );
  });

  test("misses are named errors", () => {
    const db = standardRepo();
    seedReview(db, { prNumber: 300, reviewId: 1, state: "COMMENTED", body: "x" });
    const reason = (u: string): string => {
      try {
        buildPrereviewBrief(db, u, NOW);
        return "none";
      } catch (e) {
        return e instanceof PrereviewError ? e.reason : "other";
      }
    };
    expect(reason("not a url")).toBe("unresolvable_url");
    expect(reason("https://github.com/acme/app/pull/999")).toBe("not_indexed");
    // only a review lives at #300: it resolves, and it is not a PR
    expect(reason(prUrl("acme/app", 300))).toBe("not_a_pr");
  });

  test("two PRs sharing a resolve key stay ambiguous", () => {
    const db = standardRepo();
    seedGithubPr(db, { repo: "acme/app", number: 400, files: [] });
    // a second PR item stored under the same URL (another service row): ambiguous, not guessed
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/app#400-dup",
      title: "dup",
      body: "",
      url: prUrl("acme/app", 400),
      canonicalUrl: prUrl("acme/app", 400),
      modifiedAt: NOW - DAY,
      metadata: {},
      syncedAt: NOW,
    });
    expect(() => buildPrereviewBrief(db, prUrl("acme/app", 400), NOW)).toThrow(PrereviewError);
  });
  test("one companion shared by two areas is reported once, at its strongest", () => {
    const db = seedDb();
    for (let i = 1; i <= 5; i++) {
      seedGithubPr(db, {
        number: i,
        files: ["a/x.ts", "b/y.ts", ...(i <= 4 ? ["CHANGELOG.md"] : [])],
      });
    }
    seedGithubPr(db, { number: TARGET, merged: false, files: ["a/x.ts", "b/y.ts"] });
    const b = buildPrereviewBrief(db, prUrl("acme/app", TARGET), NOW);
    expect(b.coChanges.filter((c) => c.companion === "CHANGELOG.md")).toHaveLength(1);
  });

  test("at most two reviews of one pull request are shown", () => {
    const db = standardRepo();
    for (let r = 1; r <= REVIEWS_PER_PR + 2; r++) {
      seedReview(db, {
        prNumber: 1,
        reviewId: r,
        state: "COMMENTED",
        body: `note ${String(r)}`,
        daysAgo: r,
      });
    }
    seedReview(db, { prNumber: 2, reviewId: 50, state: "COMMENTED", body: "other", daysAgo: 30 });
    const b = buildPrereviewBrief(db, prUrl("acme/app", TARGET), NOW);
    expect(b.reviewNotes?.filter((n) => n.pr.title === "Past 1")).toHaveLength(REVIEWS_PER_PR);
    expect(b.reviewNotes?.some((n) => n.pr.title === "Past 2")).toBe(true);
    expect(b.counts.reviewsMatched).toBe(REVIEWS_PER_PR + 3);
  });

  test("a Bitbucket repository (no merge time) uses the last update for recency, and says so", () => {
    const db = seedDb();
    for (let i = 1; i <= 4; i++) seedBitbucketPr(db, i, "MERGED", ["src/a.ts", "docs/a.md"]);
    seedBitbucketPr(db, 9, "OPEN", ["src/a.ts"]);
    const b = buildPrereviewBrief(db, "https://bitbucket.org/acme/app/pull-requests/9", NOW);
    expect(b.counts.historyUsed).toBe(4);
    expect(b.coChanges.map((c) => c.companion)).toEqual(["docs/a.md"]);
    expect(b.gaps.map((g) => g.detail).join("\n")).toContain("Bitbucket records no merge time");
  });
});
