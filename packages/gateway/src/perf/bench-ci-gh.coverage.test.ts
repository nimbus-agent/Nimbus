/**
 * `GhCli` paths `bench-ci-gh.test.ts` does not reach: the constructor defaults, the default backoff
 * sleep, the exit-code fallback when `gh` prints nothing, non-object JSON entries, and a spawn that
 * rejects with something other than an `Error`.
 *
 * Every call injects `spawn`. The default spawn runs the real `gh` binary — which GitHub-hosted
 * runners have installed and authenticated — so exercising it here would make a live GitHub API
 * call from a unit test; only its construction is covered.
 */
import { describe, expect, test } from "bun:test";
import { GhCli, type GhSpawnFn, type GhSpawnResult } from "./bench-ci-gh.ts";

function scripted(results: GhSpawnResult[]): { spawn: GhSpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const spawn: GhSpawnFn = async (args) => {
    calls.push([...args]);
    const r = results[Math.min(i, results.length - 1)];
    i += 1;
    if (r === undefined) throw new Error("scripted spawn has no results");
    return r;
  };
  return { spawn, calls };
}

describe("GhCli — defaults", () => {
  test("with no maxAttempts or backoffMs, a failing call is tried 3 times with a 5 s backoff between tries", async () => {
    const { spawn, calls } = scripted([{ exitCode: 1, stdout: "", stderr: "HTTP 502" }]);
    const sleeps: number[] = [];
    // Only spawn and sleep are injected, so the attempt count and the backoff are the defaults.
    const gh = new GhCli({
      spawn,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(gh.issueList({ label: "perf-drift" })).rejects.toThrow(
      "gh issue list failed after 3 attempts: HTTP 502",
    );
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([5_000, 5_000]);
  });

  test("constructing with no options at all does not throw", () => {
    // `bench-ci.ts`'s entry point builds a GhCli unconditionally, before it knows whether any gh
    // call is needed, so construction must not depend on gh being installed. Nothing here calls a
    // method: the default spawn runs the real `gh`.
    expect(() => new GhCli()).not.toThrow();
  });
});

describe("GhCli — retries", () => {
  test("without an injected sleep, the default backoff still retries a transient failure", async () => {
    const { spawn, calls } = scripted([
      { exitCode: 1, stdout: "", stderr: "HTTP 502" },
      { exitCode: 0, stdout: '[{"number":3,"title":"drift"}]', stderr: "" },
    ]);
    const gh = new GhCli({ spawn, backoffMs: 0 });
    await expect(gh.issueList({ label: "perf-drift" })).resolves.toEqual([
      { number: 3, title: "drift" },
    ]);
    expect(calls).toHaveLength(2);
  });

  test("a failure with an empty stderr is reported by its exit code, after maxAttempts", async () => {
    const { spawn, calls } = scripted([{ exitCode: 4, stdout: "", stderr: "" }]);
    const sleeps: number[] = [];
    const gh = new GhCli({
      spawn,
      maxAttempts: 2,
      backoffMs: 750,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(gh.issueList({ label: "perf-drift" })).rejects.toThrow(
      "gh issue list failed after 2 attempts: gh exited 4",
    );
    expect(calls).toHaveLength(2);
    // One backoff BETWEEN the two attempts, none after the last.
    expect(sleeps).toEqual([750]);
  });
});

describe("GhCli — output parsing", () => {
  test("non-object entries in a JSON array are dropped, objects are kept", async () => {
    const { spawn } = scripted([
      {
        exitCode: 0,
        stdout: '[null, 7, "x", [1], {"number":5,"title":"kept"}, true]',
        stderr: "",
      },
    ]);
    await expect(new GhCli({ spawn }).issueList({ label: "l" })).resolves.toEqual([
      { number: 5, title: "kept" },
    ]);
  });

  test("prCommentList on an empty stdout is an empty list, not a JSON parse error", async () => {
    const { spawn, calls } = scripted([{ exitCode: 0, stdout: "  \n", stderr: "" }]);
    await expect(new GhCli({ spawn }).prCommentList({ pr: 12 })).resolves.toEqual([]);
    expect(calls[0]).toEqual(["pr", "view", "12", "--json", "comments", "--jq", ".comments"]);
  });
});

describe("GhCli — runDownloadArtifact with a spawn that rejects a non-Error", () => {
  test("a non-Error rejection naming a missing artifact still reads as 'artifact gone'", async () => {
    const spawn: GhSpawnFn = () => Promise.reject("no artifact found for run 42");
    const gh = new GhCli({ spawn, sleep: async () => {} });
    await expect(gh.runDownloadArtifact({ runId: 42, name: "perf-x", dir: "d" })).resolves.toBe(
      false,
    );
  });

  test("any other non-Error rejection propagates unchanged", async () => {
    const spawn: GhSpawnFn = () => Promise.reject("socket hang up");
    const gh = new GhCli({ spawn, sleep: async () => {} });
    let caught: unknown;
    try {
      await gh.runDownloadArtifact({ runId: 42, name: "perf-x", dir: "d" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe("socket hang up");
  });
});
