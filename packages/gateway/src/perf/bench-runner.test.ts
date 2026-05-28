import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBenchRunnerMain } from "./bench-runner.ts";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "bench-runner-test-"));
}

async function runBenchTest(
  args: string[],
): Promise<{ exitCode: number; historyContents: string }> {
  const dir = freshDir();
  const historyPath = join(dir, "history.jsonl");
  try {
    const exitCode = await runBenchRunnerMain([
      ...args,
      "--history",
      historyPath,
      "--fixture-cache",
      dir,
    ]);
    let historyContents = "";
    try {
      historyContents = readFileSync(historyPath, "utf8");
    } catch {
      // Absent file is acceptable — caller asserts on the contents.
    }
    return { exitCode, historyContents };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("runBenchRunnerMain", () => {
  test("generates a UUID, calls runBenchCli, and writes one history line", async () => {
    const { exitCode, historyContents } = await runBenchTest([
      "--surface",
      "S2-a",
      "--runs",
      "1",
      "--corpus",
      "small",
      "--gha",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(historyContents.trim());
    expect(parsed.run_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  test("--help prints usage and exits 0 without writing history", async () => {
    const dir = freshDir();
    const historyPath = join(dir, "history.jsonl");
    try {
      const lines: string[] = [];
      const exit = await runBenchRunnerMain(["--help"], {
        stdout: (s) => lines.push(s),
        historyPath,
      });
      expect(exit).toBe(0);
      expect(lines.join("\n")).toMatch(/Usage:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--protocol-confirmed allows --reference to proceed without interactive prompt", async () => {
    const { exitCode, historyContents } = await runBenchTest([
      "--surface",
      "S2-a",
      "--runs",
      "1",
      "--corpus",
      "small",
      "--reference",
      "--protocol-confirmed",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(historyContents.trim());
    expect(parsed.runner).toBe("reference-m1air");
    expect(parsed.reference_protocol_compliant).toBe(true);
  });

  test("--reference without --protocol-confirmed refuses to record (default still gates)", async () => {
    const { exitCode, historyContents } = await runBenchTest([
      "--surface",
      "S2-a",
      "--runs",
      "1",
      "--corpus",
      "small",
      "--reference",
    ]);
    expect(exitCode).not.toBe(0);
    expect(historyContents.trim()).toBe("");
  });

  test("--protocol-confirmed without --reference is a no-op (flag is ignored on non-reference runs)", async () => {
    const { exitCode, historyContents } = await runBenchTest([
      "--surface",
      "S2-a",
      "--runs",
      "1",
      "--corpus",
      "small",
      "--gha",
      "--protocol-confirmed",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(historyContents.trim());
    expect(parsed.runner).toMatch(/^gha-/);
    expect(parsed.reference_protocol_compliant).toBeUndefined();
  });
});
