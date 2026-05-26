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
  test("runListLatestSuccess: returns databaseId of the most recent successful main run", async () => {
    const { spawn, calls } = makeFakeRunner([{ exitCode: 0, stdout: "12345\n", stderr: "" }]);
    const gh = new GhCli({ spawn });
    const out = await gh.runListLatestSuccess({ workflow: "_perf.yml", branch: "main" });
    expect(out).toBe(12345);
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
      "1",
      "--json",
      "databaseId",
      "--jq",
      ".[0].databaseId",
    ]);
  });

  test("runListLatestSuccess: empty stdout means no run found → returns null", async () => {
    const { spawn } = makeFakeRunner([{ exitCode: 0, stdout: "\n", stderr: "" }]);
    const gh = new GhCli({ spawn });
    expect(await gh.runListLatestSuccess({ workflow: "_perf.yml", branch: "main" })).toBeNull();
  });

  test("runDownloadArtifact: passes run-id, --name, --dir", async () => {
    const { spawn, calls } = makeFakeRunner([{ exitCode: 0, stdout: "", stderr: "" }]);
    const gh = new GhCli({ spawn });
    // The dir value is a fake argv string, never opened — `spawn` is mocked.
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
      { exitCode: 0, stdout: "999\n", stderr: "" },
    ]);
    const gh = new GhCli({ spawn, sleep: async () => {} });
    const out = await gh.runListLatestSuccess({ workflow: "_perf.yml", branch: "main" });
    expect(out).toBe(999);
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
      gh.runListLatestSuccess({ workflow: "_perf.yml", branch: "main" }),
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
    // bodyFile is a fake argv string, never read — `spawn` is mocked.
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
