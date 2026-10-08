/**
 * The emitted-keys tables are DATA the census (PR A3) and reader disclosures (PR A2) trust. This
 * drives every real mapper with its richest input and asserts the canonical keys it emits are
 * EXACTLY the table's row — so the table cannot claim a key the code never writes, or miss one.
 */
import { describe, expect, test } from "bun:test";

import { gitlabMrMetadata } from "./_lib/gitlab/events.ts";
import { gitlabPipelineMetadata } from "./_lib/gitlab/pipelines.ts";
import { bitbucketPrMetadata } from "./bitbucket-sync.ts";
import { CANONICAL_CI_RUN_KEYS, CI_RUN_EMITTED_KEYS } from "./ci-run-meta.ts";
import { circleciPipelineMetadata } from "./circleci-sync.ts";
import { githubActionsRunMetadata } from "./github-actions-sync.ts";
import { extractPrMetadataForIndex } from "./github-sync.ts";
import { jenkinsBuildMetadata } from "./jenkins-sync.ts";
import { CANONICAL_PR_KEYS, PR_EMITTED_KEYS } from "./pr-meta.ts";

const ciKeys = (m: Record<string, unknown>): Set<string> =>
  new Set(Object.keys(m).filter((k) => (CANONICAL_CI_RUN_KEYS as readonly string[]).includes(k)));
const prKeys = (m: Record<string, unknown>): Set<string> =>
  new Set(Object.keys(m).filter((k) => (CANONICAL_PR_KEYS as readonly string[]).includes(k)));

describe("ci_run emitted keys == table", () => {
  test("github_actions", () => {
    const m = githubActionsRunMetadata(
      "a/b",
      {
        id: 1,
        name: "w",
        status: "completed",
        conclusion: "success",
        head_branch: "main",
        head_sha: "s",
      },
      0,
    );
    expect(ciKeys(m)).toEqual(new Set(CI_RUN_EMITTED_KEYS.github_actions));
  });
  test("circleci", () => {
    const m = circleciPipelineMetadata("a/b", "gh/a/b", {
      number: 1,
      id: "p",
      state: "errored",
      vcs: { branch: "main", revision: "s" },
    });
    expect(ciKeys(m)).toEqual(new Set(CI_RUN_EMITTED_KEYS.circleci));
  });
  test("gitlab", () => {
    const m = gitlabPipelineMetadata("a/b", { id: 1, status: "success", ref: "main", sha: "s" });
    expect(ciKeys(m)).toEqual(new Set(CI_RUN_EMITTED_KEYS.gitlab));
  });
  test("jenkins", () => {
    const m = jenkinsBuildMetadata("f/j", { number: 1, result: "SUCCESS", building: false });
    expect(ciKeys(m)).toEqual(new Set(CI_RUN_EMITTED_KEYS.jenkins));
  });
});

describe("pr emitted keys == table", () => {
  test("github", () => {
    const m = extractPrMetadataForIndex("a/b", {
      number: 1,
      state: "closed",
      merged: true,
      created_at: "2026-10-01T00:00:00Z",
      merged_at: "2026-10-02T00:00:00Z",
    });
    expect(prKeys(m)).toEqual(new Set(PR_EMITTED_KEYS.github));
  });
  test("bitbucket", () => {
    const m = bitbucketPrMetadata(
      "a/b",
      { id: 1, state: "MERGED", created_on: "2026-10-01T00:00:00Z" },
      "x",
    );
    expect(prKeys(m)).toEqual(new Set(PR_EMITTED_KEYS.bitbucket));
  });
  test("gitlab", () => {
    const opened = gitlabMrMetadata(
      {
        pathWithNamespace: "a/b",
        iid: 1,
        actionName: "opened",
        eventCreatedAt: "2026-10-01T00:00:00Z",
      },
      null,
    );
    const m = gitlabMrMetadata(
      {
        pathWithNamespace: "a/b",
        iid: 1,
        actionName: "accepted",
        eventCreatedAt: "2026-10-02T00:00:00Z",
      },
      opened,
    );
    expect(prKeys(m)).toEqual(new Set(PR_EMITTED_KEYS.gitlab));
  });
});
