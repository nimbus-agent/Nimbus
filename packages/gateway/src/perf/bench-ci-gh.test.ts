import { describe, expect, test } from "bun:test";

import { GhCli, type GhSpawnFn, type GhSpawnResult } from "./bench-ci-gh.ts";

interface CallLog {
  args: string[];
  cwd?: string;
}

function makeFakeRunner(scripted: GhSpawnResult[]): { spawn: GhSpawnFn; calls: CallLog[] } {
  const calls: CallLog[] = [];
  let i = 0;
  const spawn: GhSpawnFn = async (args: readonly string[], opts) => {
    calls.push({ args: [...args], ...(opts?.cwd !== undefined && { cwd: opts.cwd }) });
    const r = scripted[i] ?? { exitCode: 0, stdout: "", stderr: "" };
    i += 1;
    return r;
  };
  return { spawn, calls };
}

describe("GhCli", () => {
  test("runListRecentSuccesses: parses databaseId+headSha array and passes --limit", async () => {
    const { spawn, calls } = makeFakeRunner([
      {
        exitCode: 0,
        stdout: '[{"databaseId":42,"headSha":"aaa"},{"databaseId":41,"headSha":"bbb"}]\n',
        stderr: "",
      },
    ]);
    const gh = new GhCli({ spawn });
    const out = await gh.runListRecentSuccesses({
      workflow: "_perf.yml",
      branch: "main",
      limit: 5,
    });
    expect(out).toEqual([
      { databaseId: 42, headSha: "aaa" },
      { databaseId: 41, headSha: "bbb" },
    ]);
    expect(calls[0]?.args).toEqual([
      "run",
      "list",
      "--workflow",
      "_perf.yml",
      "--branch",
      "main",
      "--status",
      "success",
      "--limit",
      "5",
      "--json",
      "databaseId,headSha",
    ]);
  });

  test("runListRecentSuccesses: empty stdout → empty array (first run)", async () => {
    const { spawn } = makeFakeRunner([{ exitCode: 0, stdout: "\n", stderr: "" }]);
    const gh = new GhCli({ spawn });
    expect(
      await gh.runListRecentSuccesses({ workflow: "_perf.yml", branch: "main", limit: 5 }),
    ).toEqual([]);
  });

  test("runListRecentSuccesses: drops malformed entries missing databaseId/headSha", async () => {
    const { spawn } = makeFakeRunner([
      {
        exitCode: 0,
        stdout: '[{"databaseId":42,"headSha":"aaa"},{"headSha":"no-id"},{"databaseId":7}]\n',
        stderr: "",
      },
    ]);
    const gh = new GhCli({ spawn });
    expect(
      await gh.runListRecentSuccesses({ workflow: "_perf.yml", branch: "main", limit: 5 }),
    ).toEqual([{ databaseId: 42, headSha: "aaa" }]);
  });

  test("runDownloadArtifact: passes run-id, --name, --dir", async () => {
    const { spawn, calls } = makeFakeRunner([{ exitCode: 0, stdout: "", stderr: "" }]);
    const gh = new GhCli({ spawn });
    const fakeDir = "fake-prev-artifact-dir";
    await gh.runDownloadArtifact({ runId: 42, name: "perf-ubuntu-24.04-abc", dir: fakeDir });
    expect(calls[0]?.args).toEqual([
      "run",
      "download",
      "42",
      "--name",
      "perf-ubuntu-24.04-abc",
      "--dir",
      fakeDir,
    ]);
  });

  test("runDownloadArtifact: 'no artifact' message → returns false (artifact gone)", async () => {
    const { spawn } = makeFakeRunner([
      { exitCode: 1, stdout: "", stderr: "no artifact found matching name" },
    ]);
    const gh = new GhCli({ spawn });
    const ok = await gh.runDownloadArtifact({ runId: 42, name: "missing", dir: "fake-dir" });
    expect(ok).toBe(false);
  });

  test("retries 3× on transient failure with 5s backoff (mockable)", async () => {
    const { spawn, calls } = makeFakeRunner([
      { exitCode: 1, stdout: "", stderr: "API error: 500" },
      { exitCode: 1, stdout: "", stderr: "API error: 500" },
      { exitCode: 0, stdout: '[{"databaseId":999,"headSha":"z"}]\n', stderr: "" },
    ]);
    const gh = new GhCli({ spawn, sleep: async () => {} });
    const out = await gh.runListRecentSuccesses({
      workflow: "_perf.yml",
      branch: "main",
      limit: 5,
    });
    expect(out).toEqual([{ databaseId: 999, headSha: "z" }]);
    expect(calls.length).toBe(3);
  });

  test("rethrows after 3 failed attempts", async () => {
    const { spawn } = makeFakeRunner([
      { exitCode: 1, stdout: "", stderr: "API error: 500" },
      { exitCode: 1, stdout: "", stderr: "API error: 500" },
      { exitCode: 1, stdout: "", stderr: "API error: 500" },
    ]);
    const gh = new GhCli({ spawn, sleep: async () => {} });
    await expect(
      gh.runListRecentSuccesses({ workflow: "_perf.yml", branch: "main", limit: 5 }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("API error: 500"),
    });
  });

  test("prCommentList: parses JSON output", async () => {
    const { spawn } = makeFakeRunner([
      { exitCode: 0, stdout: '[{"id":"1","body":"hi"},{"id":"2","body":"bye"}]\n', stderr: "" },
    ]);
    const gh = new GhCli({ spawn });
    const out = await gh.prCommentList({ pr: 99 });
    expect(out).toEqual([
      { id: "1", body: "hi" },
      { id: "2", body: "bye" },
    ]);
  });

  test("prCommentCreate: passes --body-file path", async () => {
    const { spawn, calls } = makeFakeRunner([{ exitCode: 0, stdout: "", stderr: "" }]);
    const gh = new GhCli({ spawn });
    const fakeBodyFile = "fake-comment-body.md";
    await gh.prCommentCreate({ pr: 99, bodyFile: fakeBodyFile });
    expect(calls[0]?.args).toEqual(["pr", "comment", "99", "--body-file", fakeBodyFile]);
  });

  test("prCommentEdit: uses gh api PATCH to edit issue comment", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "bench-ci-gh-edit-"));
    try {
      const bodyFile = join(dir, "c.md");
      writeFileSync(bodyFile, "test body", "utf8");
      const { spawn, calls } = makeFakeRunner([{ exitCode: 0, stdout: "", stderr: "" }]);
      const gh = new GhCli({ spawn });
      await gh.prCommentEdit({ commentId: "42", bodyFile, repo: "owner/repo" });
      expect(calls[0]?.args[0]).toBe("api");
      expect(calls[0]?.args).toContain("/repos/owner/repo/issues/comments/42");
      expect(calls[0]?.args).toContain("--method");
      expect(calls[0]?.args).toContain("PATCH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
