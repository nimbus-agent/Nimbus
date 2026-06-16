import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { GhCli, type GhSpawnFn } from "../../packages/gateway/src/perf/bench-ci-gh.ts";
import { detectDrift, isRunnerKind, parseLatestV2Line, runDriftCheckMain } from "./drift-check.ts";

describe("detectDrift", () => {
  test("returns false when there is not enough history to fill the window", () => {
    expect(detectDrift([{ value: 100 }, { value: 100 }], 10)).toBe(false);
  });

  test("a single late spike does NOT trip drift (needs n consecutive worse samples)", () => {
    const history = [
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 200 },
    ];
    expect(detectDrift(history, 10)).toBe(false);
  });

  test("a sustained regression (n consecutive samples worse than the rolling median) trips drift", () => {
    const history = [
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 200 },
      { value: 200 },
      { value: 200 },
    ];
    expect(detectDrift(history, 10)).toBe(true);
  });

  test("worse-but-within-the-noise-floor does not trip drift", () => {
    const history = [
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 105 },
      { value: 105 },
      { value: 105 },
    ];
    expect(detectDrift(history, 10)).toBe(false);
  });

  test("a worse sample that breaks the consecutive run resets the counter", () => {
    const history = [
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 200 },
      { value: 200 },
      { value: 100 },
      { value: 200 },
    ];
    expect(detectDrift(history, 10)).toBe(false);
  });

  test("the rolling median is over the last k samples, not the whole history", () => {
    const history = [
      { value: 9000 },
      { value: 9000 },
      { value: 9000 },
      { value: 9000 },
      { value: 9000 },
      { value: 9000 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 200 },
      { value: 200 },
      { value: 200 },
    ];
    expect(detectDrift(history, 10)).toBe(true);
  });

  test("honors a custom k and n", () => {
    const history = [
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 150 },
      { value: 150 },
    ];
    expect(detectDrift(history, 10, 3, 2)).toBe(true);
  });
});

describe("parseLatestV2Line", () => {
  const tmp = mkdtempSync(join(tmpdir(), "drift-parse-"));
  function writeFile(contents: string): string {
    const p = join(tmp, `h-${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(p, contents, "utf8");
    return p;
  }
  function v2(p95: number): string {
    return JSON.stringify({
      schema_version: 2,
      run_id: "r",
      timestamp: "2026-06-16T00:00:00Z",
      runner: "gha-ubuntu",
      os_version: "ubuntu-24.04",
      nimbus_git_sha: "abc",
      bun_version: "1.3.14",
      surfaces: { S1: { samples_count: 301, p95_ms: p95 } },
    });
  }
  const v1 = JSON.stringify({
    schema_version: 1,
    surfaces: { S1: { samples_count: 1, p95_ms: 1 } },
  });

  test("returns null when the file is unreadable", () => {
    expect(parseLatestV2Line(join(tmpdir(), "definitely-missing-drift.jsonl"))).toBeNull();
  });

  test("returns the last v2 line", () => {
    const line = parseLatestV2Line(writeFile(`${v2(100)}\n${v2(250)}\n`));
    expect(line?.surfaces["S1"]?.p95_ms).toBe(250);
  });

  test("returns null when the last line is schema_version 1 (non-comparable)", () => {
    expect(parseLatestV2Line(writeFile(`${v2(100)}\n${v1}\n`))).toBeNull();
  });

  test("returns null when the last line is malformed JSON", () => {
    expect(parseLatestV2Line(writeFile(`${v2(100)}\n{not json\n`))).toBeNull();
  });

  test("returns null on an empty file", () => {
    expect(parseLatestV2Line(writeFile("\n  \n"))).toBeNull();
  });
});

describe("runDriftCheckMain", () => {
  // 14 runs, oldest-first sha-0..sha-13. The newest 3 (>=11) regress to 130 over
  // a stable 100 baseline → a sustained drift on S1 (and only S1).
  const shas = Array.from({ length: 14 }, (_, i) => `sha-${i}`);
  const driftValue = (sha: string): number => (Number(sha.slice(4)) >= 11 ? 130 : 100);

  function v2Line(p95: number): string {
    return JSON.stringify({
      schema_version: 2,
      run_id: "r",
      timestamp: "2026-06-16T00:00:00Z",
      runner: "gha-ubuntu",
      os_version: "ubuntu-24.04",
      nimbus_git_sha: "abc",
      bun_version: "1.3.14",
      surfaces: { S1: { samples_count: 301, p95_ms: p95 } },
    });
  }

  function fakeGh(opts: {
    valueForSha: (sha: string) => number;
    existingIssues: { number: number; title: string }[];
    calls: string[][];
  }): GhCli {
    const spawn: GhSpawnFn = async (args) => {
      const a = [...args];
      opts.calls.push(a);
      if (a[0] === "run" && a[1] === "list") {
        const newestFirst = [...shas]
          .reverse()
          .map((sha, i) => ({ databaseId: 1000 + i, headSha: sha }));
        return { exitCode: 0, stdout: `${JSON.stringify(newestFirst)}\n`, stderr: "" };
      }
      if (a[0] === "run" && a[1] === "download") {
        const dir = a[a.indexOf("--dir") + 1] as string;
        const sha = basename(dir);
        writeFileSync(join(dir, "run-history.jsonl"), `${v2Line(opts.valueForSha(sha))}\n`, "utf8");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (a[0] === "issue" && a[1] === "list") {
        return { exitCode: 0, stdout: `${JSON.stringify(opts.existingIssues)}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    return new GhCli({ spawn, sleep: async () => {} });
  }

  test("files exactly one issue for a sustained-drifting surface with no open issue", async () => {
    const calls: string[][] = [];
    const gh = fakeGh({ valueForSha: driftValue, existingIssues: [], calls });
    const tmpDir = mkdtempSync(join(tmpdir(), "drift-wrap-"));
    await runDriftCheckMain({ gh, runner: "gha-ubuntu", tmpDir, stderr: () => {} });
    const creates = calls.filter((c) => c[0] === "issue" && c[1] === "create");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain("perf: sustained drift detected on S1 (gha-ubuntu)");
  });

  test("does NOT create when an open issue already exists (create-only)", async () => {
    const calls: string[][] = [];
    const gh = fakeGh({
      valueForSha: driftValue,
      existingIssues: [{ number: 7, title: "perf: sustained drift detected on S1 (gha-ubuntu)" }],
      calls,
    });
    const tmpDir = mkdtempSync(join(tmpdir(), "drift-wrap-"));
    await runDriftCheckMain({ gh, runner: "gha-ubuntu", tmpDir, stderr: () => {} });
    expect(calls.filter((c) => c[0] === "issue" && c[1] === "create")).toHaveLength(0);
  });

  test("a flat (non-drifting) series files nothing and never lists issues", async () => {
    const calls: string[][] = [];
    const gh = fakeGh({ valueForSha: () => 100, existingIssues: [], calls });
    const tmpDir = mkdtempSync(join(tmpdir(), "drift-wrap-"));
    await runDriftCheckMain({ gh, runner: "gha-ubuntu", tmpDir, stderr: () => {} });
    expect(calls.filter((c) => c[0] === "issue")).toHaveLength(0);
  });
});

describe("isRunnerKind", () => {
  test("accepts every declared RunnerKind", () => {
    for (const r of ["reference-m1air", "gha-ubuntu", "gha-macos", "gha-windows", "local-dev"]) {
      expect(isRunnerKind(r)).toBe(true);
    }
  });

  test("rejects an unknown runner value", () => {
    expect(isRunnerKind("m1-air")).toBe(false);
    expect(isRunnerKind("")).toBe(false);
  });
});
