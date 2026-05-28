import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const cliEntry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

async function spawnCli(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", cliEntry, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("CLI banner suppression (BUG-001)", () => {
  test("non-TTY stdout suppresses Clack intro/outro", async () => {
    const { stdout, exitCode } = await spawnCli(["help"]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("Done.");
    const firstLine = stdout.split("\n").find((l) => l.trim().length > 0) ?? "";
    expect(firstLine).not.toMatch(/^\s*[┌T│|]\s+Nimbus\s*$/);
  });

  test("--json arg suppresses banner even when TTY heuristic would otherwise fire", async () => {
    const { stdout, exitCode } = await spawnCli(["help", "--json"]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("Done.");
  });

  test("NIMBUS_QUIET=1 suppresses banner", async () => {
    const { stdout, exitCode } = await spawnCli(["help"], { NIMBUS_QUIET: "1" });
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("Done.");
  });
});
