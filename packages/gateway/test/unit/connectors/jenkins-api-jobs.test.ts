import { describe, expect, test } from "bun:test";

import {
  flattenJenkinsApiJobs,
  JENKINS_JOBS_API_TREE,
  type JenkinsApiJobNode,
  jenkinsApiJobNodeDisplayName,
} from "../../../src/connectors/jenkins-api-jobs.ts";

describe("JENKINS_JOBS_API_TREE", () => {
  test("matches the depth-4 tree spec used by nimbus-mcp-jenkins", () => {
    expect(JENKINS_JOBS_API_TREE).toBe(
      "jobs[name,fullname,url,jobs[name,fullname,url,jobs[name,fullname,url,jobs[name,fullname,url]]]]",
    );
  });
});

describe("jenkinsApiJobNodeDisplayName", () => {
  test("prefers fullName when present and non-empty", () => {
    expect(jenkinsApiJobNodeDisplayName({ fullName: "team/job", name: "job" })).toBe("team/job");
  });

  test("falls back to name when fullName missing", () => {
    expect(jenkinsApiJobNodeDisplayName({ name: "job" })).toBe("job");
  });

  test("falls back to name when fullName is empty string", () => {
    expect(jenkinsApiJobNodeDisplayName({ fullName: "", name: "job" })).toBe("job");
  });

  test("returns empty string when both missing", () => {
    expect(jenkinsApiJobNodeDisplayName({})).toBe("");
  });

  test("returns empty string when both are non-string types", () => {
    const n = { fullName: 42, name: null } as unknown as JenkinsApiJobNode;
    expect(jenkinsApiJobNodeDisplayName(n)).toBe("");
  });
});

describe("flattenJenkinsApiJobs", () => {
  test("undefined input is a no-op", () => {
    const out: { fullName: string; url?: string }[] = [];
    flattenJenkinsApiJobs(undefined, out);
    expect(out).toHaveLength(0);
  });

  test("empty array is a no-op", () => {
    const out: { fullName: string; url?: string }[] = [];
    flattenJenkinsApiJobs([], out);
    expect(out).toHaveLength(0);
  });

  test("flat node with url preserved", () => {
    const out: { fullName: string; url?: string }[] = [];
    flattenJenkinsApiJobs(
      [{ fullName: "build", url: "https://jenkins.example.com/job/build/" }],
      out,
    );
    expect(out).toEqual([{ fullName: "build", url: "https://jenkins.example.com/job/build/" }]);
  });

  test("flat node without url drops the url key", () => {
    const out: { fullName: string; url?: string }[] = [];
    flattenJenkinsApiJobs([{ fullName: "build" }], out);
    expect(out).toEqual([{ fullName: "build" }]);
  });

  test("nested folder structure flattens depth-first", () => {
    const tree: JenkinsApiJobNode[] = [
      {
        fullName: "folder1",
        jobs: [
          { fullName: "folder1/a" },
          {
            fullName: "folder1/sub",
            jobs: [{ fullName: "folder1/sub/x" }],
          },
        ],
      },
      { fullName: "top" },
    ];
    const out: { fullName: string; url?: string }[] = [];
    flattenJenkinsApiJobs(tree, out);
    expect(out.map((n) => n.fullName)).toEqual([
      "folder1",
      "folder1/a",
      "folder1/sub",
      "folder1/sub/x",
      "top",
    ]);
  });

  test("nodes with empty display name are filtered out but children still recursed", () => {
    const out: { fullName: string; url?: string }[] = [];
    flattenJenkinsApiJobs([{ jobs: [{ fullName: "kept" }] }, { fullName: "also-kept" }], out);
    expect(out.map((n) => n.fullName)).toEqual(["kept", "also-kept"]);
  });
});
