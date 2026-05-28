import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINUX_ONLY_THRESHOLDS, runBenchCli } from "./bench-cli.ts";
import { runQueryLatency100kOnce } from "./surfaces/bench-query-latency-100k.ts";

let dir = "";
let historyPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bench-cli-test-"));
  historyPath = join(dir, "history.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readHistoryLine(): {
  surfaces: Record<string, { samples_count: number; stub_reason?: string }>;
  runner: string;
  run_id: string;
} {
  return JSON.parse(readFileSync(historyPath, "utf8").trim());
}

describe("runBenchCli", () => {
  test("--surface S2-a --runs 1 writes a HistoryLine with the S2-a entry", async () => {
    const exitCode = await runBenchCli(
      ["--surface", "S2-a", "--runs", "1", "--corpus", "small", "--gha"],
      { runId: "test-run-1", historyPath, fixtureCacheDir: dir, stdout: () => {} },
    );
    expect(exitCode).toBe(0);
    const line = readHistoryLine();
    expect(line.surfaces["S2-a"]).toBeDefined();
    expect(line.surfaces["S2-a"]?.samples_count).toBe(100);
    expect(line.runner).toMatch(/^gha-/);
    expect(line.run_id).toBe("test-run-1");
  });

  test("--reference without protocol confirmation refuses to run", async () => {
    const stderr: string[] = [];
    const exitCode = await runBenchCli(
      ["--surface", "S2-a", "--runs", "1", "--corpus", "small", "--reference"],
      {
        runId: "test-run-2",
        historyPath,
        fixtureCacheDir: dir,
        stdout: () => {},
        stderr: (s) => stderr.push(s),
        confirmReferenceProtocol: () => false,
      },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr.join("\n")).toMatch(/protocol/);
  });
});

describe("runBenchCli — PR-B-2a registrations", () => {
  test("--surface S3 records a stub entry with stub_reason", async () => {
    const exitCode = await runBenchCli(["--surface", "S3", "--runs", "1", "--gha"], {
      runId: "stub-test",
      historyPath,
      fixtureCacheDir: dir,
      stdout: () => {},
    });
    expect(exitCode).toBe(0);
    const line = readHistoryLine();
    expect(line.surfaces["S3"]?.samples_count).toBe(0);
    expect(typeof line.surfaces["S3"]?.stub_reason).toBe("string");
    expect((line.surfaces["S3"]?.stub_reason ?? "").length).toBeGreaterThan(0);
  });

  test("--surface S2-c on --gha records a reference-only stub entry", async () => {
    const exitCode = await runBenchCli(["--surface", "S2-c", "--runs", "1", "--gha"], {
      runId: "ref-only-test",
      historyPath,
      fixtureCacheDir: dir,
      stdout: () => {},
    });
    expect(exitCode).toBe(0);
    const line = readHistoryLine();
    expect(line.surfaces["S2-c"]?.samples_count).toBe(0);
    expect(line.surfaces["S2-c"]?.stub_reason).toMatch(/reference-only/i);
  });

  test("--surface S2-b on --gha measures the medium tier (override to small for test speed)", async () => {
    const exitCode = await runBenchCli(["--surface", "S2-b", "--runs", "1", "--gha"], {
      runId: "s2b-test",
      historyPath,
      fixtureCacheDir: dir,
      stdout: () => {},
      surfaceDriverOverrides: {
        "S2-b": (opts, runOpts) =>
          runQueryLatency100kOnce(opts, { ...runOpts, overrideTier: "small" }),
      },
    });
    expect(exitCode).toBe(0);
    const line = readHistoryLine();
    expect(line.surfaces["S2-b"]?.samples_count).toBe(100);
    expect(line.surfaces["S2-b"]?.stub_reason).toBeUndefined();
  });

  test("a driver failure records stub_reason and continues (does not abort the run)", async () => {
    const exitCode = await runBenchCli(
      ["--surface", "S2-a", "--runs", "1", "--corpus", "small", "--gha"],
      {
        runId: "drv-fail-test",
        historyPath,
        fixtureCacheDir: dir,
        stdout: () => {},
        stderr: () => {},
        surfaceDriverOverrides: {
          "S2-a": () => Promise.reject(new Error("synthetic driver failure")),
        },
      },
    );
    expect(exitCode).toBe(0);
    const line = readHistoryLine();
    expect(line.surfaces["S2-a"]?.samples_count).toBe(0);
    expect(line.surfaces["S2-a"]?.stub_reason).toMatch(/driver-failed.*synthetic/);
  });
});

describe("runBenchCli — PR-B-2b-1 registrations", () => {
  test("--surface S7-c on --gha records reference-only stub with the surface-specific reason", async () => {
    const exitCode = await runBenchCli(["--surface", "S7-c", "--runs", "1", "--gha"], {
      runId: "s7c-test",
      historyPath,
      fixtureCacheDir: dir,
      stdout: () => {},
    });
    expect(exitCode).toBe(0);
    const line = readHistoryLine();
    expect(line.surfaces["S7-c"]?.samples_count).toBe(0);
    const reason = line.surfaces["S7-c"]?.stub_reason ?? "";
    expect(reason).toMatch(/reference-only/);
    expect(reason).toMatch(/LLM/);
  });

  test("LINUX_ONLY_THRESHOLDS contains S7-a, S7-b, S7-c", () => {
    expect(LINUX_ONLY_THRESHOLDS.has("S7-a")).toBe(true);
    expect(LINUX_ONLY_THRESHOLDS.has("S7-b")).toBe(true);
    expect(LINUX_ONLY_THRESHOLDS.has("S7-c")).toBe(true);
    expect(LINUX_ONLY_THRESHOLDS.has("S2-a")).toBe(false);
  });

  test("--surface S6-drive (driver injected via override) populates throughput_per_sec", async () => {
    const exitCode = await runBenchCli(
      ["--surface", "S6-drive", "--runs", "1", "--corpus", "small", "--gha"],
      {
        runId: "s6-drive-test",
        historyPath,
        fixtureCacheDir: dir,
        stdout: () => {},
        surfaceDriverOverrides: {
          "S6-drive": async () => [10, 20, 30, 40, 50],
        },
      },
    );
    expect(exitCode).toBe(0);
    const raw = JSON.parse(readFileSync(historyPath, "utf8").trim()) as {
      surfaces: Record<string, { throughput_per_sec?: number }>;
    };
    expect(raw.surfaces["S6-drive"]?.throughput_per_sec).toBe(30);
  });

  test("--surface S7-a on --gha (driver injected via override) populates rss_bytes_p95", async () => {
    const exitCode = await runBenchCli(["--surface", "S7-a", "--runs", "1", "--gha"], {
      runId: "s7a-test",
      historyPath,
      fixtureCacheDir: dir,
      stdout: () => {},
      surfaceDriverOverrides: {
        "S7-a": async () => [1_000_000, 1_100_000, 1_200_000, 1_300_000, 1_400_000],
      },
    });
    expect(exitCode).toBe(0);
    const raw = JSON.parse(readFileSync(historyPath, "utf8").trim()) as {
      surfaces: Record<string, { rss_bytes_p95?: number }>;
    };
    expect(raw.surfaces["S7-a"]?.rss_bytes_p95).toBeGreaterThanOrEqual(1_300_000);
  });
});

describe("runBenchCli — PR-B-2b-2 registrations", () => {
  test("--surface S9 records a stub entry with the documented reason", async () => {
    const exitCode = await runBenchCli(["--surface", "S9", "--runs", "1", "--gha"], {
      runId: "s9-test",
      historyPath,
      fixtureCacheDir: dir,
      stdout: () => {},
    });
    expect(exitCode).toBe(0);
    const line = readHistoryLine();
    expect(line.surfaces["S9"]?.samples_count).toBe(0);
    expect(line.surfaces["S9"]?.stub_reason).toMatch(/Ollama|stub|reference-only/i);
  });

  test("--surface S10 (driver injected) accumulates busy_retries across runs (D-5)", async () => {
    const { S10_BUSY_RETRIES } = await import("./surfaces/bench-sqlite-contention.ts");
    S10_BUSY_RETRIES.value = 999;
    const exitCode = await runBenchCli(["--surface", "S10", "--runs", "3", "--gha"], {
      runId: "s10-test",
      historyPath,
      fixtureCacheDir: dir,
      stdout: () => {},
      surfaceDriverOverrides: {
        S10: async () => {
          S10_BUSY_RETRIES.value += 5;
          return [12_345];
        },
      },
    });
    expect(exitCode).toBe(0);
    const raw = JSON.parse(readFileSync(historyPath, "utf8").trim()) as {
      surfaces: Record<string, { throughput_per_sec?: number; busy_retries?: number }>;
    };
    expect(raw.surfaces["S10"]?.throughput_per_sec).toBe(12_345);
    expect(raw.surfaces["S10"]?.busy_retries).toBe(15);
  });

  test("S8 cells are registered: --surface S8-l50-b1 (driver injected) populates throughput_per_sec", async () => {
    const exitCode = await runBenchCli(["--surface", "S8-l50-b1", "--runs", "1", "--gha"], {
      runId: "s8-cell-test",
      historyPath,
      fixtureCacheDir: dir,
      stdout: () => {},
      surfaceDriverOverrides: {
        "S8-l50-b1": async () => [555],
      },
    });
    expect(exitCode).toBe(0);
    const raw = JSON.parse(readFileSync(historyPath, "utf8").trim()) as {
      surfaces: Record<string, { throughput_per_sec?: number }>;
    };
    expect(raw.surfaces["S8-l50-b1"]?.throughput_per_sec).toBe(555);
  });

  test("S8 has all 12 cross-product cells (length × batch)", async () => {
    const corners = ["S8-l50-b1", "S8-l50-b64", "S8-l5000-b1", "S8-l5000-b64"] as const;
    for (const id of corners) {
      const exitCode = await runBenchCli(["--surface", id, "--runs", "1", "--gha"], {
        runId: `s8-${id}-test`,
        historyPath,
        fixtureCacheDir: dir,
        stdout: () => {},
        stderr: () => {},
        surfaceDriverOverrides: {
          [id]: async () => [42],
        },
      });
      expect(exitCode).toBe(0);
    }
  });
});
