import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "src", "index.ts");

const BUN_EXECUTABLE = process.execPath;

function run(env: NodeJS.ProcessEnv = {}): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(BUN_EXECUTABLE, ["run", CLI_ENTRY, "tui"], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: 5_000,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("nimbus tui fallback behavior", () => {
  test("TERM=dumb prints fallback notice and does not attempt Ink render", () => {
    const { stdout, stderr } = run({ TERM: "dumb" });
    const combined = stdout + stderr;
    expect(combined.length).toBeGreaterThan(0);
    expect(combined).not.toContain("Sub-Tasks");
  });

  test("non-TTY stdout falls back gracefully", () => {
    const { stdout, stderr } = run();
    const combined = stdout + stderr;
    expect(combined).not.toContain("Sub-Tasks");
  });

  test("CI=true prints fallback notice", () => {
    const { stdout, stderr } = run({ CI: "true" });
    const combined = stdout + stderr;
    expect(combined).not.toContain("Sub-Tasks");
  });
});
