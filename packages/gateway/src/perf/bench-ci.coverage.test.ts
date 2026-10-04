/**
 * `runBenchCiMain` paths `bench-ci.test.ts` does not reach: argument and history-file refusals, the
 * GitHub step summary, the PR-number gate on the comment upsert, an upsert that fails, a `gh` that
 * rejects with a non-Error, and reading the process environment when no `env` is injected.
 *
 * Every run passes `tmpDir`, so the baseline and comment scratch directories land in this test's
 * own temp dir rather than the shared OS temp root.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBenchCiMain } from "./bench-ci.ts";
import { GhCli, type GhSpawnFn, type GhSpawnResult } from "./bench-ci-gh.ts";
import type { HistoryLine } from "./history-line.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bench-ci-cov-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const line: HistoryLine = {
  schema_version: 2,
  run_id: "cov",
  timestamp: "2026-04-29T00:00:00Z",
  runner: "gha-ubuntu",
  os_version: "ubuntu-24.04.1",
  nimbus_git_sha: "abc",
  bun_version: "1.3.11",
  surfaces: { "S2-a": { samples_count: 100, p95_ms: 20 } },
};

function writeCurrent(content = `${JSON.stringify(line)}\n`): string {
  const p = join(dir, "current.jsonl");
  writeFileSync(p, content, "utf8");
  return p;
}

/** A gh fake: each call takes the next scripted result; the last one repeats. */
function fakeGh(results: Array<GhSpawnResult | (() => Promise<GhSpawnResult>)>): {
  gh: GhCli;
  calls: string[][];
} {
  const calls: string[][] = [];
  let i = 0;
  const spawn: GhSpawnFn = async (args) => {
    calls.push([...args]);
    const r = results[Math.min(i, results.length - 1)];
    i += 1;
    if (r === undefined) throw new Error("no scripted result");
    return typeof r === "function" ? r() : r;
  };
  return { gh: new GhCli({ spawn, sleep: async () => {} }), calls };
}

const FIRST_RUN: GhSpawnResult = { exitCode: 0, stdout: "\n", stderr: "" };

describe("runBenchCiMain — refusals", () => {
  test("--current is required", async () => {
    const { gh, calls } = fakeGh([FIRST_RUN]);
    await expect(
      runBenchCiMain(["--runner", "gha-ubuntu"], { gh, env: {}, tmpDir: dir }),
    ).rejects.toThrow("--current <path> is required");
    expect(calls).toEqual([]);
  });

  test("--runner is required", async () => {
    const { gh, calls } = fakeGh([FIRST_RUN]);
    await expect(
      runBenchCiMain(["--current", writeCurrent()], { gh, env: {}, tmpDir: dir }),
    ).rejects.toThrow("--runner <runner-id> is required");
    expect(calls).toEqual([]);
  });

  test("an empty current history file is refused before any gh call", async () => {
    const current = writeCurrent("\n   \n");
    const { gh, calls } = fakeGh([FIRST_RUN]);
    await expect(
      runBenchCiMain(["--current", current, "--runner", "gha-ubuntu"], {
        gh,
        env: {},
        tmpDir: dir,
      }),
    ).rejects.toThrow(`history file is empty: ${current}`);
    expect(calls).toEqual([]);
  });
});

describe("runBenchCiMain — reporting", () => {
  test("appends the comment body to GITHUB_STEP_SUMMARY, keeping what is already there", async () => {
    const summary = join(dir, "summary.md");
    writeFileSync(summary, "earlier step\n", "utf8");
    const out: string[] = [];
    const { gh } = fakeGh([FIRST_RUN]);
    const exit = await runBenchCiMain(["--current", writeCurrent(), "--runner", "gha-ubuntu"], {
      gh,
      env: { GITHUB_EVENT_NAME: "push", GITHUB_STEP_SUMMARY: summary },
      stdout: (s) => out.push(s),
      tmpDir: dir,
    });
    expect(exit).toBe(0);
    expect(out).toHaveLength(1);
    expect(readFileSync(summary, "utf8")).toBe(`earlier step\n${out[0]}\n`);
  });

  test("a pull_request event with no GITHUB_REF, or a non-PR ref, posts no comment", async () => {
    for (const env of [
      { GITHUB_EVENT_NAME: "pull_request" },
      { GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/heads/main" },
    ]) {
      const { gh, calls } = fakeGh([FIRST_RUN]);
      const exit = await runBenchCiMain(["--current", writeCurrent(), "--runner", "gha-ubuntu"], {
        gh,
        env,
        stdout: () => {},
        tmpDir: dir,
      });
      expect(exit).toBe(0);
      // Only the baseline lookup ran — never `pr view` / `pr comment` / `api`.
      expect(calls.map((c) => `${c[0]} ${c[1]}`)).toEqual(["run list"]);
    }
  });

  test("a failed comment upsert is reported and does not change the exit code", async () => {
    const err: string[] = [];
    const { gh, calls } = fakeGh([FIRST_RUN, { exitCode: 1, stdout: "", stderr: "API down" }]);
    const exit = await runBenchCiMain(["--current", writeCurrent(), "--runner", "gha-ubuntu"], {
      gh,
      env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/7/merge" },
      stdout: () => {},
      stderr: (s) => err.push(s),
      tmpDir: dir,
    });
    expect(exit).toBe(0);
    expect(err).toEqual([
      "bench-ci: comment upsert failed: gh pr view failed after 3 attempts: API down",
    ]);
    expect(calls.filter((c) => c[0] === "pr" && c[1] === "view")).toHaveLength(3);
    expect(calls.some((c) => c[0] === "pr" && c[1] === "comment")).toBe(false);
  });

  test("a non-Error from gh is reported in its string form, for the upsert and the baseline", async () => {
    const err: string[] = [];
    const { gh } = fakeGh([FIRST_RUN, () => Promise.reject("rate limited")]);
    await runBenchCiMain(["--current", writeCurrent(), "--runner", "gha-ubuntu"], {
      gh,
      env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/7/merge" },
      stdout: () => {},
      stderr: (s) => err.push(s),
      tmpDir: dir,
    });
    expect(err).toEqual(["bench-ci: comment upsert failed: rate limited"]);

    const err2: string[] = [];
    const { gh: gh2 } = fakeGh([() => Promise.reject("offline")]);
    const exit = await runBenchCiMain(["--current", writeCurrent(), "--runner", "gha-ubuntu"], {
      gh: gh2,
      env: { GITHUB_EVENT_NAME: "push" },
      stdout: () => {},
      stderr: (s) => err2.push(s),
      tmpDir: dir,
    });
    expect(exit).toBe(0);
    expect(err2).toEqual(["bench-ci: gh run list failed: offline; treating as first-run"]);
  });

  test("with no env injected, the process environment decides the summary and the event", async () => {
    const keys = ["GITHUB_EVENT_NAME", "GITHUB_STEP_SUMMARY", "GITHUB_REF"] as const;
    const saved = keys.map((k) => [k, process.env[k]] as const);
    const summary = join(dir, "process-env-summary.md");
    try {
      process.env["GITHUB_EVENT_NAME"] = "push";
      process.env["GITHUB_STEP_SUMMARY"] = summary;
      delete process.env["GITHUB_REF"];
      const out: string[] = [];
      const { gh, calls } = fakeGh([FIRST_RUN]);
      const exit = await runBenchCiMain(["--current", writeCurrent(), "--runner", "gha-ubuntu"], {
        gh,
        stdout: (s) => out.push(s),
        tmpDir: dir,
      });
      expect(exit).toBe(0);
      expect(readFileSync(summary, "utf8")).toBe(`${out[0]}\n`);
      expect(calls.map((c) => c[0])).toEqual(["run"]);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
