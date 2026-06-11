import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "src", "index.ts");

const BUN_EXECUTABLE = process.execPath;

function run(env: NodeJS.ProcessEnv = {}): {
  code: number;
  stdout: string;
  stderr: string;
  error: Error | undefined;
} {
  const result = spawnSync(BUN_EXECUTABLE, ["run", CLI_ENTRY, "tui"], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
    // A cold `bun run` of the CLI entry (transpile + module graph load) can exceed
    // a few seconds on a loaded CI runner — notably Windows, where this was the
    // first (cold) spawn in the file. A tight timeout killed the process before any
    // output, surfacing as a confusing `combined.length === 0` failure. Give it
    // generous headroom; each test runs a single spawn well within the suite timeout.
    timeout: 30_000,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

describe("nimbus tui fallback behavior", () => {
  test("TERM=dumb prints fallback notice and does not attempt Ink render", () => {
    const { stdout, stderr, error } = run({ TERM: "dumb" });
    // Surface a spawn timeout/error explicitly rather than as an opaque empty-output assertion.
    expect(error).toBeUndefined();
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
