import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBenchCiMain } from "./bench-ci.ts";
import { GhCli, type GhSpawnFn, type GhSpawnResult } from "./bench-ci-gh.ts";
import type { HistoryLine } from "./history-line.ts";

function writeHistory(dir: string, name: string, line: HistoryLine): string {
  const p = join(dir, name);
  writeFileSync(p, `${JSON.stringify(line)}\n`, "utf8");
  return p;
}

const passingLine: HistoryLine = {
  schema_version: 1,
  run_id: "x",
  timestamp: "2026-04-29T00:00:00Z",
  runner: "gha-ubuntu",
  os_version: "ubuntu-24.04.1",
  nimbus_git_sha: "abc",
  bun_version: "1.3.11",
  surfaces: { S1: { samples_count: 100, p95_ms: 800 } },
};

// S2-a is gate-class (the build-gating partition). S1 is now trend-class and no
// longer gates on shared runners, so the gating fixture must use a gate-class
// surface for an absolute-fail to drive a non-zero exit on a PR.
const failingLine: HistoryLine = {
  ...passingLine,
  surfaces: { "S2-a": { samples_count: 100, p95_ms: 12_000 } },
};

function spawnSequence(scripted: GhSpawnResult[]): {
  spawn: GhSpawnFn;
  calls: { args: readonly string[] }[];
} {
  const calls: { args: readonly string[] }[] = [];
  let i = 0;
  const spawn: GhSpawnFn = async (args) => {
    calls.push({ args: [...args] });
    const r = scripted[i] ?? { exitCode: 0, stdout: "", stderr: "" };
    i += 1;
    return r;
  };
  return { spawn, calls };
}

describe("runBenchCiMain", () => {
  test("first run on main: previous=null → exits 0, no comment posted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-ci-"));
    try {
      const currentPath = writeHistory(dir, "current.jsonl", passingLine);
      const { spawn, calls } = spawnSequence([{ exitCode: 0, stdout: "\n", stderr: "" }]);
      const exit = await runBenchCiMain(["--current", currentPath, "--runner", "gha-ubuntu"], {
        gh: new GhCli({ spawn, sleep: async () => {} }),
        env: { GITHUB_EVENT_NAME: "push" },
      });
      expect(exit).toBe(0);
      expect(calls.some((c) => c.args[0] === "pr" && c.args[1] === "comment")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gate-class absolute-fail on PR run → exits 1 + posts comment with marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-ci-"));
    try {
      const currentPath = writeHistory(dir, "current.jsonl", failingLine);
      const { spawn, calls } = spawnSequence([
        { exitCode: 0, stdout: '[{"databaseId":42,"headSha":"deadbeef"}]\n', stderr: "" }, // run list
        { exitCode: 0, stdout: "", stderr: "" }, // run download (artifact pre-written below)
        { exitCode: 0, stdout: "[]\n", stderr: "" }, // pr view (comment list)
        { exitCode: 0, stdout: "", stderr: "" }, // pr comment create
      ]);
      const prevDir = join(dir, "prev");
      const fs = await import("node:fs/promises");
      // The mocked `gh run download` writes nothing, so seed the per-sha artifact dir directly.
      await fs.mkdir(join(prevDir, "deadbeef"), { recursive: true });
      await fs.writeFile(
        join(prevDir, "deadbeef", "run-history.jsonl"),
        `${JSON.stringify(passingLine)}\n`,
        "utf8",
      );

      const exit = await runBenchCiMain(
        ["--current", currentPath, "--runner", "gha-ubuntu", "--prev-dir", prevDir],
        {
          gh: new GhCli({ spawn, sleep: async () => {} }),
          env: {
            GITHUB_EVENT_NAME: "pull_request",
            GITHUB_REPOSITORY: "asafgolombek/Nimbus",
            GITHUB_REF: "refs/pull/99/merge",
          },
        },
      );
      expect(exit).toBe(1);
      const commentCall = calls.find((c) => c.args[0] === "pr" && c.args[1] === "comment");
      expect(commentCall).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("workload absolute-fail does NOT exit 1 (S6-drive is trend-class, not gate-class)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-ci-"));
    try {
      const line: HistoryLine = {
        ...passingLine,
        surfaces: { "S6-drive": { samples_count: 5, throughput_per_sec: 999_999 } },
      };
      const currentPath = writeHistory(dir, "current.jsonl", line);
      const { spawn } = spawnSequence([{ exitCode: 0, stdout: "\n", stderr: "" }]);
      const exit = await runBenchCiMain(["--current", currentPath, "--runner", "gha-ubuntu"], {
        gh: new GhCli({ spawn, sleep: async () => {} }),
        env: { GITHUB_EVENT_NAME: "push" },
      });
      expect(exit).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("on PR with existing comment carrying our marker: edits instead of creating", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-ci-"));
    try {
      const currentPath = writeHistory(dir, "current.jsonl", passingLine);
      const { spawn, calls } = spawnSequence([
        { exitCode: 0, stdout: "\n", stderr: "" }, // run list — first run
        {
          exitCode: 0,
          stdout: '[{"id":"77","body":"<!-- nimbus-perf-delta:gha-ubuntu -->\\nold body"}]\n',
          stderr: "",
        },
        { exitCode: 0, stdout: "", stderr: "" },
      ]);
      const exit = await runBenchCiMain(["--current", currentPath, "--runner", "gha-ubuntu"], {
        gh: new GhCli({ spawn, sleep: async () => {} }),
        env: {
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REPOSITORY: "asafgolombek/Nimbus",
          GITHUB_REF: "refs/pull/99/merge",
        },
      });
      expect(exit).toBe(0);
      expect(calls.some((c) => c.args[0] === "api")).toBe(true);
      expect(
        calls.some(
          (c) => c.args[0] === "pr" && c.args[1] === "comment" && c.args.includes("--body-file"),
        ),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("baseline is the median over recent runs: a lone lucky-fast prior run does NOT cause a delta-fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-ci-"));
    try {
      // current S1 p95 = 1000ms. Recent baselines: one lucky-fast 400 + four typical ~800.
      // vs single fastest(400) → +150% (old behaviour) would delta-fail; vs median(800) → +25%
      // (under the effective 37.5% floor) passes. Proves the structural fix.
      const current: HistoryLine = {
        ...passingLine,
        surfaces: { S1: { samples_count: 100, p95_ms: 1000 } },
      };
      const currentPath = writeHistory(dir, "current.jsonl", current);

      const baselineP95 = [400, 800, 780, 800, 810];
      const runs = baselineP95.map((_, i) => ({ databaseId: 100 + i, headSha: `sha${i}` }));
      const prevDir = join(dir, "prev");
      const fs = await import("node:fs/promises");
      for (let i = 0; i < baselineP95.length; i += 1) {
        const shaDir = join(prevDir, `sha${i}`);
        await fs.mkdir(shaDir, { recursive: true });
        const line: HistoryLine = {
          ...passingLine,
          surfaces: { S1: { samples_count: 100, p95_ms: baselineP95[i] as number } },
        };
        await fs.writeFile(join(shaDir, "run-history.jsonl"), `${JSON.stringify(line)}\n`, "utf8");
      }

      const scripted = [
        { exitCode: 0, stdout: `${JSON.stringify(runs)}\n`, stderr: "" }, // run list
        ...baselineP95.map(() => ({ exitCode: 0, stdout: "", stderr: "" })), // 5 downloads
      ];
      const { spawn } = spawnSequence(scripted);
      const exit = await runBenchCiMain(
        ["--current", currentPath, "--runner", "gha-ubuntu", "--prev-dir", prevDir],
        { gh: new GhCli({ spawn, sleep: async () => {} }), env: { GITHUB_EVENT_NAME: "push" } },
      );
      expect(exit).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("artifact-name format passed to `gh run download` is `perf-<runner>-<sha>` (regression for C1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-ci-"));
    try {
      const currentPath = writeHistory(dir, "current.jsonl", passingLine);
      const { spawn, calls } = spawnSequence([
        { exitCode: 0, stdout: '[{"databaseId":42,"headSha":"deadbeef"}]\n', stderr: "" }, // run list
        { exitCode: 1, stdout: "", stderr: "no artifact found matching name" }, // run download
      ]);
      await runBenchCiMain(["--current", currentPath, "--runner", "gha-ubuntu"], {
        gh: new GhCli({ spawn, sleep: async () => {} }),
        env: { GITHUB_EVENT_NAME: "push" },
      });
      const downloadCall = calls.find((c) => c.args[0] === "run" && c.args[1] === "download");
      expect(downloadCall).toBeDefined();
      const nameIdx = downloadCall!.args.indexOf("--name");
      expect(nameIdx).toBeGreaterThanOrEqual(0);
      expect(downloadCall!.args[nameIdx + 1]).toBe("perf-gha-ubuntu-deadbeef");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gh run list failure → treated as first-run (null baseline), exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-ci-"));
    try {
      const currentPath = writeHistory(dir, "current.jsonl", passingLine);
      // 3× transient failure exhausts GhCli retries → runListRecentSuccesses throws → caught.
      const { spawn } = spawnSequence([
        { exitCode: 1, stdout: "", stderr: "API error: 500" },
        { exitCode: 1, stdout: "", stderr: "API error: 500" },
        { exitCode: 1, stdout: "", stderr: "API error: 500" },
      ]);
      const errs: string[] = [];
      const exit = await runBenchCiMain(["--current", currentPath, "--runner", "gha-ubuntu"], {
        gh: new GhCli({ spawn, sleep: async () => {} }),
        env: { GITHUB_EVENT_NAME: "push" },
        stderr: (s) => errs.push(s),
      });
      expect(exit).toBe(0);
      expect(errs.some((e) => e.includes("gh run list failed"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("per-artifact download failure is skipped (not fatal), remaining baseline empty → exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-ci-"));
    try {
      const currentPath = writeHistory(dir, "current.jsonl", passingLine);
      // run list returns one run; its download fails transiently (non-"no artifact") → throws →
      // resolveBaseline catches per-artifact and continues, leaving no usable baseline.
      const { spawn } = spawnSequence([
        { exitCode: 0, stdout: '[{"databaseId":1,"headSha":"s1"}]\n', stderr: "" },
        { exitCode: 1, stdout: "", stderr: "API error: 500" },
        { exitCode: 1, stdout: "", stderr: "API error: 500" },
        { exitCode: 1, stdout: "", stderr: "API error: 500" },
      ]);
      const errs: string[] = [];
      const exit = await runBenchCiMain(["--current", currentPath, "--runner", "gha-ubuntu"], {
        gh: new GhCli({ spawn, sleep: async () => {} }),
        env: { GITHUB_EVENT_NAME: "push" },
        stderr: (s) => errs.push(s),
      });
      expect(exit).toBe(0);
      expect(errs.some((e) => e.includes("run download (s1) failed"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("downloaded-but-unreadable baseline artifact is skipped → exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-ci-"));
    try {
      const currentPath = writeHistory(dir, "current.jsonl", passingLine);
      // Download reports success but the run-history.jsonl is never written (left absent), so
      // parseHistoryFile throws and the artifact is skipped.
      const { spawn } = spawnSequence([
        { exitCode: 0, stdout: '[{"databaseId":1,"headSha":"s1"}]\n', stderr: "" },
        { exitCode: 0, stdout: "", stderr: "" }, // download "succeeds" but writes nothing
      ]);
      const errs: string[] = [];
      const exit = await runBenchCiMain(
        ["--current", currentPath, "--runner", "gha-ubuntu", "--prev-dir", join(dir, "prev")],
        {
          gh: new GhCli({ spawn, sleep: async () => {} }),
          env: { GITHUB_EVENT_NAME: "push" },
          stderr: (s) => errs.push(s),
        },
      );
      expect(exit).toBe(0);
      expect(errs.some((e) => e.includes("baseline artifact (s1) unreadable"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
