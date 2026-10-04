/**
 * The interrupted-run record `runBenchRunnerMain` installs for the duration of a run.
 *
 * The real handler ends in `process.exit(130)`, so it is never driven by an actual signal here (and
 * never via `process.emit`, which would also fire every OTHER SIGINT listener in this process). The
 * test calls only the listener this run added, with `process.exit` stubbed for that one call.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBenchRunnerMain } from "./bench-runner.ts";
import type { HistoryLine } from "./history-line.ts";

type SignalListener = (signal: NodeJS.Signals) => void;

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bench-runner-cov-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs `listener` with `process.exit` recorded instead of performed. */
function invokeWithoutExiting(listener: SignalListener, signal: NodeJS.Signals): unknown[] {
  const realExit = process.exit;
  const codes: unknown[] = [];
  process.exit = ((code?: number) => {
    codes.push(code);
  }) as unknown as typeof process.exit;
  try {
    listener(signal);
  } finally {
    process.exit = realExit;
  }
  return codes;
}

describe("runBenchRunnerMain — interrupted runs", () => {
  test("a signal mid-run records an incomplete line carrying the run's own id and runner", async () => {
    const historyPath = join(dir, "history.jsonl");
    const savedSha = process.env["GITHUB_SHA"];
    const before = {
      SIGINT: new Set(process.listeners("SIGINT")),
      SIGTERM: new Set(process.listeners("SIGTERM")),
    };
    const added = (signal: "SIGINT" | "SIGTERM"): SignalListener[] =>
      process.listeners(signal).filter((l) => !before[signal].has(l)) as SignalListener[];
    try {
      const running = runBenchRunnerMain(["--surface", "S3", "--gha", "--history", historyPath], {
        stdout: () => {},
      });
      // The handler is installed synchronously, before the first await inside the run.
      const [onInt] = added("SIGINT");
      const [onTerm] = added("SIGTERM");
      expect(onInt).toBeDefined();
      expect(onTerm).toBe(onInt);

      process.env["GITHUB_SHA"] = "feedface";
      expect(invokeWithoutExiting(onInt as SignalListener, "SIGINT")).toEqual([130]);
      delete process.env["GITHUB_SHA"];
      expect(invokeWithoutExiting(onTerm as SignalListener, "SIGTERM")).toEqual([130]);

      expect(await running).toBe(0);
      // The run's `finally` takes the handler back off both signals.
      expect(added("SIGINT")).toEqual([]);
      expect(added("SIGTERM")).toEqual([]);

      const lines = readFileSync(historyPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as HistoryLine);
      expect(lines).toHaveLength(3);
      const [byInt, byTerm, complete] = lines as [HistoryLine, HistoryLine, HistoryLine];
      expect(complete.incomplete).toBeUndefined();
      expect(complete.surfaces["S3"]?.samples_count).toBe(0);
      for (const [rec, signal, sha] of [
        [byInt, "SIGINT", "feedface"],
        [byTerm, "SIGTERM", "unknown"],
      ] as const) {
        expect(rec.incomplete).toBe(true);
        expect(rec.incomplete_reason).toBe(`interrupted-by-${signal}`);
        expect(rec.run_id).toBe(complete.run_id);
        expect(rec.runner).toBe(complete.runner);
        expect(rec.nimbus_git_sha).toBe(sha);
        expect(rec.bun_version).toBe(Bun.version);
        expect(rec.os_version).toBe(`${process.platform} ${process.arch}`);
        expect(rec.surfaces).toEqual({});
      }
    } finally {
      if (savedSha === undefined) delete process.env["GITHUB_SHA"];
      else process.env["GITHUB_SHA"] = savedSha;
    }
  });

  test("-h prints the usage text and runs nothing", async () => {
    const out: string[] = [];
    const historyPath = join(dir, "history.jsonl");
    const code = await runBenchRunnerMain(["-h", "--surface", "S3"], {
      stdout: (s) => out.push(s),
      historyPath,
    });
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toStartWith("nimbus bench — perf bench harness");
    expect(out[0]).toContain("--protocol-confirmed");
    // Had -h fallen through, the S3 stub run would have written its history line here.
    expect(existsSync(historyPath)).toBe(false);
  });
});
