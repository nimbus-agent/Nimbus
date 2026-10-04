/**
 * `runBenchCli` paths `bench-cli.test.ts` does not reach: the two refusals (no surface named, an
 * unknown surface), `--all` across the whole registry, the `--runs` fallbacks, the run options a
 * driver receives, a driver that throws a non-Error, and the git-sha default.
 *
 * Every driver is INJECTED. The registered drivers spawn gateways, start SQLite worker pools or
 * load an embedding model, so running one here would make this a benchmark rather than a test —
 * which is also why the registry's own one-line delegations stay uncovered by unit tests.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BenchCliDeps, runBenchCli } from "./bench-cli.ts";
import type { HistoryLine } from "./history-line.ts";
import { S3_STUB_REASON } from "./surfaces/bench-dashboard-first-paint.ts";
import { S5_STUB_REASON } from "./surfaces/bench-hitl-popup.ts";
import { S9_STUB_REASON } from "./surfaces/bench-llm-roundtrip.ts";
import { S7C_REFERENCE_ONLY_REASON } from "./surfaces/bench-rss-multi-agent.ts";
import type { BenchRunOptions } from "./types.ts";

type Overrides = NonNullable<BenchCliDeps["surfaceDriverOverrides"]>;
type Driver = NonNullable<Overrides["S1"]>;

let dir = "";
let historyPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bench-cli-cov-"));
  historyPath = join(dir, "history.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readLine(): HistoryLine {
  return JSON.parse(readFileSync(historyPath, "utf8").trim()) as HistoryLine;
}

/** Captures everything a run prints, so a refusal can be asserted to have printed ONLY its reason. */
function sinks(): {
  out: string[];
  err: string[];
  stdout: (s: string) => void;
  stderr: (s: string) => void;
} {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (s) => out.push(s), stderr: (s) => err.push(s) };
}

const ALL_SURFACES = [
  "S1",
  "S2-a",
  "S2-b",
  "S2-c",
  "S3",
  "S4",
  "S5",
  "S6-drive",
  "S6-gmail",
  "S6-github",
  "S7-a",
  "S7-b",
  "S7-c",
  "S9",
  "S10",
  "S11-a",
  "S11-b",
  ...[50, 500, 5000].flatMap((l) => [1, 8, 32, 64].map((b) => `S8-l${l}-b${b}`)),
];

describe("runBenchCli — refusals", () => {
  test("naming no surface refuses with exit 2, lists every registered surface, and records nothing", async () => {
    const io = sinks();
    const code = await runBenchCli(["--gha", "--runs", "1"], {
      runId: "no-surface",
      historyPath,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(2);
    expect(io.err).toHaveLength(1);
    expect(io.err[0]).toBe(
      `Pass --surface <id> or --all. Available surfaces: ${ALL_SURFACES.join(", ")}`,
    );
    expect(io.out).toEqual([]);
    expect(existsSync(historyPath)).toBe(false);
  });

  test("an unknown surface id aborts with exit 2 before any history is written", async () => {
    const io = sinks();
    const code = await runBenchCli(["--surface", "S99", "--gha"], {
      runId: "unknown-surface",
      historyPath,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(2);
    expect(io.err).toEqual(["Surface S99 has no driver registered yet (PR-B-2b work)."]);
    expect(io.out).toEqual([]);
    expect(existsSync(historyPath)).toBe(false);
  });
});

describe("runBenchCli — --all", () => {
  test("walks the whole registry: stubs and reference-only surfaces are recorded, every other surface is driven once", async () => {
    const driven: string[] = [];
    const sample: Driver = async () => [7];
    // A Proxy answers the override lookup for ANY id, so the whole registry runs through `sample`
    // and no real driver can be reached even if a surface is added later.
    const overrides = new Proxy({} as Overrides, {
      get: (_target, prop) => {
        if (typeof prop === "string") driven.push(prop);
        return sample;
      },
    });
    const io = sinks();
    const code = await runBenchCli(["--all", "--gha", "--runs", "1"], {
      runId: "all-surfaces",
      historyPath,
      fixtureCacheDir: dir,
      stdout: io.stdout,
      stderr: io.stderr,
      surfaceDriverOverrides: overrides,
    });
    expect(code).toBe(0);
    expect(io.err).toEqual([]);

    const stubs = new Set(["S3", "S5", "S9"]);
    const referenceOnly = new Set(["S2-c", "S7-c"]);
    expect(driven).toEqual(ALL_SURFACES.filter((id) => !stubs.has(id) && !referenceOnly.has(id)));

    const line = readLine();
    expect(Object.keys(line.surfaces)).toEqual(ALL_SURFACES);
    const surfaces = line.surfaces as Record<
      string,
      { samples_count: number; stub_reason?: string }
    >;
    expect(line.runner).toStartWith("gha-");
    // Each surface that is not driven records its OWN reason, exactly. S9 is both a stub and
    // reference-only: the stub reason must win, and a bare "is a string" check could not tell the
    // two apart. S7-c has a surface-specific reference-only reason; S2-c gets the generic one.
    const notDriven: Record<string, string> = {
      S3: S3_STUB_REASON,
      S5: S5_STUB_REASON,
      S9: S9_STUB_REASON,
      "S2-c": `reference-only — skipped on ${line.runner}`,
      "S7-c": S7C_REFERENCE_ONLY_REASON,
    };
    for (const [id, reason] of Object.entries(notDriven)) {
      expect(surfaces[id]).toEqual({ samples_count: 0, stub_reason: reason });
    }
    expect(io.out).toContain(`S9  stub: ${S9_STUB_REASON}`);
    expect(io.out).toContain(`S7-c  skipped: ${S7C_REFERENCE_ONLY_REASON}`);
    for (const id of driven) {
      expect(surfaces[id]?.samples_count).toBe(1);
      expect(surfaces[id]?.stub_reason).toBeUndefined();
    }
    expect(io.out).toHaveLength(ALL_SURFACES.length);
  });
});

describe("runBenchCli — run options", () => {
  const cases: Array<{ name: string; args: string[]; runs: number }> = [
    { name: "absent", args: [], runs: 5 },
    { name: "zero", args: ["--runs", "0"], runs: 5 },
    { name: "negative", args: ["--runs", "-3"], runs: 5 },
    { name: "non-numeric", args: ["--runs", "many"], runs: 5 },
    { name: "explicit", args: ["--runs", "2"], runs: 2 },
  ];
  for (const c of cases) {
    test(`--runs ${c.name} drives the surface ${c.runs} time(s)`, async () => {
      const seen: BenchRunOptions[] = [];
      const code = await runBenchCli(["--surface", "S6-drive", "--gha", ...c.args], {
        runId: `runs-${c.name}`,
        historyPath,
        stdout: () => {},
        surfaceDriverOverrides: {
          "S6-drive": async (opts) => {
            seen.push(opts);
            return [100];
          },
        },
      });
      expect(code).toBe(0);
      expect(seen).toHaveLength(c.runs);
      expect(seen.every((o) => o.runs === c.runs)).toBe(true);
      expect(readLine().surfaces["S6-drive"]?.samples_count).toBe(c.runs);
    });
  }

  test("a driver gets no cacheDir without --fixture-cache wiring, and the corpus only when it is a known tier", async () => {
    const runOpts: Array<{ cacheDir?: string }> = [];
    const opts: BenchRunOptions[] = [];
    const drive: Driver = async (o, r) => {
      opts.push(o);
      runOpts.push(r);
      return [1];
    };
    await runBenchCli(["--surface", "S6-drive", "--gha", "--runs", "1", "--corpus", "huge"], {
      runId: "no-cache",
      historyPath,
      stdout: () => {},
      surfaceDriverOverrides: { "S6-drive": drive },
    });
    await runBenchCli(["--surface", "S6-drive", "--gha", "--runs", "1", "--corpus", "medium"], {
      runId: "with-cache",
      historyPath,
      fixtureCacheDir: dir,
      stdout: () => {},
      surfaceDriverOverrides: { "S6-drive": drive },
    });
    // `toStrictEqual`, not `toEqual`: `{ cacheDir: undefined }` must not pass for `{}` — the
    // driver gets no key at all when there is no fixture cache.
    expect(runOpts).toStrictEqual([{}, { cacheDir: dir }]);
    expect("cacheDir" in (runOpts[0] ?? { cacheDir: "missing" })).toBe(false);
    expect(opts[0]?.corpus).toBeUndefined();
    expect("corpus" in (opts[0] ?? {})).toBe(false);
    expect(opts[1]?.corpus).toBe("medium");
  });
});

describe("runBenchCli — failure reporting and provenance", () => {
  test("a driver that rejects with a non-Error is recorded with its string form and the run continues", async () => {
    const io = sinks();
    const code = await runBenchCli(["--surface", "S2-a", "--gha", "--runs", "1"], {
      runId: "non-error",
      historyPath,
      stdout: io.stdout,
      stderr: io.stderr,
      surfaceDriverOverrides: { "S2-a": () => Promise.reject("disk on fire") },
    });
    expect(code).toBe(0);
    expect(readLine().surfaces["S2-a"]).toEqual({
      samples_count: 0,
      stub_reason: "driver-failed: bench surface S2-a failed on run 1/1: disk on fire",
    });
    expect(io.out).toEqual(["S2-a  failed: bench surface S2-a failed on run 1/1: disk on fire"]);
    expect(io.err).toEqual([
      "S2-a driver failed: bench surface S2-a failed on run 1/1: disk on fire",
    ]);
  });

  test("the history line's git sha comes from GITHUB_SHA, or reads 'unknown' without it", async () => {
    const saved = process.env["GITHUB_SHA"];
    const run = async (runId: string): Promise<string> => {
      rmSync(historyPath, { force: true });
      await runBenchCli(["--surface", "S3", "--gha"], { runId, historyPath, stdout: () => {} });
      return readLine().nimbus_git_sha;
    };
    try {
      delete process.env["GITHUB_SHA"];
      expect(await run("sha-absent")).toBe("unknown");
      process.env["GITHUB_SHA"] = "0123abcd";
      expect(await run("sha-present")).toBe("0123abcd");
    } finally {
      if (saved === undefined) delete process.env["GITHUB_SHA"];
      else process.env["GITHUB_SHA"] = saved;
    }
  });
});
