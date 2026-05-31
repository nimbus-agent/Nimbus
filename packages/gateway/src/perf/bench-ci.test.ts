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

const failingLine: HistoryLine = {
  ...passingLine,
  surfaces: { S1: { samples_count: 100, p95_ms: 12_000 } },
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

  test("UX absolute-fail on PR run → exits 1 + posts comment with marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-ci-"));
    try {
      const currentPath = writeHistory(dir, "current.jsonl", failingLine);
      const { spawn, calls } = spawnSequence([
        { exitCode: 0, stdout: "42\n", stderr: "" },
        { exitCode: 0, stdout: "deadbeef\n", stderr: "" },
        { exitCode: 0, stdout: "", stderr: "" },
        { exitCode: 0, stdout: "[]\n", stderr: "" },
        { exitCode: 0, stdout: "", stderr: "" },
      ]);
      const prevDir = join(dir, "prev");
      const fs = await import("node:fs/promises");
      await fs.mkdir(prevDir, { recursive: true });
      await fs.writeFile(
        join(prevDir, "run-history.jsonl"),
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

  test("workload absolute-fail does NOT exit 1 (gated: false)", async () => {
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

  test("artifact-name format passed to `gh run download` is `perf-<runner>-<sha>` (regression for C1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-ci-"));
    try {
      const currentPath = writeHistory(dir, "current.jsonl", passingLine);
      const { spawn, calls } = spawnSequence([
        { exitCode: 0, stdout: "42\n", stderr: "" }, // gh run list → 42
        { exitCode: 0, stdout: "deadbeef\n", stderr: "" }, // gh run view 42 → headSha
        { exitCode: 1, stdout: "", stderr: "no artifact found matching name" },
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
});
