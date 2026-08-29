import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { GhCli, type GhSpawnFn } from "../../packages/gateway/src/perf/bench-ci-gh.ts";
import type { SloThreshold } from "../../packages/gateway/src/perf/slo-thresholds.ts";
import { detectDrift, isRunnerKind, parseLatestV2Line, runDriftCheckMain } from "./drift-check.ts";

/**
 * A synthetic threshold at a chosen relative floor with NO absolute floor, so these cases keep
 * exercising the percentage rule on its own.
 *
 * `detectDrift` takes the surface's own SLO now rather than a global constant. The hardcoded
 * 10 % it used to apply is what filed #1308 and #1309 against S11-a / S11-b, whose declared
 * floor is 40 % precisely because their spawn-dominated latency is runner noise.
 */
function sloAt(noiseFloorPct: number, noiseFloorAbs = 0): SloThreshold {
  return {
    surfaceId: "S1",
    gateClass: "trend",
    metric: "p95_ms",
    refMax: 1_000,
    ghaMax: 5_000,
    noiseFloorPct,
    noiseFloorAbs,
    noiseFloorAbsUnit: "ms",
  } as SloThreshold;
}

describe("detectDrift", () => {
  test("returns false when there is not enough history to fill the window", () => {
    expect(detectDrift([{ value: 100 }, { value: 100 }], sloAt(10))).toBeNull();
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
    expect(detectDrift(history, sloAt(10))).toBeNull();
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
    expect(detectDrift(history, sloAt(10))).not.toBeNull();
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
    expect(detectDrift(history, sloAt(10))).toBeNull();
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
    expect(detectDrift(history, sloAt(10))).toBeNull();
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
    expect(detectDrift(history, sloAt(10))).not.toBeNull();
  });

  test("honors a custom k and n", () => {
    const history = [
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 150 },
      { value: 150 },
    ];
    expect(detectDrift(history, sloAt(10), 3, 2)).not.toBeNull();
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
  // Sized against S1's REAL declared floor, which is what `detectDrift` now applies:
  // `noiseFloorPct: 25` OR `noiseFloorAbs: 300` ms as a percentage of the rolling median,
  // whichever is larger. At a 1000 ms baseline the absolute floor is the binding one (30 %),
  // so the drifting samples sit at 1600 ms (+60 %) -- unambiguously past both.
  //
  // The old fixture drifted 100 -> 130 (+30 %), which cleared the hardcoded 10 % this used to
  // apply but would NOT clear S1's own floor. That gap is the bug: the detector was four times
  // more sensitive than the surfaces it watched.
  const driftValue = (sha: string): number => (Number(sha.slice(4)) >= 11 ? 1_600 : 1_000);

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

describe("detectDrift — the #1308 / #1309 false positives", () => {
  /**
   * The real gha-ubuntu window that filed both issues, taken from the `perf-data` branch's
   * `dev/bench/data.js`. Read it before widening any floor again: the "regression" is the last
   * two samples, and they are the runner RETURNING TO NORMAL.
   *
   * Series median across all 495 recorded samples is ~311 ms. This window is a cluster of
   * unusually FAST runs (224-261), which drags the rolling MEDIAN down to 253 -- and 316 then
   * reads as +25 % against that depressed baseline. Nothing got slower.
   */
  const S11_A_WINDOW = [224, 249, 261, 253, 247, 333, 306, 316, 333, 341].map((v) => ({
    value: v,
  }));

  // S11-a / S11-b as actually declared: 40 % relative, 50 ms / 10 ms absolute.
  const S11_A = sloAt(40, 50);
  const S11_B = sloAt(40, 10);

  test("the shipped 10% floor fires on this window — the bug", () => {
    expect(detectDrift(S11_A_WINDOW, sloAt(10))).not.toBeNull();
  });

  test("the surface's OWN 40% floor does not", () => {
    expect(detectDrift(S11_A_WINDOW, S11_A)).toBeNull();
    expect(detectDrift(S11_A_WINDOW, S11_B)).toBeNull();
  });

  test("a real 2x regression still trips at the 40% floor", () => {
    // The floor must not be so wide that it stops detecting anything. Same baseline, doubled.
    const regressed = [
      ...[300, 305, 298, 302, 310, 295, 300].map((v) => ({ value: v })),
      ...[620, 640, 610].map((v) => ({ value: v })),
    ];
    expect(detectDrift(regressed, S11_A)).not.toBeNull();
  });

  test("the absolute floor binds when the baseline is small", () => {
    // 40% of 20ms is 8ms -- scheduler noise. `noiseFloorAbs: 50` raises the bar to 250%,
    // which is why the two floors are combined rather than the percentage used alone.
    const tiny = [
      ...Array.from({ length: 7 }, () => ({ value: 20 })),
      ...[40, 42, 41].map((v) => ({ value: v })),
    ];
    expect(detectDrift(tiny, sloAt(40))).not.toBeNull(); // 40% floor alone: +100% trips
    expect(detectDrift(tiny, S11_A)).toBeNull(); // with the 50ms absolute floor: does not
  });
});

describe("detectDrift reports the floor that ACTUALLY fired", () => {
  test("when the absolute floor binds, the reported floor exceeds noiseFloorPct", () => {
    // 40 % of a 20 ms median is 8 ms -- scheduler noise. `noiseFloorAbs: 50` raises the
    // effective bar to 250 %, and THAT is the number the filed issue must state. Reporting
    // the declared 40 % would send a reader to check a threshold the sample never faced.
    const history = [
      ...Array.from({ length: 7 }, () => ({ value: 20 })),
      ...[80, 82, 81].map((v) => ({ value: v })),
    ];
    const hit = detectDrift(history, sloAt(40, 50));
    expect(hit).not.toBeNull();
    expect(hit?.median).toBe(20);
    expect(hit?.effectiveFloorPct).toBe(250); // max(40, 50/20*100)
    expect(hit?.effectiveFloorPct).toBeGreaterThan(40);
  });

  test("when the relative floor binds, the reported floor IS noiseFloorPct", () => {
    const history = [
      ...Array.from({ length: 7 }, () => ({ value: 1_000 })),
      ...[1_600, 1_620, 1_610].map((v) => ({ value: v })),
    ];
    const hit = detectDrift(history, sloAt(40, 50));
    expect(hit?.effectiveFloorPct).toBe(40); // max(40, 50/1000*100 = 5)
    expect(hit?.current).toBe(1_610); // the sample that COMPLETED the run, not the first
  });
});
